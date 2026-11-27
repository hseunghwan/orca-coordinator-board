import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { reduceWorkItem, WorkItemStore, type WorkItem } from './work-items'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const item = (extra: Partial<WorkItem> = {}): WorkItem => ({
  itemId: 'request-0001', sessionId: 's1', projectId: 'acme', workspaceId: 'acme::/w/acme', title: '문서 교정', doneMeans: '테스트 통과',
  origin: 'dispatch', phase: 'running', phaseAt: 1, createdAt: 1, history: [{ phase: 'running', at: 1, by: 'coordinator' }], ...extra,
})

test('Orca state only mirrors running and awaiting-input', () => {
  const waiting = reduceWorkItem(item(), { kind: 'state', state: 'waiting', at: 2 })
  expect(waiting).toMatchObject({ phase: 'awaiting-input', phaseAt: 2 })
  expect(waiting.history.at(-1)).toEqual({ phase: 'awaiting-input', at: 2, by: 'board' })
  expect(reduceWorkItem(waiting, { kind: 'state', state: 'working', at: 3 }).phase).toBe('running')
  // done is a turn's end, not the work's: nothing changes, and the same object comes back so a poll writes nothing.
  const running = item()
  expect(reduceWorkItem(running, { kind: 'state', state: 'done', at: 2 })).toBe(running)
  expect(reduceWorkItem(running, { kind: 'state', state: 'working', at: 2 })).toBe(running)
  const reported = item({ phase: 'reported' })
  expect(reduceWorkItem(reported, { kind: 'state', state: 'blocked', at: 2 })).toBe(reported)
})

test('a turn that ends without a report leaves a done candidate, which new work clears', () => {
  const candidate = reduceWorkItem(item(), { kind: 'turn-ended', at: 5 })
  expect(candidate).toMatchObject({ phase: 'running', phaseAt: 1, candidate: { reason: 'turn-ended', at: 5 } })
  expect(reduceWorkItem(candidate, { kind: 'turn-ended', at: 6 })).toBe(candidate)
  expect(reduceWorkItem(candidate, { kind: 'state', state: 'working', at: 7 }).candidate).toBeUndefined()
  expect(reduceWorkItem(item({ phase: 'awaiting-input' }), { kind: 'turn-ended', at: 5 }).candidate).toBeUndefined()
})

test('the session report goes as far as reported; only a person confirms done', () => {
  const candidate = reduceWorkItem(item(), { kind: 'turn-ended', at: 5 })
  const reported = reduceWorkItem(candidate, { kind: 'report', report: 'done', text: 'PR #12', at: 6 })
  expect(reported).toMatchObject({ phase: 'reported', report: { text: 'PR #12', at: 6 } })
  expect(reported.candidate).toBeUndefined()
  expect(reported.history.at(-1)).toEqual({ phase: 'reported', at: 6, by: 'session' })
  expect(reduceWorkItem(item(), { kind: 'report', report: 'question', text: '어느 쪽?', at: 6 }).phase).toBe('awaiting-input')
  expect(reduceWorkItem(item(), { kind: 'report', report: 'review', text: '봐 주세요', at: 6 }).phase).toBe('running')
  const done = reduceWorkItem(reported, { kind: 'confirmed', at: 7 })
  expect(done).toMatchObject({ phase: 'done', phaseAt: 7 })
  for (const event of [{ kind: 'state', state: 'working', at: 8 }, { kind: 'turn-ended', at: 8 }, { kind: 'report', report: 'question', text: 'x', at: 8 }] as const) {
    expect(reduceWorkItem(done, event)).toBe(done)
  }
})

test('the store creates an item once, links its session once, and writes only when an event changes something', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-work-'))
  dirs.push(dir)
  const path = join(dir, 'work-items.json')
  const store = new WorkItemStore(path)
  expect(store.apply([['s1', { kind: 'turn-ended', at: 1 }]])).toBe(false)
  store.create({ itemId: 'request-0001', projectId: 'acme', workspaceId: 'acme::/w/acme', title: '문서 교정', doneMeans: null }, 10)
  expect(store.create({ itemId: 'request-0001', projectId: 'acme', workspaceId: 'other', title: '다른 일', doneMeans: 'x' }, 11).title).toBe('문서 교정')
  expect(store.bySession().size).toBe(0)
  expect(store.link([['request-0001', 's1'], ['missing', 's2']])).toBe(true)
  expect(store.link([['request-0001', 's9']])).toBe(false)
  const written = readFileSync(path, 'utf8')
  expect(store.apply([['s1', { kind: 'state', state: 'done', at: 12 }], ['s2', { kind: 'turn-ended', at: 12 }]])).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(written)
  expect(store.apply([['s1', { kind: 'turn-ended', at: 13 }]])).toBe(true)
  expect(store.bySession().get('s1')).toMatchObject({ itemId: 'request-0001', candidate: { at: 13 } })
})
