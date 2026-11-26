import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli, type Runner } from '../orca/cli'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { createFleet } from '../orca'
import { translator } from '../i18n'
import { contribute } from './board'
import { rpcServer } from './rpc'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const orca = fakeOrca([{ id: 'w', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_w', project: 'acme' }])
  const calls: string[][] = []
  const runner: Runner = (args, ms) => { calls.push([...args]); return orca.runner(args, ms) }
  const dir = mkdtempSync(join(tmpdir(), 'board-hosts-'))
  dirs.push(dir)
  const fleet = createFleet(createCli(runner), Date.now, { dataDir: dir })
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir, undefined, { t: () => translator('en'), bin: '', focusedWorkspace: async () => null })
  return { orca, calls, hosts: () => handlers.get('board.hosts')!({}) as Promise<any> }
}

test('hosts list with status; running sessions of answering environments, matched to a local project', async () => {
  const f = setup()
  f.orca.behavior.hosts = [
    { kind: 'local', name: 'this machine', id: 'local' },
    { kind: 'ssh', name: 'build box', id: 'ssh-1', connected: false },
    { kind: 'environment', name: 'studio', id: 'env-1' },
    { kind: 'environment', name: 'laptop', id: 'env-2' }
  ]
  f.orca.behavior.remote = {
    'env-1': [
      { orcaSessionId: 'r1', state: 'working', worktreeId: 'acme::/srv/acme', repo: 'acme', workspace: 'main', title: 'Port tests', updatedAt: 1_000 },
      { orcaSessionId: 'r2', state: 'waiting', worktreeId: 'acme::/srv/acme', repo: 'acme', title: 'Asks' },
      { orcaSessionId: 'r3', state: 'working', worktreeId: 'other-id::/srv/x', repo: 'acme', title: 'By name' },
      { orcaSessionId: 'r4', state: 'working', worktreeId: 'zzz::/srv/y', repo: 'unknown', title: 'Elsewhere' }
    ],
    'env-2': 'fail'
  }
  const out = await f.hosts()
  expect(out.hosts).toEqual([
    { id: 'local', label: 'this machine', status: 'online', current: true },
    { id: 'ssh-1', label: 'build box', status: 'offline', current: false },
    { id: 'env-1', label: 'studio', status: 'online', current: false },
    { id: 'env-2', label: 'laptop', status: 'offline', current: false }
  ])
  expect(out.remoteRunning.map((r: any) => [r.sessionId, r.projectId, r.hostName])).toEqual([['r1', 'acme', 'studio'], ['r3', 'acme', 'studio'], ['r4', null, 'studio']])
  expect(out.remoteRunning[0]).toMatchObject({ title: 'Port tests', workspace: 'main', activityAt: new Date(1_000).toISOString() })
  expect(out.note).toBeUndefined()
  const asked = f.calls.filter(c => c[0] === 'agent' && c[1] === 'list').length
  await f.hosts()
  expect(f.calls.filter(c => c[0] === 'agent' && c[1] === 'list').length).toBe(asked)
})

test('with no paired environment answering, remote sessions are empty and the board says why', async () => {
  const f = setup()
  expect(await f.hosts()).toMatchObject({ hosts: [{ id: 'local', status: 'online', current: true }], remoteRunning: [], note: 'There is no paired Orca environment.' })
  const g = setup()
  g.orca.behavior.hosts = [{ kind: 'local', name: 'this machine', id: 'local' }, { kind: 'environment', name: 'studio', id: 'env-1' }]
  g.orca.behavior.remote = { 'env-1': 'fail' }
  expect(await g.hosts()).toMatchObject({ remoteRunning: [], note: expect.stringContaining('No paired Orca environment answered') })
})
