import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { Delivery, DeliveryOutcome } from '../orca'
import { DEFAULT_WORK_SETTINGS, pullIn, reduceWorkItem, WorkItemStore, type WorkItem } from './work-items'
import { doneCheckText, noticeText, WorkNotices } from './work-notices'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const MIN = 60_000
const item = (extra: Partial<WorkItem> = {}): WorkItem => ({
  itemId: 'request-0001', sessionId: 's1', projectId: 'acme', workspaceId: 'acme::/w/acme', title: '문서 교정', doneMeans: '테스트 통과',
  origin: 'dispatch', phase: 'running', phaseAt: 0, createdAt: 0, history: [{ phase: 'running', at: 0, by: 'coordinator' }], ...extra,
})

test('verify confirms a reported item through verifying, or sends it back to running; nothing else can be verified', () => {
  const reported = item({ phase: 'reported', report: { text: '끝', at: 1 } })
  const done = reduceWorkItem(reported, { kind: 'verify', result: 'pass', at: 2 })
  expect(done.phase).toBe('done')
  expect(done.history.slice(-2).map(h => [h.phase, h.by])).toEqual([['verifying', 'coordinator'], ['done', 'coordinator']])
  expect(reduceWorkItem(item({ phase: 'verifying' }), { kind: 'verify', result: 'pass', at: 2 }).phase).toBe('done')
  expect(reduceWorkItem(reported, { kind: 'verify', result: 'fail', at: 2 }).phase).toBe('running')
  const running = item()
  expect(reduceWorkItem(running, { kind: 'verify', result: 'pass', at: 2 })).toBe(running)
})

test('the stale clock: idle past the limit, or no answer to a sent done check, and only while the work is open', () => {
  const settings = { idleMinutes: 60, askMinutes: 30 }
  const running = item({ phaseAt: 0 })
  expect(reduceWorkItem(running, { kind: 'tick', at: 61 * MIN, idleSince: null, settings })).toBe(running)
  expect(reduceWorkItem(running, { kind: 'tick', at: 61 * MIN, idleSince: 30 * MIN, settings })).toBe(running)
  expect(reduceWorkItem(running, { kind: 'tick', at: 61 * MIN, idleSince: 0, settings })).toMatchObject({ phase: 'stale', staleReason: 'idle' })
  const asked = item({ candidate: { reason: 'turn-ended', at: 0, ask: { messageId: 'm', status: 'sent', at: 0 } } })
  expect(reduceWorkItem(asked, { kind: 'tick', at: 31 * MIN, idleSince: 31 * MIN, settings })).toMatchObject({ phase: 'stale', staleReason: 'no-answer' })
  const queued = item({ candidate: { reason: 'turn-ended', at: 0, ask: { messageId: 'm', status: 'queued', at: 0 } } })
  expect(reduceWorkItem(queued, { kind: 'tick', at: 31 * MIN, idleSince: 31 * MIN, settings })).toBe(queued)
  const reported = item({ phase: 'reported' })
  expect(reduceWorkItem(reported, { kind: 'tick', at: 999 * MIN, idleSince: 0, settings })).toBe(reported)
})

test('gone makes open work stale but keeps a reported one; a report, new work or a person opening it brings stale work back', () => {
  const stale = reduceWorkItem(item(), { kind: 'gone', at: 5 })
  expect(stale).toMatchObject({ phase: 'stale', staleReason: 'gone' })
  const reported = item({ phase: 'reported' })
  expect(reduceWorkItem(reported, { kind: 'gone', at: 5 })).toBe(reported)
  expect(reduceWorkItem(stale, { kind: 'reopened', at: 6 })).toMatchObject({ phase: 'running', history: expect.arrayContaining([{ phase: 'running', at: 6, by: 'person' }]) })
  expect(reduceWorkItem(stale, { kind: 'reopened', at: 6 }).staleReason).toBeUndefined()
  expect(reduceWorkItem(stale, { kind: 'state', state: 'working', at: 6 }).phase).toBe('running')
  expect(reduceWorkItem(stale, { kind: 'report', report: 'review', text: '봐 주세요', at: 6 }).phase).toBe('running')
  expect(reduceWorkItem(stale, { kind: 'report', report: 'question', text: '어느 쪽?', at: 6 }).phase).toBe('awaiting-input')
  expect(reduceWorkItem(stale, { kind: 'report', report: 'done', text: '끝', at: 6 }).phase).toBe('reported')
  const running = item()
  expect(reduceWorkItem(running, { kind: 'reopened', at: 6 })).toBe(running)
})

test('a pull request in a report links the item; MERGED makes a candidate or moves reported to verifying, CLOSED a candidate', () => {
  expect(pullIn('PR https://github.com/acme/app/pull/42 올렸습니다')).toEqual({ repo: 'acme/app', number: 42 })
  expect(pullIn('no link')).toBeUndefined()
  const reported = reduceWorkItem(item(), { kind: 'report', report: 'done', text: 'https://github.com/acme/app/pull/42', at: 1 })
  expect(reported).toMatchObject({ phase: 'reported', pull: { repo: 'acme/app', number: 42 } })
  const verifying = reduceWorkItem(reported, { kind: 'pull', state: 'MERGED', at: 2 })
  expect(verifying).toMatchObject({ phase: 'verifying', pull: { state: 'MERGED' } })
  // The same state seen again changes nothing.
  expect(reduceWorkItem(verifying, { kind: 'pull', state: 'MERGED', at: 3 })).toBe(verifying)
  const running = item({ pull: { repo: 'acme/app', number: 42, state: 'OPEN' } })
  expect(reduceWorkItem(running, { kind: 'pull', state: 'MERGED', at: 2 })).toMatchObject({ phase: 'running', candidate: { reason: 'pr-merged', at: 2 } })
  expect(reduceWorkItem(running, { kind: 'pull', state: 'CLOSED', at: 2 })).toMatchObject({ phase: 'running', candidate: { reason: 'pr-closed' } })
  expect(reduceWorkItem(reported, { kind: 'pull', state: 'CLOSED', at: 2 })).toMatchObject({ phase: 'running', candidate: { reason: 'pr-closed' } })
  const unlinked = item()
  expect(reduceWorkItem(unlinked, { kind: 'pull', state: 'MERGED', at: 2 })).toBe(unlinked)
})

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'board-notices-'))
  dirs.push(dir)
  const store = new WorkItemStore(join(dir, 'work-items.json'))
  const sent: Delivery[] = []
  let answer: (d: Delivery) => DeliveryOutcome = () => ({ status: 'delivered', route: 'terminal-input', proof: 'cli' })
  let coordinator: string | null = 'coord'
  const notices = new WorkNotices(store, { deliver: async (d) => { sent.push(d); return answer(d) } }, () => coordinator)
  store.create({ itemId: 'request-0001', projectId: 'acme', workspaceId: 'acme::/w/acme', title: '문서 교정', doneMeans: '테스트 통과' }, 1)
  store.link([['request-0001', 's1']])
  return { store, sent, notices, answer: (f: typeof answer) => { answer = f }, coordinator: (id: string | null) => { coordinator = id } }
}

test('a done candidate gets one done check from the board; a busy session keeps it queued until it can take it', async () => {
  const f = setup()
  expect(await f.notices.run()).toBe(false)
  f.store.apply([['s1', { kind: 'turn-ended', at: 5 }]])
  f.answer(() => ({ status: 'refused', reason: 'working' }))
  expect(await f.notices.run()).toBe(true)
  expect(f.store.item('request-0001')?.candidate?.ask?.status).toBe('queued')
  f.answer(() => ({ status: 'delivered', route: 'terminal-input', proof: 'cli' }))
  await f.notices.run()
  expect(f.store.item('request-0001')?.candidate?.ask?.status).toBe('sent')
  await f.notices.run()
  expect(f.sent).toHaveLength(2)
  expect(f.sent[0].messageId).toBe(f.sent[1].messageId)
  expect(f.sent[1]).toMatchObject({ to: 's1', from: { kind: 'board' }, whenWorking: 'refuse' })
  expect(f.sent[1].text).toContain('"type":"coordinator-board.done-check","itemId":"request-0001","doneMeans":"테스트 통과"')
})

test('a move to reported or stale tells the coordinator once per phase, never the session about itself', async () => {
  const f = setup()
  f.store.apply([['s1', { kind: 'report', report: 'done', text: 'https://github.com/acme/app/pull/7', at: 10 }]])
  await f.notices.run()
  await f.notices.run()
  expect(f.sent.map(d => d.to)).toEqual(['coord'])
  expect(f.sent[0].text).toContain('"phase":"reported"')
  expect(f.sent[0].text).toContain('verify --item request-0001')
  f.store.apply([['s1', { kind: 'gone', at: 11 }]])
  // Reported work is not open, so gone leaves it; a person sending it back opens it, then gone makes it stale.
  f.store.applyToItems([['request-0001', { kind: 'verify', result: 'fail', at: 12 }]])
  f.store.apply([['s1', { kind: 'gone', at: 13 }]])
  f.coordinator(null)
  await f.notices.run()
  expect(f.sent).toHaveLength(1)
  f.coordinator('coord')
  await f.notices.run()
  expect(f.sent).toHaveLength(2)
  expect(f.sent[1].text).toContain('"staleReason":"gone"')
  expect(f.store.item('request-0001')?.notice).toMatchObject({ key: 'stale@13', status: 'sent' })
})

test('the messages say what they are and grant nothing', () => {
  const reported = item({ phase: 'reported', report: { text: '끝', at: 1 } })
  expect(doneCheckText(item())).toMatch(/^\[Coordinator Board · 완료 확인\]\n/)
  expect(doneCheckText(item())).toContain('새 지시나 승인이 아닙니다')
  expect(noticeText(reported)).toContain('"report":"끝"')
  expect(noticeText(item({ phase: 'stale', staleReason: 'idle' }))).toContain('작업 방치')
  expect(DEFAULT_WORK_SETTINGS).toEqual({ idleMinutes: 60, askMinutes: 30 })
})
