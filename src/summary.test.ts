import { assert } from 'orca/testing'
import { test } from 'vitest'
import { translator } from './i18n'
import { buildBoard, type RawAgent } from './model'
import { ago, laneGroups, statusItem, waitingCounts, withExcludeLine, focusedWorkspace } from './summary'

const en = translator('en')
const ko = translator('ko')
const agent = (terminalId: string, state: RawAgent['state'], stateStartedAt: number): RawAgent =>
  ({ terminalId, title: terminalId, agent: 'claude', state, stateStartedAt })

function board(agents: RawAgent[], selected = ['p1']) {
  return buildBoard({
    projects: [{ id: 'p1', name: 'App', hostId: 'local', path: '/w/app' }],
    selected,
    workspaces: [{ id: 'w1', name: 'main', projectId: 'p1', branch: 'main' }],
    agents: new Map([['w1', agents]]),
    pulls: new Map(),
    dismissed: new Set(),
    replies: [],
    now: 1000,
    truncated: false
  })
}

test('counts permission and reply waits; working sessions are counted apart', () => {
  const view = board([agent('a', 'blocked', 1), agent('b', 'waiting', 2), agent('c', 'working', 3), agent('d', 'done', 4)])
  assert.deepEqual(waitingCounts(view), { permission: 1, reply: 1, review: 0, working: 1 })
})

test('the status bar shows the decision count, a quiet board, no projects chosen, and a failed read', () => {
  assert.deepEqual([statusItem(en, 2).text, statusItem(en, 2).tone], ['2 to decide', 'accent'])
  assert.equal(statusItem(ko, 2).text, '내 결정 2')
  assert.deepEqual([statusItem(en, 0).text, statusItem(en, 0).tone], ['Nothing to decide', 'neutral'])
  assert.equal(statusItem(en, null).text, 'Board')
  assert.equal(statusItem(en, null, true).tone, 'warning')
})

test('a project card lists sessions that need someone first and keeps finished ones apart', () => {
  const [lane] = board([agent('w', 'working', 50), agent('d', 'done', 90), agent('b', 'blocked', 10), agent('r', 'waiting', 20)]).projects
  const groups = laneGroups(lane)
  assert.deepEqual(groups.active.map((s) => s.terminalId), ['b', 'r', 'w'])
  assert.deepEqual(groups.done.map((s) => s.terminalId), ['d'])
  assert.deepEqual(groups.counts, { blocked: 1, waiting: 1, working: 1, done: 1 })
})

test('adds the dashboard folder to the exclude file once', () => {
  const added = withExcludeLine('# git ls-files --others\n*.log')
  assert.equal(added, '# git ls-files --others\n*.log\n# Coordinator Board (Orca plugin): the dashboard key file\n/.coordinator-board/\n')
  assert.equal(withExcludeLine(added!), null)
  assert.equal(withExcludeLine('.coordinator-board/\r\n'), null)
  assert.equal(withExcludeLine(''), '# Coordinator Board (Orca plugin): the dashboard key file\n/.coordinator-board/\n')
})

test('says how long ago in both languages', () => {
  assert.equal(ago(en, 100_000, 90_000), 'just now')
  assert.equal(ago(ko, 10 * 60_000, 0), '10분 전')
  assert.equal(ago(en, 3 * 3_600_000, 0), '3h ago')
  assert.equal(ago(ko, 2 * 86_400_000, 0), '2일 전')
})

test('finds the focused workspace by id, by the path in a project::path id, or by a unique name', () => {
  const rows = [
    { id: 'identity:wt2:local:a', name: 'main', path: 'C:/repo', branch: 'main' },
    { id: 'identity:wt2:local:b', name: 'feat-x', path: 'C:/ws/repo/feat-x', branch: 'feat/x' },
    { id: 'folder:c', name: 'notes', path: 'C:\\notes', branch: null }
  ]
  assert.equal(focusedWorkspace({ workspaceId: 'folder:c', branch: '', displayName: 'notes' }, rows)?.id, 'folder:c')
  assert.equal(focusedWorkspace({ workspaceId: 'p1::C:\\ws\\repo\\feat-x\\', branch: 'feat/x', displayName: 'feat-x' }, rows)?.id, 'identity:wt2:local:b')
  assert.equal(focusedWorkspace({ branch: 'main', displayName: 'main' }, rows)?.id, 'identity:wt2:local:a')
  assert.equal(focusedWorkspace({ workspaceId: 'other', branch: 'dev', displayName: 'main' }, rows), undefined)
  assert.equal(focusedWorkspace(null, rows), undefined)
})
