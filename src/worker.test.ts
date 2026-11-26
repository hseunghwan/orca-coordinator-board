// Runs the worker over a mock Orca host and the recorded-shape orca CLI answers, so no orca, git or gh process starts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker } from 'orca/testing'
import { afterEach, test } from 'vitest'
import { createCli } from './orca/cli'
import { fixturePulls, fixtureRunner, sid } from './orca/fixtures/load'
import { activateWith, OPEN_DASHBOARD, STATUS_ITEM, type FileDeps } from './worker'

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
    default: (orca: Parameters<typeof activateWith>[0]) => { stop = activateWith(orca, { cli: createCli(fixtureRunner(calls)), dataDir, files, pollMs: 0, pulls: fixturePulls }) },
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
  assert.deepEqual(await mounted.request('board.readiness', {}), { configured: true, coordinator: null, decisionTitles: ['Ask about the release', 'Delete build cache', 'Pick a layout'] })
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
