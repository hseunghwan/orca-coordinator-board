import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { readBoardHeader, readMarked } from '../orca/conversation'
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
  const repoAdds = () => orca.writes.filter(w => w[0] === 'repo' && w[1] === 'add')
  const home = join(dataDir, 'coordinator')
  return { orca, fleet, board, request, prefs, launches, setupCoordinator, repoAdds, home, homeWorkspace: 'home-1::' + home.replace(/\\/g, '/') }
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

test('setup launches one terminal coordinator in the coordinator home, marked for the hook, and adopts its session', async () => {
  const f = setup()
  f.orca.behavior.reportAfterPs = 2
  let pendingDuringLaunch: unknown
  f.orca.behavior.onWrite = (args) => { if (args[0] === 'agent') pendingDuringLaunch = f.board.pendingLaunches()[0] }
  const started = await f.setupCoordinator() as { sessionId: string; workspaceId: string; reused: boolean }
  expect(started).toEqual({ sessionId: 'launched-1', workspaceId: f.homeWorkspace, reused: false, pinFailed: true })
  expect(existsSync(f.home)).toBe(true)
  expect(f.repoAdds()).toEqual([['repo', 'add', '--path', f.home, '--kind', 'folder', '--json']])
  const [args] = f.launches()
  const flag = (name: string) => args[args.indexOf(name) + 1]
  expect([flag('--agent'), flag('--worktree'), flag('--surface'), flag('--model'), flag('--effort')]).toEqual(['claude', 'id:' + f.homeWorkspace, 'terminal', 'claude-opus-5-5', 'high'])
  const launch = pendingDuringLaunch as { launchId: string; modeId: string; role: string }
  expect(launch).toMatchObject({ modeId: 'bypass', role: 'coordinator' })
  expect(flag('--prompt').startsWith(launchMarker(launch.launchId) + '\n')).toBe(true)
  expect(flag('--prompt')).toContain('/plugin/bin')
  expect(f.board.pendingLaunches()).toEqual([])
  expect(f.prefs.read().coordinator).toBe('launched-1')
  expect(await f.setupCoordinator({ expectedCoordinator: 'launched-1' })).toMatchObject({ sessionId: 'launched-1', reused: true })
  expect(f.launches()).toHaveLength(1)
})

test('a replacement coordinator starts in the same home without adding the folder again', async () => {
  const f = setup()
  await f.setupCoordinator()
  expect(await f.setupCoordinator({ expectedCoordinator: 'launched-1', replace: true })).toMatchObject({ sessionId: 'launched-2', workspaceId: f.homeWorkspace })
  expect(f.repoAdds()).toHaveLength(1)
})

test('a repo add whose answer is lost is settled from the repo list, and a refused one starts nothing', async () => {
  const f = setup()
  f.orca.behavior.repoAdd = 'lose'
  expect(await f.setupCoordinator()).toMatchObject({ sessionId: 'launched-1', workspaceId: f.homeWorkspace })
  expect(f.repoAdds()).toHaveLength(1)

  const g = setup()
  g.orca.behavior.repoAdd = 'refuse'
  await expect(g.setupCoordinator()).rejects.toThrow('Could not open the coordinator home as an Orca project. path is not a directory')
  expect(g.launches()).toHaveLength(0)
})

test('an explicit workspace overrides the coordinator home', async () => {
  const f = setup()
  expect(await f.setupCoordinator({ workspaceId: 'acme::/w/acme' })).toMatchObject({ sessionId: 'launched-1', workspaceId: 'acme::/w/acme' })
  expect(f.repoAdds()).toHaveLength(0)
})

test('the coordinator home is listed first to start in, but is never a project choice; its coordinator stays the coordinator', async () => {
  const f = setup()
  await f.setupCoordinator()
  const ops = await f.request('board.operations', { view: 'setup' }) as { workspaces: unknown[] }
  expect(ops.workspaces).toEqual([
    { id: f.homeWorkspace, projectId: 'home-1', title: 'Coordinator home', home: true },
    { id: 'acme::/w/acme', projectId: 'acme', title: 'acme', focused: true },
  ])
  const snapshot = await f.request('board.snapshot', { fresh: true }) as { projects: { id: string }[]; sessions: { id: string }[]; coordinator: string }
  expect(snapshot.projects.map(p => p.id)).toEqual(['acme'])
  expect(snapshot.sessions.map(s => s.id)).toEqual(['worker'])
  expect(snapshot.coordinator).toBe('launched-1')
  await expect(f.request('board.scope', { kind: 'project', projectId: 'home-1', enabled: true })).rejects.toThrow('코디네이터 운영 폴더')
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
  await expect(f.request('board.request-work', { ...work, text: 'Something else.' })).rejects.toThrow('text or photos changed')
})

test('a work request with a photo names its file after the marker, and the session photo reads back', async () => {
  const f = setup([{ id: 'coord', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'acme' }])
  await f.request('board.scope', { kind: 'coordinator', sessionId: 'coord' })
  const png = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC' }
  const work = { coordinator: 'coord', requestKey: 'work-photo-0001', text: 'Match this screen.', images: [png] }
  expect(await f.request('board.request-work', work)).toEqual({ ok: true })
  const entry = f.orca.transcripts.get('coord')!.at(-1)!.text
  const marked = readMarked(entry)!
  expect(marked.messageId.startsWith('c0bdf070')).toBe(true)
  expect(marked.body).toBe('Match this screen.')
  const path = /^\[사진 1\] (.+\.png)$/.exec(entry.split('\n')[1])![1]
  expect(readFileSync(path).toString('base64')).toBe(png.data)
  expect(await f.request('board.read-session-photo', { sessionId: 'coord', messageId: marked.messageId, index: 0 })).toEqual({ count: 1, image: png })
  expect(await f.request('board.request-work', work)).toEqual({ ok: true })
  expect(f.orca.transcripts.get('coord')).toHaveLength(1)
  await expect(f.request('board.request-work', { ...work, images: [] })).rejects.toThrow('text or photos changed')
})

test('a digest that handles board facts names the cycle, and the coordinator\'s fact command types the answer into the worker\'s terminal under its header', async () => {
  const f = setup([{ id: 'coord', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'acme' }])
  f.orca.say('worker', 'assistant', 'What is the current status of this session?')
  await f.request('board.scope', { kind: 'coordinator', sessionId: 'coord' })
  expect(await f.request('board.fact-reply-settings')).toEqual({ enabled: true })
  await f.request('board.snapshot', { fresh: true })
  await f.request('board.request-digest', { coordinator: 'coord', requestKey: 'digest-0000002', language: 'en', handleBoardFacts: true })
  const prompt = readMarked(f.orca.transcripts.get('coord')!.at(-1)!.text)!.body
  const cycleId = /"cycleId":"([a-f0-9]{64})"/.exec(prompt)![1]
  expect(prompt).toContain('coordinator-board fact --cycle ' + cycleId)
  const listing = JSON.parse((await f.board.command('read', {}, 'coord')).text) as { id: string; factCandidate?: boolean }[]
  expect(listing.find(r => r.id === 'worker')).toMatchObject({ factCandidate: true })
  const { evidenceId } = JSON.parse((await f.board.command('read', { sessionId: 'worker' }, 'coord')).text)
  f.orca.find('coord')!.state = 'working'
  expect(await f.board.command('fact', { cycleId, sessionId: 'worker', evidenceId }, 'coord')).toEqual({ text: expect.stringContaining('accepted') })
  const typed = f.orca.writes.filter(w => w[0] === 'terminal' && w[3] === 'term_w')
  expect(typed).toHaveLength(1)
  expect(f.orca.writes.some(w => w[0] === 'orchestration')).toBe(false)
  const fact = readBoardHeader(readMarked(typed[0][typed[0].indexOf('--text') + 1])!.body)!
  expect(fact.from).toBe('coord')
  expect(JSON.parse(fact.body)).toMatchObject({ type: 'coordinator-board.fact', answer: 'Observed Orca session status: idle.' })
  await f.request('board.set-fact-auto-reply', { enabled: false })
  expect(await f.request('board.fact-reply-settings')).toEqual({ enabled: false })
  expect(f.prefs.read().factCycle).toBeUndefined()
})
