// Adapted from paseo-coordinator-board test/dispatch.test.ts @ 2e9d128 onto the fake Orca. Paseo's assertions on
// scope, workspace, route and idempotency are kept; the launch runs through the caller's own orca (channel
// protocol 2), a lost answer is settled with --retry-launch, and the worker's metadata is found by its session.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli, type Runner } from '../orca/cli'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { createFleet } from '../orca'
import { launchMarker, type PendingLaunch } from '../channel/hook'
import { PreferenceStore } from '../paseo/server/preferences'
import type { DispatchInput } from '../paseo/shared/dispatch'
import { contribute } from './board'
import { dispatchWorker, WorkerJournal } from './dispatch'
import { rpcServer } from './rpc'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const sol = { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high' }
const sonnet = { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }

function setup() {
  const orca = fakeOrca([
    { id: 'coord', surface: 'terminal', state: 'working', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'acme' },
    { id: 'other', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_o', title: 'Other', project: 'beta' }
  ])
  const dir = mkdtempSync(join(tmpdir(), 'board-dispatch-'))
  dirs.push(dir)
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir: dir, sleep: async () => {} })
  const shell: string[][] = []
  const callerRunner: Runner = (args, ms) => { shell.push([...args]); return orca.runner(args, ms) }
  const caller = createCli(callerRunner)
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const board = contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir)
  const prefs = new PreferenceStore(join(dir, 'scope.json'))
  prefs.change(s => { s.projects = ['acme']; s.coordinator = 'coord'; s.routing = { C: [sol] } })
  const journal = new WorkerJournal(join(dir, 'workers.json'))
  const deps = { fleet, journal, sleep: async () => {} }
  const state = { projects: ['acme'], coordinator: 'coord', excludedProviders: [], routing: { C: [sol] } }
  const task: DispatchInput = { projectId: 'acme', workspaceId: 'acme::/w/acme', grade: 'C', requestKey: 'request-dispatch-01',
    title: '문서 교정', prompt: '오탈자를 확인해 줘.', expectedRoute: sol }
  const launches = () => orca.writes.filter(w => w[0] === 'agent' && w[1] === 'launch')
  return { orca, fleet, board, prefs, caller, shell, deps, state, task, launches, journal }
}

test('plan lists the managed workspaces and the route and worker mode of each grade', async () => {
  const f = setup()
  const plan = JSON.parse((await f.board.command('plan', {}, 'coord')).text)
  expect(plan.projects).toEqual([{ id: 'acme', title: 'acme', path: '/w/acme' }])
  expect(plan.workspaces).toEqual([{ id: 'acme::/w/acme', projectId: 'acme', title: 'acme' }])
  expect(plan.sessions.map((s: { id: string }) => s.id)).toEqual(['coord'])
  expect(plan.routes.find((r: { grade: string }) => r.grade === 'C')).toEqual({ grade: 'C', route: sol, expectedModeId: 'auto-review' })
  expect(plan.routes.find((r: { grade: string }) => r.grade === 'D')).toMatchObject({ route: sonnet, expectedModeId: 'auto' })
  await expect(f.board.command('plan', {}, 'other')).rejects.toThrow('코디네이터')
  expect(f.board.audience('plan')).toBe('coordinator')
  expect(f.board.audience('assign')).toBe('coordinator')
})

test('assign starts one worker from the coordinator\'s own shell, marked for the hook, with the coordinator as its parent', async () => {
  const f = setup()
  let pending: PendingLaunch[] = []
  f.orca.behavior.onWrite = () => { pending = f.board.pendingLaunches() }
  const result = JSON.parse((await f.board.command('assign', { job: f.task }, 'coord', f.caller)).text)
  expect(result).toEqual({ sessionId: 'launched-1', route: sol, modeId: 'auto-review', terminal: 'term_launch_1' })
  expect(f.shell).toHaveLength(1)
  const [args] = f.launches()
  const flag = (name: string) => args[args.indexOf(name) + 1]
  expect([flag('--agent'), flag('--worktree'), flag('--surface'), flag('--model'), flag('--effort')]).toEqual(['codex', 'id:acme::/w/acme', 'terminal', sol.model, 'high'])
  expect(pending).toEqual([{ launchId: expect.any(String), modeId: 'auto-review', role: 'worker' }])
  expect(flag('--prompt')).toBe(launchMarker(pending[0].launchId) + '\n' + f.task.prompt)
  expect(f.board.pendingLaunches()).toEqual([])
  expect(f.board.worker('launched-1')).toEqual({ requestKey: f.task.requestKey, reports: true, intent: expect.stringMatching(/^[a-f0-9]{64}$/), grade: 'C', parent: 'coord', mode: 'auto-review' })
  expect(await f.board.command('report', { kind: 'review', text: 'Ready.' }, 'launched-1')).toEqual({ text: 'Reported on your own Coordinator Board card.' })
  expect(JSON.parse((await f.board.command('assign', { job: f.task }, 'coord', f.caller)).text)).toEqual(result)
  await expect(f.board.command('assign', { job: { ...f.task, prompt: '다른 작업' } }, 'coord', f.caller)).rejects.toThrow('다른 작업')
  await expect(f.board.command('assign', { job: { ...f.task, requestKey: 'request-dispatch-02' } }, 'coord')).rejects.toThrow('코디네이터 터미널')
  expect(f.launches()).toHaveLength(1)
})

test('정책·관리 범위가 달라지거나 다른 워크스페이스면 생성하지 않고, 미리보기와 다른 배정은 시작하지 않는다', async () => {
  const f = setup()
  const other = { ...f.state, projects: ['beta'] }
  await expect(dispatchWorker(f.deps, f.caller, { ...f.task, targetServerId: 'stale-selection' } as DispatchInput, () => f.state)).rejects.toThrow(/targetServerId/)
  await expect(dispatchWorker(f.deps, f.caller, f.task, () => ({ ...f.state, coordinator: null }))).rejects.toThrow(/코디네이터/)
  await expect(dispatchWorker(f.deps, f.caller, f.task, () => other)).rejects.toThrow(/관리할 프로젝트/)
  await expect(dispatchWorker(f.deps, f.caller, { ...f.task, workspaceId: 'foreign' }, () => f.state)).rejects.toThrow(/워크스페이스/)
  await expect(dispatchWorker(f.deps, f.caller, { ...f.task, projectId: 'beta' }, () => other)).rejects.toThrow(/워크스페이스/)
  await expect(dispatchWorker(f.deps, f.caller, { ...f.task, expectedRoute: sonnet }, () => f.state)).rejects.toThrow(/미리보기/)
  await expect(dispatchWorker(f.deps, f.caller, { ...f.task, expectedModeId: 'full-access' }, () => f.state)).rejects.toThrow(/미리보기/)
  let reads = 0
  await expect(dispatchWorker(f.deps, f.caller, f.task, () => ++reads === 1 ? f.state : other)).rejects.toThrow(/관리할 프로젝트/)
  expect(f.launches()).toHaveLength(0)
  expect(await dispatchWorker(f.deps, f.caller, f.task, () => ({ ...f.state, coordinator: 'local-coord' }))).toMatchObject({ modeId: 'auto-review' })
  expect(f.journal.worker('launched-1')?.parent).toBe('local-coord')
})

test('a worker mode the provider does not offer, a bypass override included, is refused before launching', async () => {
  const f = setup()
  await expect(dispatchWorker(f.deps, f.caller, { ...f.task, expectedModeId: 'bypass' }, () => ({ ...f.state, workerModeOverrides: { codex: 'bypass' } }))).rejects.toThrow("'bypass'")
  expect(await dispatchWorker(f.deps, f.caller, { ...f.task, expectedModeId: 'full-access' }, () => ({ ...f.state, workerModeOverrides: { codex: 'full-access' } }))).toMatchObject({ modeId: 'full-access' })
  expect(f.launches()).toHaveLength(1)
})

test('생성 결과를 잃으면 Orca의 재시도 id로만 확인하고 두 번 띄우지 않는다', async () => {
  const f = setup()
  f.orca.behavior.launch = 'lose-with-id'
  await expect(dispatchWorker(f.deps, f.caller, f.task, () => f.state)).rejects.toThrow('확인하지 못했습니다')
  expect(f.board.pendingLaunches()).toHaveLength(1)
  f.orca.behavior.launch = 'start'
  expect(await dispatchWorker(f.deps, f.caller, f.task, () => f.state)).toMatchObject({ sessionId: 'launched-1' })
  expect(f.launches().map(a => a.includes('--retry-launch') ? a[a.indexOf('--retry-launch') + 1] : null)).toEqual([null, 'op-1'])
  expect(f.orca.launches).toHaveLength(1)

  const g = setup()
  g.orca.behavior.launch = 'lose'
  await expect(dispatchWorker(g.deps, g.caller, g.task, () => g.state)).rejects.toThrow('확인하지 못했습니다')
  g.orca.behavior.launch = 'start'
  await expect(dispatchWorker(g.deps, g.caller, g.task, () => g.state)).rejects.toThrow('새 requestKey')
  expect(g.launches()).toHaveLength(1)
})

test('a refused launch keeps no receipt, so the same request can start later', async () => {
  const f = setup()
  f.orca.behavior.launch = 'refuse'
  await expect(dispatchWorker(f.deps, f.caller, f.task, () => f.state)).rejects.toThrow('거절')
  expect(f.board.pendingLaunches()).toEqual([])
  f.orca.behavior.launch = 'start'
  expect(await dispatchWorker(f.deps, f.caller, f.task, () => f.state)).toMatchObject({ sessionId: 'launched-1' })
  expect(f.launches()).toHaveLength(2)
})

test('동시에 온 같은 요청은 한 작업에 연결된다', async () => {
  const f = setup()
  const [a, b] = await Promise.all([dispatchWorker(f.deps, f.caller, f.task, () => f.state), dispatchWorker(f.deps, f.caller, f.task, () => f.state)])
  expect(a).toEqual(b)
  expect(f.launches()).toHaveLength(1)
})

test('a worker whose terminal has not reported yet is named on the board\'s next change', async () => {
  const f = setup()
  f.orca.behavior.reportAfterPs = 100
  expect(await dispatchWorker(f.deps, f.caller, f.task, () => f.state)).toEqual({ sessionId: null, route: sol, modeId: 'auto-review', terminal: 'term_launch_1' })
  expect(f.board.worker('launched-1')).toBeUndefined()
  f.orca.launches[0].hiddenFor = 0
  f.fleet.invalidate()
  expect(await f.board.adoptCoordinator()).toBe(true)
  expect(f.board.worker('launched-1')).toMatchObject({ parent: 'coord', grade: 'C' })
  expect(await dispatchWorker(f.deps, f.caller, f.task, () => f.state)).toMatchObject({ sessionId: 'launched-1' })
  expect(f.launches()).toHaveLength(1)
})
