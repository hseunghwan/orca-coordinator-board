// The board's work items held to Orca's orchestration rules on the fake Orca: a refused launch leaves nothing
// tracked, a lost item is repaired by the next attempt, done means is required, a person's note never swallows a
// worker's done, a repeated report tells the coordinator once, verify sends work back at most twice before a
// person decides, and gone moves work only after the same fresh read that guards the board's other records.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { createFleet } from '../orca'
import { PreferenceStore } from '../paseo/server/preferences'
import type { DispatchInput } from '../paseo/shared/dispatch'
import { contribute } from './board'
import { rpcServer } from './rpc'
import { translator } from '../i18n'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const sol = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' }

function setup() {
  const orca = fakeOrca([
    { id: 'coord', surface: 'terminal', state: 'working', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'acme' },
  ])
  const dir = mkdtempSync(join(tmpdir(), 'board-work-rules-'))
  dirs.push(dir)
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir: dir, sleep: async () => {} })
  const caller = createCli(orca.runner)
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const board = contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir, undefined,
    { t: () => translator('en'), bin: '/plugin/bin', focusedWorkspace: async () => null })
  new PreferenceStore(join(dir, 'scope.json')).change(s => { s.projects = ['acme']; s.coordinator = 'coord'; s.routing = { C: [sol] } })
  const task: DispatchInput = { projectId: 'acme', workspaceId: 'acme::/w/acme', grade: 'C', requestKey: 'request-work-01',
    title: '문서 교정', prompt: '오탈자를 확인해 줘.', expectedRoute: sol }
  const job = { ...task, doneMeans: '테스트 통과' }
  const assign = () => board.command('assign', { job }, 'coord', caller)
  type Item = { phase: string; attempts?: number }
  const item = async () => ((await handlers.get('board.work-items')!({}) as { items: Record<string, Item> }).items['launched-1'])
  const file = () => JSON.parse(readFileSync(join(dir, 'work-items.json'), 'utf8')) as { items: Record<string, { sessionId: string | null; doneMeans: string | null }> }
  const sent = (marker: string) => orca.writes.filter(w => w.some(a => a.includes(marker))).length
  return { orca, fleet, board, caller, handlers, task, job, assign, item, file, sent, dir }
}

test('a refused launch leaves no work item running for it, and the same request starts fresh', async () => {
  const f = setup()
  f.orca.behavior.launch = 'refuse'
  await expect(f.assign()).rejects.toThrow('거절')
  expect(f.file().items).toEqual({})
  f.orca.behavior.launch = 'start'
  await f.assign()
  expect(await f.item()).toMatchObject({ phase: 'running' })
})

test('a launch whose work item was never written gets it on the next attempt with the same request', async () => {
  const f = setup()
  f.orca.behavior.launch = 'lose-with-id'
  await expect(f.assign()).rejects.toThrow('확인하지 못했습니다')
  // As if the worker stopped between the launch journal and the work item.
  writeFileSync(join(f.dir, 'work-items.json'), JSON.stringify({ version: 1, items: {} }))
  f.orca.behavior.launch = 'start'
  await f.assign()
  expect(f.file().items[f.task.requestKey]).toMatchObject({ sessionId: 'launched-1', doneMeans: '테스트 통과' })
})

test('assign requires what done means', async () => {
  const f = setup()
  await expect(f.board.command('assign', { job: f.task }, 'coord', f.caller)).rejects.toThrow('doneMeans')
  expect(f.orca.launches).toHaveLength(0)
})

test('a person\'s note on the card does not swallow the worker\'s done report', async () => {
  const f = setup()
  await f.assign()
  await f.handlers.get('board.save-note')!({ sessionId: 'launched-1', kind: 'question', text: '사람 메모', expectedRevision: 0 })
  expect((await f.board.command('report', { kind: 'done', text: '끝났습니다.' }, 'launched-1')).text).toContain('work item')
  expect((await f.item()).phase).toBe('reported')
})

test('a repeated done report tells the coordinator once', async () => {
  const f = setup()
  await f.assign()
  f.orca.find('coord')!.state = 'done'
  await f.board.command('report', { kind: 'done', text: '끝났습니다.' }, 'launched-1')
  await f.board.watchWork(await f.fleet.view({ maxAgeMs: 0 }))
  expect(f.sent('작업 완료 보고')).toBe(1)
  await f.board.command('report', { kind: 'done', text: '끝났습니다.' }, 'launched-1')
  await f.board.command('report', { kind: 'done', text: '정말 끝났습니다.' }, 'launched-1')
  await f.board.watchWork(await f.fleet.view({ maxAgeMs: 0 }))
  expect(f.sent('작업 완료 보고')).toBe(1)
  expect((await f.item()).phase).toBe('reported')
})

test('verify sends work back twice; the third failure goes to a person as a decision card, and the person\'s reply hands it back', async () => {
  const f = setup()
  await f.assign()
  const fail = async (n: number) => {
    await f.board.command('report', { kind: 'done', text: '끝났습니다 ' + n }, 'launched-1')
    return JSON.parse((await f.board.command('verify', { itemId: f.task.requestKey, result: 'fail', text: '테스트가 깨집니다 ' + n }, 'coord')).text)
  }
  expect(await fail(1)).toMatchObject({ phase: 'running' })
  expect(await fail(2)).toMatchObject({ phase: 'running' })
  expect(f.sent('완료 확인 반려')).toBe(2)
  expect(await fail(3)).toMatchObject({ phase: 'escalated', attempts: 3, reason: 'escalated-to-person' })
  expect(f.sent('완료 확인 반려')).toBe(2)
  expect(await f.item()).toMatchObject({ phase: 'escalated', attempts: 3 })
  // While a person decides, the session's reports and the coordinator's verify move nothing.
  await f.board.command('report', { kind: 'done', text: '끝났습니다 4' }, 'launched-1')
  expect((await f.item()).phase).toBe('escalated')
  await expect(f.board.command('verify', { itemId: f.task.requestKey, result: 'pass', text: '확인' }, 'coord')).rejects.toThrow('escalated')

  type Row = { id: string; projectId: string; decision?: { source: string; question: string; version: string } }
  const snapshot = await f.handlers.get('board.snapshot')!({ fresh: true }) as { sessions: Row[] }
  const row = snapshot.sessions.find(s => s.id === 'launched-1')!
  expect(row.decision).toMatchObject({ source: 'coordinator', question: expect.stringContaining('테스트가 깨집니다 3') })
  await f.handlers.get('board.send-decision')!({ projectId: row.projectId, sessionId: row.id, recipientId: row.id, version: row.decision!.version,
    action: 'reply', text: '테스트를 고치고 다시 보고해 주세요.', requestKey: 'escalation-reply-0001' })
  const back = await f.item()
  expect(back.phase).toBe('running')
  expect(back.attempts).toBeUndefined()
  expect(f.file().items[f.task.requestKey]).toMatchObject({ attempts: 0 })
})

test('the done check is asked once per phase entry, even when the session answers it without a report', async () => {
  const f = setup()
  await f.assign()
  const checks = () => f.sent('[Coordinator Board · 완료 확인]')
  const turn = async () => {
    f.board.track([['launched-1', 'working']], [])
    f.board.track([['launched-1', 'done']], [{ kind: 'turn-ended', session: 'launched-1' as never }])
    await f.board.watchWork(await f.fleet.view({ maxAgeMs: 0 }))
  }
  await turn()
  expect(checks()).toBe(1)
  // The session answers the check in a turn of its own and does not report: no second check.
  await turn()
  await turn()
  expect(checks()).toBe(1)
  // A new phase entry (the coordinator sent the work back) may be asked once again.
  await f.board.command('report', { kind: 'done', text: '끝났습니다.' }, 'launched-1')
  await f.board.command('verify', { itemId: f.task.requestKey, result: 'fail', text: '다시' }, 'coord')
  await turn()
  await turn()
  expect(checks()).toBe(2)
})

test('gone moves work only after a fresh read confirms it, the same check that guards the board\'s records', async () => {
  const f = setup()
  await f.assign()
  expect(f.board.track([], [{ kind: 'gone', session: 'launched-1' as never }])).toBe(false)
  await f.board.signal({ kind: 'gone', session: 'launched-1' as never })
  expect((await f.item()).phase).toBe('running')
  f.orca.sessions.splice(f.orca.sessions.findIndex(s => s.id === 'launched-1'), 1)
  f.fleet.invalidate()
  await f.board.signal({ kind: 'gone', session: 'launched-1' as never })
  expect((await f.item()).phase).toBe('stale')
})
