// Runs the worker over a mock Orca host and a fake GitHub, so no git or gh process starts.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { activateWith, OPEN_DASHBOARD, type FileDeps, type GithubDeps } from './worker'

const github: GithubDeps = {
  originOf: async () => 'acme/app',
  openPulls: async () => ({ status: 'ok', items: [] }),
  now: () => 5000
}
const opened: string[] = []
const files: FileDeps = { ensureDashboard: async (root) => { opened.push(root) } }
let stop: (() => void) | undefined
const worker = {
  default: (orca: Parameters<typeof activateWith>[0]) => { stop = activateWith(orca, github, { files, pollMs: 0 }) },
  deactivate: () => stop?.()
}

const agents = (state: string, stateStartedAt = 100) => ({
  agents: [{ terminalId: 't1', title: 'fix login', agent: 'claude', state, stateStartedAt, sessionId: null, task: null }]
})

function host(state = 'waiting', shown: string[] = []) {
  // Orca types only into the focused workspace's terminals; focusing one shows its workspace.
  const focusable = new Set(['t1'])
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
      'terminal.focus': ({ terminalId }: { terminalId: string }) => {
        if (!focusable.has(terminalId)) return { focused: false }
        shown.splice(0, shown.length, terminalId)
        return { focused: true }
      },
      'statusBar.update': { ok: true },
      'workspace.readContext': () => ({ workspaceId: 'w1', branch: 'feat/login', displayName: 'feat-login', terminals: shown.map((id) => ({ id })) }),
      'editor.open': { opened: true },
      'workspace.open': { opened: true }
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
  // The session was not in view: it is shown first, then the text goes in.
  const order = h.calls.map((call) => call.method).filter((method) => method === 'terminal.focus' || method === 'terminal.sendText')
  assert.deepEqual(order, ['terminal.focus', 'terminal.sendText'])
  assert.deepEqual(h.callsOf('terminal.sendText'), [{ terminalId: 't1', text: 'main 브랜치\n로 가세요', enter: true }])
  assert.equal((h.data().storage.replies as unknown[]).length, 1)
  assert.deepEqual(mounted.posts.map((p) => p.event), ['board.changed'])
  await mounted.deactivate()
})

test('types straight into a session already in view, without moving the window', async () => {
  const h = host('waiting', ['t1'])
  const mounted = await mountWorker(worker, { host: h })
  assert.equal((await mounted.request('board.reply', reply)).status, 'sent')
  assert.equal(h.callsOf('terminal.focus').length, 0)
  assert.equal(h.callsOf('terminal.sendText').length, 1)
  await mounted.deactivate()
})

test('does not type when Orca cannot show the session', async () => {
  const h = host()
  h.respond('terminal.focus', { focused: false })
  const mounted = await mountWorker(worker, { host: h })
  assert.equal((await mounted.request('board.reply', reply)).status, 'failed')
  assert.equal(h.callsOf('terminal.sendText').length, 0)
  await mounted.deactivate()
})

test('opens a session by its terminal, or a chat tab by its workspace', async () => {
  const h = host()
  const mounted = await mountWorker(worker, { host: h })
  assert.deepEqual(await mounted.request('board.focus', { terminalId: 't1', workspaceId: 'w1' }), { focused: true })
  assert.deepEqual(await mounted.request('board.focus', { terminalId: null, workspaceId: 'w1' }), { focused: true })
  assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 't1' }])
  assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'w1' }])
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

test('shows how many sessions wait in the status bar, in the panel\'s language', async () => {
  const h = host()
  const mounted = await mountWorker(worker, { host: h })
  await mounted.request('board.read', {})
  await mounted.request('board.read', { locale: 'ko-KR' })
  const updates = h.callsOf('statusBar.update') as { id: string; text: string; tone: string }[]
  assert.deepEqual(updates.map((u) => [u.id, u.text, u.tone]), [['waiting', '1 waiting', 'accent'], ['waiting', '기다림 1', 'accent']])
  assert.equal(h.data().storage.locale, 'ko-KR')
  await mounted.deactivate()
})

test('a session waiting for permission turns the status bar warning', async () => {
  const h = host('blocked')
  const mounted = await mountWorker(worker, { host: h })
  await mounted.request('board.read', {})
  const [update] = h.callsOf('statusBar.update') as { tone: string }[]
  assert.equal(update.tone, 'warning')
  await mounted.deactivate()
})

test('opens the dashboard on its key file in the focused workspace', async () => {
  opened.length = 0
  const h = host()
  const mounted = await mountWorker(worker, { host: h, commands: [OPEN_DASHBOARD] })
  assert.equal(await mounted.command(OPEN_DASHBOARD), undefined)
  assert.deepEqual(opened, ['/w/app-login'])
  assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'w1', path: '.coordinator-board/board.coordinator-board' }])
  await mounted.deactivate()
})

test('asks for a workspace when none is focused, and writes nothing', async () => {
  opened.length = 0
  const h = host()
  h.respond('workspace.readContext', null)
  const mounted = await mountWorker(worker, { host: h, commands: [OPEN_DASHBOARD] })
  assert.match(String(await mounted.command(OPEN_DASHBOARD)), /Open a workspace/)
  assert.deepEqual(opened, [])
  assert.equal(h.callsOf('editor.open').length, 0)
  await mounted.deactivate()
})

test('does not write the key file into a workspace on another host', async () => {
  opened.length = 0
  const h = host()
  h.respond('workspace.list', {
    workspaces: [{ id: 'w1', kind: 'worktree', name: 'feat-login', projectId: 'p1', path: '/w/app-login', branch: 'feat/login', hostId: 'ssh:box' }],
    truncated: false
  })
  const mounted = await mountWorker(worker, { host: h, commands: [OPEN_DASHBOARD] })
  assert.match(String(await mounted.command(OPEN_DASHBOARD)), /another host/)
  assert.deepEqual(opened, [])
  await mounted.deactivate()
})
