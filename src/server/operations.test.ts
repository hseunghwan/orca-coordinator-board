import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { readMarked } from '../orca/conversation'
import { fakeOrca, type FakeSession } from '../orca/fixtures/fake-orca'
import { createFleet } from '../orca'
import { translator } from '../i18n'
import { launchMarker } from '../channel/hook'
import { PreferenceStore } from '../paseo/server/preferences'
import { contribute } from './board'
import { rpcServer } from './rpc'
import { usageFromAccounts } from './catalog'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const ROUTE = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }

function setup(sessions: FakeSession[] = []) {
  const orca = fakeOrca([{ id: 'worker', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_w', title: 'Worker', project: 'acme' }, ...sessions])
  const dataDir = mkdtempSync(join(tmpdir(), 'board-ops-'))
  dirs.push(dataDir)
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir, sleep: async () => {}, mailSender: async () => 'term_board' })
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const board = contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dataDir, undefined,
    { t: () => translator('en'), bin: '/plugin/bin', focusedWorkspace: async () => 'acme::/w/acme' })
  const request = (name: string, input: unknown = {}) => handlers.get(name)!(input)
  const prefs = new PreferenceStore(join(dataDir, 'scope.json'))
  prefs.change(s => { s.projects = ['acme'] })
  const launches = () => orca.writes.filter(w => w[0] === 'agent' && w[1] === 'launch')
  const setupCoordinator = (more: object = {}) => request('board.setup-coordinator', { replace: false, expectedCoordinator: null, expectedRoute: ROUTE, ...more })
  return { orca, fleet, board, request, prefs, launches, setupCoordinator }
}

test('the operations catalog lists installed agents with suggested models, the coordinator mode and the workspaces to start in', async () => {
  const f = setup()
  const ops = await f.request('board.operations', { view: 'setup' }) as {
    providers: { id: string; status: string }[]; catalog: { provider: string; model: string }[]; coordinatorMode: unknown; workspaces: unknown[]
  }
  expect(ops.providers.map(p => [p.id, p.status])).toEqual([['claude', 'ready'], ['codex', 'ready'], ['grok', 'empty']])
  expect(ops.catalog.some(m => m.provider === 'claude' && m.model === 'claude-opus-5-5')).toBe(true)
  expect(ops.coordinatorMode).toEqual({ id: 'bypass', label: 'Bypass permissions' })
  expect(ops.workspaces).toEqual([{ id: 'acme::/w/acme', projectId: 'acme', title: 'acme', focused: true }])
})

test('account rate limits become Paseo usage windows, a model family window scoped to its models', () => {
  const usage = usageFromAccounts({ rateLimits: {
    claude: { provider: 'claude', status: 'ok', planType: 'team', updatedAt: 1_000, error: null,
      session: { usedPercent: 55, resetsAt: 2_000 }, weekly: { usedPercent: 81, resetsAt: 3_000 }, fableWeekly: { usedPercent: 16, resetsAt: 3_000 }, monthly: null },
    gemini: { provider: 'gemini', status: 'unavailable', error: 'not signed in', session: null, weekly: null, updatedAt: 1_000 }
  } })
  expect(usage[0]).toMatchObject({ providerId: 'claude', plan: 'team', status: 'available', fetchedAt: new Date(1_000).toISOString(), balances: [] })
  expect(usage[0].windows.map(w => [w.id, w.remainingPct, w.summary])).toEqual([['session', 45, true], ['weekly', 19, true], ['weekly_model_fable', 84, false]])
  expect(usage[1]).toMatchObject({ providerId: 'gemini', status: 'unavailable', windows: [] })
})

test('setup launches one terminal coordinator in the focused workspace, marked for the hook, and adopts its session', async () => {
  const f = setup()
  f.orca.behavior.reportAfterPs = 2
  let pendingDuringLaunch: unknown
  f.orca.behavior.onWrite = () => { pendingDuringLaunch = f.board.pendingLaunch() }
  const started = await f.setupCoordinator() as { sessionId: string; workspaceId: string; reused: boolean }
  expect(started).toEqual({ sessionId: 'launched-1', workspaceId: 'acme::/w/acme', reused: false, pinFailed: true })
  const [args] = f.launches()
  const flag = (name: string) => args[args.indexOf(name) + 1]
  expect([flag('--agent'), flag('--worktree'), flag('--surface'), flag('--model'), flag('--effort')]).toEqual(['claude', 'id:acme::/w/acme', 'terminal', 'claude-opus-5-5', 'high'])
  const launch = pendingDuringLaunch as { launchId: string; modeId: string }
  expect(launch.modeId).toBe('bypass')
  expect(flag('--prompt').startsWith(launchMarker(launch.launchId) + '\n')).toBe(true)
  expect(flag('--prompt')).toContain('/plugin/bin')
  expect(f.board.pendingLaunch()).toBeUndefined()
  expect(f.prefs.read().coordinator).toBe('launched-1')
  expect(await f.setupCoordinator({ expectedCoordinator: 'launched-1' })).toMatchObject({ sessionId: 'launched-1', reused: true })
  expect(f.launches()).toHaveLength(1)
})

test('a launch whose answer is lost is settled with Orca\'s retry id, never started twice', async () => {
  const f = setup()
  f.orca.behavior.launch = 'lose-with-id'
  await expect(f.setupCoordinator()).rejects.toThrow('Could not confirm')
  f.orca.behavior.launch = 'start'
  expect(await f.setupCoordinator()).toMatchObject({ sessionId: 'launched-1', reused: false })
  expect(f.launches().map(a => a.includes('--retry-launch') ? a[a.indexOf('--retry-launch') + 1] : null)).toEqual([null, 'op-1'])
  expect(f.orca.launches).toHaveLength(1)

  const g = setup()
  g.orca.behavior.launch = 'lose'
  await expect(g.setupCoordinator()).rejects.toThrow('Could not confirm')
  g.orca.behavior.launch = 'start'
  await expect(g.setupCoordinator()).rejects.toThrow('waits 10 minutes')
  expect(g.launches()).toHaveLength(1)
})

test('a refused launch leaves nothing pending; a workspace not on this computer is refused before launching', async () => {
  const f = setup()
  f.orca.behavior.launch = 'refuse'
  await expect(f.setupCoordinator()).rejects.toThrow('Orca refused to start the coordinator: agent not installed')
  expect(f.prefs.read().pendingCoordinator).toBeUndefined()
  await expect(f.setupCoordinator({ workspaceId: 'elsewhere::/x' })).rejects.toThrow('not on this computer')
  f.orca.behavior.launch = 'start'
  expect(await f.setupCoordinator({ workspaceId: 'acme::/w/acme' })).toMatchObject({ sessionId: 'launched-1' })
  expect(f.launches()).toHaveLength(2)
})

test('digest and work requests reach an idle coordinator once; a working one is asked to wait', async () => {
  const f = setup([{ id: 'coord', surface: 'terminal', state: 'working', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'acme' }])
  await f.request('board.scope', { kind: 'coordinator', sessionId: 'coord' })
  const digest = { coordinator: 'coord', requestKey: 'digest-0000001', language: 'en' }
  await expect(f.request('board.request-digest', digest)).rejects.toThrow('takes requests when it is idle')
  f.orca.find('coord')!.state = 'done'
  expect(await f.request('board.request-digest', digest)).toEqual({ ok: true })
  expect(await f.request('board.request-digest', digest)).toEqual({ ok: true })
  const received = () => f.orca.transcripts.get('coord')!.map(e => readMarked(e.text)!.body)
  expect(received()).toHaveLength(1)
  expect(received()[0].startsWith('[coordinator-board]\nRefresh the digest')).toBe(true)
  const work = { coordinator: 'coord', requestKey: 'work-000000001', text: 'Split the release notes.' }
  expect(await f.request('board.request-work', work)).toEqual({ ok: true })
  expect(received()[1]).toBe('Split the release notes.')
  await expect(f.request('board.request-work', { ...work, text: 'Something else.' })).rejects.toThrow('text changed')
})
