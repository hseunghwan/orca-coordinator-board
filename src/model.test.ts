import { assert, test } from 'orca/testing'
import { buildBoard, cleanTail, closedSessions, replyGuard, resumeGuard, CLOSED_MAX_AGE, type RawAgent, type RawHistorySession } from './model'

const agent = (over: Partial<RawAgent>): RawAgent => ({ terminalId: 't1', title: 'fix login', agent: 'claude', state: 'waiting', stateStartedAt: 100, ...over })
const pull = (number: number, reason: 'ready' | 'draft', updatedAt = '2026-11-20T00:00:00Z') =>
  ({ repo: 'acme/app', number, title: 'PR ' + number, url: 'https://github.com/acme/app/pull/' + number, reason, updatedAt })

function board(agents: RawAgent[], dismissed: string[] = []) {
  return buildBoard({
    projects: [{ id: 'p1', name: 'App', hostId: 'local', path: '/w/app' }, { id: 'p2', name: 'Other', hostId: 'local', path: '/w/o' }],
    selected: ['p1'],
    workspaces: [{ id: 'w1', name: 'feat-login', projectId: 'p1', branch: 'feat/login', status: { terminalCount: 2 } }],
    agents: new Map([['w1', agents]]),
    pulls: new Map([['p1', { repo: 'acme/app', status: 'ok' as const, items: [pull(7, 'ready'), pull(8, 'draft')] }]]),
    dismissed: new Set(dismissed),
    replies: [],
    now: 1000,
    truncated: false
  })
}

test('orders permission first, then replies oldest first, then reviews; done stays out', () => {
  const view = board([
    agent({ terminalId: 't1', state: 'waiting', stateStartedAt: 300 }),
    agent({ terminalId: 't2', state: 'done', stateStartedAt: 200 }),
    agent({ terminalId: 't3', state: 'blocked', stateStartedAt: 900 }),
    agent({ terminalId: 't4', state: 'working', stateStartedAt: 50 })
  ])
  assert.deepEqual(view.decisions.map((d) => [d.kind, d.session?.terminalId ?? d.pull?.number]), [
    ['permission', 't3'], ['reply', 't1'], ['review', 7]
  ])
  assert.deepEqual(view.selected, ['p1'])
  assert.equal(view.projects[0].sessions.length, 4)
})

test('a dismissed reply card returns when the session changes state', () => {
  assert.equal(board([agent({ stateStartedAt: 100 })], ['t1@100']).decisions.filter((d) => d.kind === 'reply').length, 0)
  assert.equal(board([agent({ stateStartedAt: 400 })], ['t1@100']).decisions.filter((d) => d.kind === 'reply').length, 1)
})

test('a chat tab waiting for an answer gets a card with no terminal to type into', () => {
  const view = board([agent({ terminalId: null, title: 'chat', state: 'waiting', stateStartedAt: 300 })])
  const reply = view.decisions.find((d) => d.kind === 'reply')
  assert.ok(reply)
  assert.equal(reply.session?.terminalId, null)
  assert.equal(reply.session?.workspaceId, 'w1')
})

test('a permission card cannot be dismissed', () => {
  assert.equal(board([agent({ state: 'blocked' })], ['t1@100']).decisions[0].kind, 'permission')
})

test('refuses to type into a session that cannot take input', () => {
  assert.equal(replyGuard(agent({}), '  ', 100), 'empty')
  assert.equal(replyGuard(agent({}), 'x'.repeat(8001), 100), 'too-long')
  assert.equal(replyGuard(undefined, 'yes', 100), 'gone')
  assert.equal(replyGuard(agent({ state: 'blocked' }), 'yes', 100), 'permission')
  assert.equal(replyGuard(agent({ state: 'working' }), 'yes', 100), 'busy')
  assert.equal(replyGuard(agent({ stateStartedAt: 101 }), 'yes', 100), 'changed')
  assert.equal(replyGuard(agent({ state: 'done' }), 'yes', 100), null)
})

test('strips escape sequences, controls and bidi overrides from terminal output', () => {
  assert.deepEqual(cleanTail(['\u001b[31mred\u001b[0m', 'a\u202eb\u0007', '', '  ']), ['red', 'a b'])
})


const past = (sessionId: string, over: Partial<RawHistorySession> = {}): RawHistorySession =>
  ({ sessionId, agent: 'claude', title: 'task ' + sessionId, workspaceId: 'w1', updatedAt: 900, running: false, ...over })
const ws = [{ id: 'w1', name: 'feat-login', projectId: 'p1', branch: 'feat/login' }, { id: 'w2', name: 'chat', projectId: 'p1', branch: null }]

test('lists closed sessions newest first, leaving out open ones and anything a session could still run in', () => {
  const closed = closedSessions({
    history: [
      past('a', { updatedAt: 500 }),
      past('b', { updatedAt: 800 }),
      past('live'),
      past('run', { running: true }),
      past('old', { updatedAt: 1000 - CLOSED_MAX_AGE - 1 }),
      past('x', { agent: 'notepad' }),
      past('elsewhere', { workspaceId: 'w9' }),
      past('chat', { workspaceId: 'w2' }),
      past('c', { updatedAt: 700 }),
      past('d', { updatedAt: 600 })
    ],
    workspaces: ws,
    // w2 has a pane whose session id Orca does not give: it could be any of w2's sessions.
    agents: new Map([['w1', [agent({ sessionId: 'live' })]], ['w2', [agent({ terminalId: null, sessionId: null })]]]),
    now: 1000
  })
  assert.deepEqual(closed.map((s) => s.sessionId), ['b', 'c', 'd'])
  assert.equal(closed[0].key, 'closed:b')
  assert.equal(closed[0].workspaceName, 'feat-login')
})

test('a workspace whose agents could not be read shows no closed sessions', () => {
  assert.deepEqual(closedSessions({ history: [past('a')], workspaces: ws, agents: new Map(), now: 1000 }), [])
})

test('refuses to resume a session that is open again, gone or unnamed', () => {
  const base = { text: 'go on', sessionId: 'a', agent: 'claude', row: past('a'), live: [agent({ sessionId: 'other' })] }
  assert.equal(resumeGuard(base), null)
  assert.equal(resumeGuard({ ...base, text: ' ' }), 'empty')
  assert.equal(resumeGuard({ ...base, row: undefined }), 'gone')
  assert.equal(resumeGuard({ ...base, agent: 'codex' }), 'gone')
  assert.equal(resumeGuard({ ...base, row: past('a', { running: true }) }), 'open')
  assert.equal(resumeGuard({ ...base, live: [agent({ sessionId: 'a' })] }), 'open')
  assert.equal(resumeGuard({ ...base, live: [agent({ terminalId: null, sessionId: null })] }), 'open')
  assert.equal(resumeGuard({ ...base, live: undefined }), 'open')
})
