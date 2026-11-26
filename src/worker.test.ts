// Runs the worker over a mock Orca host and the recorded-shape orca CLI answers, so no orca, git or gh process starts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker } from 'orca/testing'
import { afterEach, test } from 'vitest'
import { createCli } from './orca/cli'
import { fixturePulls, fixtureRunner, sid } from './orca/fixtures/load'
import { fakeOrca } from './orca/fixtures/fake-orca'
import { activateWith, OPEN_DASHBOARD, STATUS_ITEM, type FileDeps } from './worker'
import { randomUUID } from 'node:crypto'
import { runCli } from './cli/run'

const APP = 'aaaa1111-0000-4000-8000-000000000000'
const opened: string[] = []
const files: FileDeps = { ensureDashboard: async (root) => { opened.push(root) } }
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function worker(calls: string[][] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), 'board-worker-'))
  dirs.push(dataDir)
  let stop: (() => void) | undefined
  return {
    default: (orca: Parameters<typeof activateWith>[0]) => { stop = activateWith(orca, { cli: createCli(fixtureRunner(calls)), dataDir, files, pollMs: 0, pulls: fixturePulls, channel: null }) },
    deactivate: () => stop?.()
  }
}

function host(storage: Record<string, string | string[]> = { locale: 'en' }) {
  return mockHost({
    storage,
    results: {
      'workspace.list': {
        workspaces: [
          { id: 'identity:wt2:local:0a0a0a0a-0000-4000-8000-000000000001', kind: 'worktree', name: 'app', projectId: APP, path: '/w/app', branch: 'main', hostId: 'local' },
          { id: 'w-login', kind: 'worktree', name: 'feat-login', projectId: APP, path: '/w/app-login', branch: 'feat/login', hostId: 'local' }
        ],
        truncated: false
      },
      'terminal.focus': { focused: true },
      'workspace.open': { opened: true },
      'statusBar.update': { ok: true },
      'workspace.readContext': { workspaceId: 'w-login', branch: 'feat/login', displayName: 'feat-login', terminals: [] },
      'editor.open': { opened: true }
    }
  })
}

test('serves the Paseo snapshot, count and readiness for the chosen projects', async () => {
  const mounted = await mountWorker(worker(), { host: host() })
  assert.deepEqual(await mounted.request('board.scope', { kind: 'project', projectId: APP, enabled: true }), { ok: true })
  const snapshot = await mounted.request('board.snapshot', { fresh: true }) as { sessions: { title: string; lane: string }[]; coordinator: null }
  assert.equal(snapshot.sessions.find((s) => s.title === 'Ask about the release')?.lane, 'human')
  assert.equal(snapshot.coordinator, null)
  assert.deepEqual(await mounted.request('board.decision-count', {}), { count: 5 })
  assert.deepEqual(await mounted.request('board.readiness', {}), { configured: true, coordinator: null, decisionTitles: [] })
  await mounted.deactivate()
})

test('a request outside the contract is refused before anything is read', async () => {
  const calls: string[][] = []
  const mounted = await mountWorker(worker(calls), { host: host() })
  await assert.rejects(mounted.request('board.scope', { kind: 'project', projectId: '' }))
  await assert.rejects(mounted.request('board.decision-count', { extra: true }))
  assert.equal(calls.length, 0)
  await mounted.deactivate()
})

test('opens a terminal session by its handle and a chat by showing its workspace', async () => {
  const h = host()
  const mounted = await mountWorker(worker(), { host: h })
  assert.deepEqual(await mounted.request('board.open-session', { sessionId: sid(4) }), { opened: true })
  assert.deepEqual(h.callsOf('terminal.focus'), [{ terminalId: 'term_00000004-0000-4000-8000-000000000000' }])
  assert.deepEqual(await mounted.request('board.open-session', { sessionId: sid(1) }), { opened: true })
  assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'identity:wt2:local:0a0a0a0a-0000-4000-8000-000000000001' }])
  assert.deepEqual(await mounted.request('board.open-session', { sessionId: 'gone' }), { opened: false })
  await mounted.deactivate()
})

test('an asleep terminal opens its workspace, found by path when the host names it differently', async () => {
  const h = host()
  h.respond('workspace.list', { workspaces: [{ id: 'other-id', kind: 'worktree', name: 'app', projectId: APP, path: '\\w\\app\\', branch: 'main', hostId: 'local' }], truncated: false })
  const mounted = await mountWorker(worker(), { host: h })
  assert.deepEqual(await mounted.request('board.open-session', { sessionId: sid(8) }), { opened: true })
  assert.deepEqual(h.callsOf('workspace.open'), [{ workspaceId: 'other-id' }])
  await mounted.deactivate()
})

test('an agent event tells open panels the board changed and recounts the status bar', async () => {
  const h = host()
  const mounted = await mountWorker(worker(), { host: h })
  await mounted.request('board.scope', { kind: 'project', projectId: APP, enabled: true })
  await mounted.emit('agent.status.changed', { workspaceId: null, paneKey: 'a:b', state: 'done', receivedAt: 1 })
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.deepEqual(mounted.posts.map((p) => [p.event, p.payload]), [['board.changed', {}]])
  const last = h.callsOf('statusBar.update').at(-1) as { id: string; text: string }
  assert.deepEqual([last.id, last.text], [STATUS_ITEM, '5 to decide'])
  await mounted.deactivate()
})

test('opens the dashboard on its key file in the focused workspace', async () => {
  opened.length = 0
  const h = host()
  const mounted = await mountWorker(worker(), { host: h, commands: [OPEN_DASHBOARD] })
  assert.equal(await mounted.command(OPEN_DASHBOARD), undefined)
  assert.deepEqual(opened, ['/w/app-login'])
  assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'w-login', path: '.coordinator-board/board.coordinator-board' }])
  await mounted.deactivate()
})

test('asks for a workspace when none is focused, and writes nothing', async () => {
  opened.length = 0
  const h = host()
  h.respond('workspace.readContext', null)
  const mounted = await mountWorker(worker(), { host: h, commands: [OPEN_DASHBOARD] })
  assert.match(String(await mounted.command(OPEN_DASHBOARD)), /Open a workspace/)
  assert.deepEqual(opened, [])
  assert.equal(h.callsOf('editor.open').length, 0)
  await mounted.deactivate()
})

test('does not write the key file into a workspace on another host', async () => {
  opened.length = 0
  const h = host()
  h.respond('workspace.list', {
    workspaces: [{ id: 'w-login', kind: 'worktree', name: 'feat-login', projectId: APP, path: '/w/app-login', branch: 'feat/login', hostId: 'ssh:box' }],
    truncated: false
  })
  const mounted = await mountWorker(worker(), { host: h, commands: [OPEN_DASHBOARD] })
  assert.match(String(await mounted.command(OPEN_DASHBOARD)), /another host/)
  assert.deepEqual(opened, [])
  await mounted.deactivate()
})

test('takes the projects chosen in version 0.1 once, then forgets the old key', async () => {
  const h = host({ locale: 'en', selectedProjects: [APP] })
  const mounted = await mountWorker(worker(), { host: h })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(await mounted.request('board.readiness', {}), { configured: true, coordinator: null, decisionTitles: [] })
  assert.equal(Object.hasOwn(h.data().storage, 'selectedProjects'), false)
  await mounted.deactivate()
})

test('a reply to a chat is mailed from one board terminal, opened once in the focused workspace and reused', async () => {
  const orca = fakeOrca([{ id: 'writer', surface: 'chat', state: 'done', updatedAt: 1, title: 'Writer', project: 'studio' }])
  orca.say('writer', 'assistant', '제목을 골라 주실 수 있나요? 할까요?')
  const dataDir = mkdtempSync(join(tmpdir(), 'board-worker-'))
  dirs.push(dataDir)
  let stop: (() => void) | undefined
  const h = mockHost({ storage: { locale: 'en' }, results: {
    'workspace.readContext': { workspaceId: 'w-dash', branch: 'main', displayName: 'studio', terminals: [] },
    'terminal.create': { terminalId: 'term_board' },
    'terminal.list': { terminals: [{ id: 'term_board' }], truncated: false },
    'statusBar.update': { ok: true }, 'workspace.list': { workspaces: [], truncated: false }
  } })
  const mounted = await mountWorker({
    default: (api: Parameters<typeof activateWith>[0]) => { stop = activateWith(api, { cli: createCli(orca.runner), dataDir, files, pollMs: 0, pulls: fixturePulls, channel: null }) },
    deactivate: () => stop?.()
  }, { host: h })
  await mounted.request('board.scope', { kind: 'project', projectId: 'studio', enabled: true })
  const card = async () => ((await mounted.request('board.snapshot', { fresh: true })) as { sessions: { id: string; decision?: { version: string } }[] })
    .sessions.find((s) => s.id === 'writer')!.decision!
  await mounted.request('board.send-decision', { projectId: 'studio', sessionId: 'writer', recipientId: 'writer', version: (await card()).version,
    action: 'question', text: 'Which title is shorter?', requestKey: 'worker-question-0001' })
  orca.say('writer', 'assistant', '두 번째가 짧습니다. 어느 쪽으로 할까요?')
  await mounted.request('board.send-decision', { projectId: 'studio', sessionId: 'writer', recipientId: 'writer', version: (await card()).version,
    action: 'reply', text: 'Use the second.', requestKey: 'worker-reply-000002' })
  assert.deepEqual(h.callsOf('terminal.create'), [{ workspaceId: 'w-dash', title: 'Coordinator Board mail' }])
  assert.deepEqual(orca.writes.map((w) => w[w.indexOf('--from') + 1]), ['term_board', 'term_board'])
  await mounted.deactivate()
})

test('the coordinator reads and classifies over the channel with the env its launch got; others are refused', async () => {
  const orca = fakeOrca([
    { id: 'coord', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'studio' },
    { id: 'writer', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_w', title: 'Writer', project: 'studio' },
    { id: 'chat', surface: 'chat', state: 'done', updatedAt: 1, title: 'Chat', project: 'studio' }
  ])
  orca.say('writer', 'assistant', '제목을 골라 주실 수 있나요? 할까요?')
  const dataDir = mkdtempSync(join(tmpdir(), 'board-worker-'))
  dirs.push(dataDir)
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\cb-worker-' + randomUUID() : join(dataDir, 'channel.sock')
  let stop: (() => void) | undefined
  const h = mockHost({ storage: { locale: 'en' }, results: { 'statusBar.update': { ok: true }, 'workspace.list': { workspaces: [], truncated: false } } })
  const mounted = await mountWorker({
    default: (api: Parameters<typeof activateWith>[0]) => { stop = activateWith(api, { cli: createCli(orca.runner), dataDir, files, pollMs: 0, pulls: fixturePulls, channel: { path, bin: '/plugin/bin', node: '/orca/orca' } }) },
    deactivate: () => stop?.()
  }, { host: h })
  const envOf = async (terminalId: string) => {
    const decision = await mounted.hooks.fire('agent.launch.before', { agent: 'claude', workspaceId: null, workspaceKind: null, terminalId, command: 'claude', env: {} })
    assert.equal(decision.kind, 'continue')
    return (decision as { event: { env: Record<string, string> } }).event.env
  }
  const coordinatorEnv = await envOf('term_c')
  assert.equal(coordinatorEnv.CB_PIPE, path)
  assert.equal(coordinatorEnv.CB_BIN, '/plugin/bin')
  const cli = async (env: Record<string, string>, argv: string[], files: Record<string, string> = {}) => {
    const out: string[] = []
    const code = await runCli(argv, { env, readText: async (name) => files[name], stdout: (t) => { out.push(t) }, stderr: (t) => { out.push(t) }, defaultPipe: path,
      runOrca: async (args, ms) => ({ stdout: await orca.runner(args, ms), error: null }) })
    return { code, text: out.join('').trim() }
  }
  await mounted.request('board.scope', { kind: 'project', projectId: 'studio', enabled: true })
  assert.equal((await cli(coordinatorEnv, ['read'])).code, 4)
  await mounted.request('board.scope', { kind: 'coordinator', sessionId: 'coord' })
  const listing = await cli(coordinatorEnv, ['read'])
  assert.equal(listing.code, 0)
  assert.ok((JSON.parse(listing.text) as { id: string }[]).some((row) => row.id === 'writer'))
  const read = JSON.parse((await cli(coordinatorEnv, ['read', '--session', 'writer'])).text) as { evidenceId: string }
  const classified = await cli(coordinatorEnv, ['classify', '--session', 'writer', '--evidence', read.evidenceId, '--kind', 'question', '--text-file', '-', '--input-file', 'in.json'],
    { '-': 'Which title?', 'in.json': JSON.stringify({ content: { question: 'Which title?', recommendation: 'Use the second.' } }) })
  assert.deepEqual(classified, { code: 0, text: '판단을 해당 세션 카드에 기록했습니다.' })
  const snapshot = await mounted.request('board.snapshot', { fresh: true }) as { sessions: { id: string; decision?: { source: string; recommendation?: string } }[] }
  assert.deepEqual(snapshot.sessions.find((s) => s.id === 'writer')?.decision?.source, 'coordinator')
  assert.equal(snapshot.sessions.find((s) => s.id === 'writer')?.decision?.recommendation, 'Use the second.')
  const plan = await cli(coordinatorEnv, ['plan'])
  assert.equal(plan.code, 0)
  const { workspaces, routes } = JSON.parse(plan.text) as { workspaces: { id: string; projectId: string }[]; routes: { grade: string; route: unknown; expectedModeId?: string }[] }
  const d = routes.find((r) => r.grade === 'D')!
  const job = { projectId: 'studio', workspaceId: workspaces[0].id, grade: 'D', title: 'Ready check', prompt: 'Reply ready.', requestKey: 'worker-test-0001', expectedRoute: d.route, expectedModeId: d.expectedModeId }
  const assigned = await cli(coordinatorEnv, ['assign', '--input-file', 'job.json'], { 'job.json': JSON.stringify({ job }) })
  assert.equal(assigned.code, 0, assigned.text)
  assert.equal((JSON.parse(assigned.text) as { sessionId: string }).sessionId, 'launched-1')
  assert.equal(orca.launches.length, 1)

  const writerEnv = await envOf('term_w')
  assert.equal((await cli(writerEnv, ['read'])).code, 4)
  assert.equal((await cli({ ...writerEnv, CB_CALLER_TOKEN: coordinatorEnv.CB_CALLER_TOKEN }, ['read'])).code, 4)
  assert.deepEqual(await cli(writerEnv, ['report', '--kind', 'review', '--text-file', '-'], { '-': 'Draft is ready.' }), { code: 1, text: 'Board reporting is disabled for this session.' })
  await mounted.request('board.set-reporting', { sessionId: 'writer', enabled: true })
  await mounted.request('board.set-reporting', { sessionId: 'chat', enabled: true })
  assert.deepEqual(await cli(writerEnv, ['report', '--kind', 'review', '--text-file', '-'], { '-': 'Draft is ready.' }), { code: 0, text: 'Reported on your own Coordinator Board card.' })
  assert.equal((await cli({ CB_PIPE: path }, ['read', '--as', 'chat'])).code, 4)
  assert.equal((await cli({ CB_PIPE: path }, ['report', '--as', 'chat', '--kind', 'question', '--text-file', '-'], { '-': 'Ready?' })).code, 0)
  assert.equal((await cli({ CB_PIPE: path }, ['report', '--as', 'writer', '--kind', 'question', '--text-file', '-'], { '-': 'Ready?' })).code, 4)
  const notes = (await mounted.request('board.snapshot', { fresh: true }) as { notes: Record<string, { text: string; origin: string }> }).notes
  assert.deepEqual([notes.writer?.text, notes.writer?.origin, notes.chat?.text], ['Draft is ready.', 'agent', 'Ready?'])
  await mounted.deactivate()
})

test('with a coordinator the board mail terminal lives in its workspace, and moves there from where it was', async () => {
  const orca = fakeOrca([
    { id: 'writer', surface: 'chat', state: 'done', updatedAt: 1, title: 'Writer', project: 'studio' },
    { id: 'coord', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'ops' }
  ])
  orca.say('writer', 'assistant', '제목을 골라 주실 수 있나요? 할까요?')
  const dataDir = mkdtempSync(join(tmpdir(), 'board-worker-'))
  dirs.push(dataDir)
  let stop: (() => void) | undefined
  const h = mockHost({ storage: { locale: 'en', mailbox: { terminalId: 'term_old', workspaceId: 'w-dash' } }, results: {
    'workspace.readContext': { workspaceId: 'w-dash', branch: 'main', displayName: 'studio', terminals: [] },
    'terminal.create': { terminalId: 'term_board' },
    'terminal.list': { terminals: [{ id: 'term_old' }], truncated: false },
    'terminal.close': { closed: true },
    'statusBar.update': { ok: true }, 'workspace.list': { workspaces: [], truncated: false }
  } })
  const mounted = await mountWorker({
    default: (api: Parameters<typeof activateWith>[0]) => { stop = activateWith(api, { cli: createCli(orca.runner), dataDir, files, pollMs: 0, pulls: fixturePulls, channel: null }) },
    deactivate: () => stop?.()
  }, { host: h })
  await mounted.request('board.scope', { kind: 'project', projectId: 'studio', enabled: true })
  await mounted.request('board.scope', { kind: 'project', projectId: 'ops', enabled: true })
  await mounted.request('board.scope', { kind: 'coordinator', sessionId: 'coord' })
  const card = ((await mounted.request('board.snapshot', { fresh: true })) as { sessions: { id: string; decision?: { version: string } }[] })
    .sessions.find((s) => s.id === 'writer')!.decision!
  await mounted.request('board.send-decision', { projectId: 'studio', sessionId: 'writer', recipientId: 'writer', version: card.version,
    action: 'reply', text: 'Use the second.', requestKey: 'worker-reply-000009' })
  assert.deepEqual(h.callsOf('terminal.close'), [{ terminalId: 'term_old' }])
  assert.deepEqual(h.callsOf('terminal.create'), [{ workspaceId: 'identity:wt2:local:1', title: 'Coordinator Board mail' }])
  assert.deepEqual(h.data().storage.mailbox, { terminalId: 'term_board', workspaceId: 'identity:wt2:local:1' })
  assert.deepEqual(mounted.refusals, [])
  await mounted.deactivate()
})
