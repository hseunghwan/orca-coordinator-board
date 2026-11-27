import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { escalationQuestion, MAX_FIX_ATTEMPTS, reduceWorkItem, WorkItemStore, type WorkEvent, type WorkItem } from './work-items'

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
  expect(store.apply([['s1', { kind: 'turn-ended', at: 1 }]]).changed).toBe(false)
  store.create({ itemId: 'request-0001', projectId: 'acme', workspaceId: 'acme::/w/acme', title: '문서 교정', doneMeans: null }, 10)
  expect(store.create({ itemId: 'request-0001', projectId: 'acme', workspaceId: 'other', title: '다른 일', doneMeans: 'x' }, 11).title).toBe('문서 교정')
  expect(store.bySession().size).toBe(0)
  expect(store.link([['request-0001', 's1'], ['missing', 's2']])).toBe(true)
  expect(store.link([['request-0001', 's9']])).toBe(false)
  const written = readFileSync(path, 'utf8')
  expect(store.apply([['s1', { kind: 'state', state: 'done', at: 12 }], ['s2', { kind: 'turn-ended', at: 12 }]]).changed).toBe(false)
  expect(readFileSync(path, 'utf8')).toBe(written)
  expect(store.apply([['s1', { kind: 'turn-ended', at: 13 }]])).toEqual({ changed: true, moved: [] })
  expect(store.bySession().get('s1')).toMatchObject({ itemId: 'request-0001', candidate: { at: 13 } })
})

const settings = { idleMinutes: 60, askMinutes: 30 }
const HOUR = 60 * 60_000

/** Every phase, with the extras the reducer reads, and every kind of event: the invariants hold across the whole table. */
const PHASES: WorkItem[] = [
  item(), item({ candidate: { reason: 'turn-ended', at: 2, ask: { messageId: 'm', status: 'sent', at: 3 } } }),
  item({ phase: 'awaiting-input' }), item({ phase: 'reported', report: { text: 'r', at: 2 } }), item({ phase: 'verifying', report: { text: 'r', at: 2 } }),
  item({ phase: 'done' }), item({ phase: 'stale', staleReason: 'idle' }), item({ phase: 'escalated', attempts: 3 }),
  item({ pull: { repo: 'acme/app', number: 3, state: 'OPEN' } }),
]
const EVENTS: WorkEvent[] = [
  { kind: 'state', state: 'working', at: 9 }, { kind: 'state', state: 'waiting', at: 9 }, { kind: 'state', state: 'blocked', at: 9 }, { kind: 'state', state: 'done', at: 9 },
  { kind: 'turn-ended', at: 9 }, { kind: 'report', report: 'done', text: 'r', at: 9 }, { kind: 'report', report: 'question', text: 'q', at: 9 },
  { kind: 'report', report: 'review', text: 'v', at: 9 }, { kind: 'confirmed', at: 9 }, { kind: 'verify', result: 'pass', at: 9 },
  { kind: 'verify', result: 'fail', text: 'x', at: 9 }, { kind: 'person-reply', at: 9 }, { kind: 'reopened', at: 9 }, { kind: 'gone', at: 9 },
  { kind: 'tick', at: 9 + 3 * HOUR, state: 'done', idleSince: 9, settings }, { kind: 'tick', at: 9 + 3 * HOUR, state: 'waiting', idleSince: 9, settings },
  { kind: 'pull', state: 'MERGED', at: 9 }, { kind: 'pull', state: 'CLOSED', at: 9 },
  { kind: 'asked', candidate: { reason: 'turn-ended', at: 2 }, messageId: 'm2', status: 'sent', at: 9 },
  { kind: 'noticed', key: 'k', messageId: 'n', status: 'sent' },
]
/** Who may move work into each phase: Orca's orchestration gives done to the coordinator's check or a person only. */
const MAY_ENTER: Record<WorkItem['phase'], readonly string[]> = {
  running: ['board', 'session', 'coordinator', 'person'], 'awaiting-input': ['board', 'session'], reported: ['session'],
  verifying: ['board', 'coordinator'], done: ['coordinator', 'person'], stale: ['board'], escalated: ['coordinator'],
}

test('reducer invariants: a repeated event changes nothing, done absorbs, and each phase is entered only by whom it belongs to', () => {
  for (const before of PHASES) for (const event of EVENTS) {
    const after = reduceWorkItem(before, event)
    const label = before.phase + ' + ' + event.kind
    // Idempotent: the same event again returns the very same object, so a redelivery or a second poll writes and tells nothing.
    expect(reduceWorkItem(after, event), label).toBe(after)
    if (before.phase === 'done' && event.kind !== 'noticed') expect(after, label).toBe(before)
    if (after.phase !== before.phase) {
      expect(after.phaseAt, label).toBe(9 + (event.kind === 'tick' ? 3 * HOUR : 0))
      expect(MAY_ENTER[after.phase], label).toContain(after.history.at(-1)!.by)
      expect(after.history.at(-1)!.phase, label).toBe(after.phase)
    }
    expect(after.history.length, label).toBeLessThanOrEqual(20)
  }
})

test('waiting for input is never stale by time; running work is, and so is unanswered done check', () => {
  const tick = (state: 'done' | 'waiting' | 'blocked') => ({ kind: 'tick', at: 3 * HOUR, state, idleSince: 1, settings }) as const
  const waiting = item({ phase: 'awaiting-input' })
  expect(reduceWorkItem(waiting, tick('waiting'))).toBe(waiting)
  expect(reduceWorkItem(waiting, tick('blocked'))).toBe(waiting)
  expect(reduceWorkItem(item({ candidate: { reason: 'turn-ended', at: 1 } }), tick('done'))).toMatchObject({ phase: 'stale', staleReason: 'idle' })
  expect(reduceWorkItem(item({ candidate: { reason: 'turn-ended', at: 1, ask: { messageId: 'm', status: 'sent', at: 1 } } }), tick('done')))
    .toMatchObject({ phase: 'stale', staleReason: 'no-answer' })
  // Gone still ends waiting work: nothing is left to wake it.
  expect(reduceWorkItem(waiting, { kind: 'gone', at: 5 })).toMatchObject({ phase: 'stale', staleReason: 'gone' })
})

test('a repeated done report keeps its phase and phaseAt, so the coordinator notice key does not change', () => {
  const reported = reduceWorkItem(item(), { kind: 'report', report: 'done', text: 'PR https://github.com/acme/app/pull/7', at: 5 })
  expect(reported).toMatchObject({ phase: 'reported', phaseAt: 5, pull: { repo: 'acme/app', number: 7 } })
  expect(reduceWorkItem(reported, { kind: 'report', report: 'done', text: 'PR https://github.com/acme/app/pull/7', at: 6 })).toBe(reported)
  const refreshed = reduceWorkItem(reported, { kind: 'report', report: 'done', text: '보충: 테스트도 통과', at: 7 })
  expect(refreshed).toMatchObject({ phase: 'reported', phaseAt: 5, report: { text: '보충: 테스트도 통과', at: 7 } })
  expect(refreshed.history).toEqual(reported.history)
  const verifying = item({ phase: 'verifying', phaseAt: 8 })
  expect(reduceWorkItem(verifying, { kind: 'report', report: 'done', text: 'x', at: 9 })).toMatchObject({ phase: 'verifying', phaseAt: 8 })
})

test('verify fail counts attempts: two send the work back, the third escalates to a person, whose reply starts over', () => {
  let current = item({ phase: 'reported' })
  for (const n of [1, 2]) {
    current = reduceWorkItem(current, { kind: 'verify', result: 'fail', text: '사유 ' + n, at: 10 + n })
    expect(current).toMatchObject({ phase: 'running', attempts: n, failure: { text: '사유 ' + n } })
    current = reduceWorkItem(current, { kind: 'report', report: 'done', text: '다시', at: 20 + n })
  }
  expect(MAX_FIX_ATTEMPTS).toBe(2)
  const escalated = reduceWorkItem(current, { kind: 'verify', result: 'fail', text: '사유 3', at: 30 })
  expect(escalated).toMatchObject({ phase: 'escalated', attempts: 3, failure: { text: '사유 3' } })
  expect(escalated.history.at(-1)).toEqual({ phase: 'escalated', at: 30, by: 'coordinator' })
  expect(escalationQuestion(escalated)).toContain('사유 3')
  expect(escalationQuestion(current)).toBeNull()
  for (const event of [{ kind: 'state', state: 'working', at: 31 }, { kind: 'turn-ended', at: 31 }, { kind: 'reopened', at: 31 },
    { kind: 'tick', at: 31 + 3 * HOUR, state: 'done', idleSince: 31, settings }, { kind: 'verify', result: 'pass', at: 31 }] as const) {
    expect(reduceWorkItem(escalated, event)).toBe(escalated)
  }
  const back = reduceWorkItem(escalated, { kind: 'person-reply', at: 40 })
  expect(back).toMatchObject({ phase: 'running', attempts: 0 })
  expect(back.history.at(-1)).toEqual({ phase: 'running', at: 40, by: 'person' })
  expect(reduceWorkItem(escalated, { kind: 'confirmed', at: 41 })).toMatchObject({ phase: 'done' })
})

test('a done check outcome lands only on the candidate it asked about', () => {
  const candidate = item({ candidate: { reason: 'pr-merged', at: 4 } })
  expect(reduceWorkItem(candidate, { kind: 'asked', candidate: { reason: 'turn-ended', at: 2 }, messageId: 'm', status: 'sent', at: 5 })).toBe(candidate)
  expect(reduceWorkItem(candidate, { kind: 'asked', candidate: { reason: 'pr-merged', at: 4 }, messageId: 'm', status: 'sent', at: 5 }).candidate)
    .toEqual({ reason: 'pr-merged', at: 4, ask: { messageId: 'm', status: 'sent', at: 5 } })
})

test('discard drops only a launch\'s item that never got a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-work-'))
  dirs.push(dir)
  const store = new WorkItemStore(join(dir, 'work-items.json'))
  store.create({ itemId: 'a', projectId: 'acme', workspaceId: 'w', title: 't', doneMeans: 'd' }, 1)
  store.create({ itemId: 'b', projectId: 'acme', workspaceId: 'w', title: 't', doneMeans: 'd' }, 2)
  store.link([['b', 's1']])
  expect(store.discard('a')).toBe(true)
  expect(store.discard('b')).toBe(false)
  expect(store.discard('missing')).toBe(false)
  expect(Object.keys(store.read().items)).toEqual(['b'])
})
