// Runs the worker over a mock Orca host and a fake GitHub, so no git or gh process starts.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { activateWith, type GithubDeps } from './worker'

const github: GithubDeps = {
  originOf: async () => 'acme/app',
  openPulls: async () => ({ status: 'ok', items: [] }),
  now: () => 5000
}
const worker = { default: (orca: Parameters<typeof activateWith>[0]) => activateWith(orca, github) }

const agents = (state: string, stateStartedAt = 100) => ({
  agents: [{ terminalId: 't1', title: 'fix login', agent: 'claude', state, stateStartedAt, sessionId: null, task: null }]
})

function host(state = 'waiting') {
  return mockHost({
    storage: { selectedProjects: ['p1'] },
    results: {
      'project.list': { projects: [{ id: 'p1', name: 'App', kind: 'git', hostId: 'local', path: '/w/app' }], truncated: false },
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'feat-login', projectId: 'p1', path: '/w/app-login', branch: 'feat/login', hostId: 'local',
          status: { state: 'active', unread: false, terminalCount: 1, lastActivityAt: 1 } }],
        truncated: false
      },
      'agents.list': agents(state),
      'terminal.read': { lines: ['Which branch should I use?', ''], truncated: false },
      'terminal.sendText': { accepted: true },
      'terminal.focus': { focused: true }
    }
  })
}

const reply = { workspaceId: 'w1', terminalId: 't1', text: 'main 브랜치\n로 가세요', expectedSince: 100, projectName: 'App', workspaceName: 'feat-login', title: 'fix login' }

test('reads a board with a reply card and its recent output', async () => {
  const mounted = await mountWorker(worker, { host: host() })
  const board = await mounted.request('board.read', {})
  assert.deepEqual(board.selected, ['p1'])
  assert.equal(board.decisions.length, 1)
  assert.equal(board.decisions[0].kind, 'reply')
  assert.deepEqual(board.decisions[0].tail, ['Which branch should I use?'])
  assert.equal(board.projects[0].repo, 'acme/app')
  assert.deepEqual(mounted.refusals, [])
  await mounted.deactivate()
})

test('types the person\'s reply as written and records it', async () => {
  const h = host()
  const mounted = await mountWorker(worker, { host: h })
  const result = await mounted.request('board.reply', reply)
  assert.equal(result.status, 'sent')
  assert.deepEqual(h.callsOf('terminal.sendText'), [{ terminalId: 't1', text: 'main 브랜치\n로 가세요', enter: true }])
  assert.equal((h.data().storage.replies as unknown[]).length, 1)
  assert.deepEqual(mounted.posts.map((p) => p.event), ['board.changed'])
  await mounted.deactivate()
})

test('never types into a session waiting for permission', async () => {
  const h = host('blocked')
  const mounted = await mountWorker(worker, { host: h })
  assert.equal((await mounted.request('board.reply', reply)).status, 'permission')
  assert.equal(h.callsOf('terminal.sendText').length, 0)
  await mounted.deactivate()
})

test('refuses a reply to a question the session has moved past', async () => {
  const h = host()
  h.respond('agents.list', agents('waiting', 999))
  const mounted = await mountWorker(worker, { host: h })
  assert.equal((await mounted.request('board.reply', reply)).status, 'changed')
  assert.equal(h.callsOf('terminal.sendText').length, 0)
  await mounted.deactivate()
})

test('keeps only projects Orca knows when saving a selection', async () => {
  const h = host()
  const mounted = await mountWorker(worker, { host: h })
  assert.deepEqual(await mounted.request('board.select-projects', { projectIds: ['p1', 'nope', 'p1'] }), { selected: ['p1'] })
  assert.deepEqual(h.data().storage.selectedProjects, ['p1'])
  await mounted.deactivate()
})


test('asks workspaces whose terminal count is 0: Orca still lists their agents', async () => {
  const h = host()
  h.respond('workspace.list', {
    workspaces: [{ id: 'w1', kind: 'worktree', name: 'feat-login', projectId: 'p1', path: '/w/app-login', branch: 'feat/login', hostId: 'local',
      status: { state: 'inactive', unread: false, terminalCount: 0, lastActivityAt: null } }],
    truncated: false
  })
  const mounted = await mountWorker(worker, { host: h })
  const board = await mounted.request('board.read', {})
  assert.equal(board.projects[0].sessions.length, 1)
  assert.deepEqual(h.callsOf('agents.list'), [{ workspaceId: 'w1' }])
  await mounted.deactivate()
})
