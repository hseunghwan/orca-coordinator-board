// Adapted from paseo-coordinator-board test/session-links.test.ts @ 2e9d128: the link and list cases on the fake Orca.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli, type Runner } from '../orca/cli'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { createFleet } from '../orca'
import { contribute } from './board'
import { rpcServer } from './rpc'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const orca = fakeOrca([
    { id: 'worker', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_w', title: 'Same task', project: 'origin' },
    { id: 'sibling', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_s', title: 'Same task', project: 'origin' },
    { id: 'coord', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'public' },
    { id: 'other', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_o', title: 'Other', project: 'other' }
  ])
  const reads: string[] = []
  const runner: Runner = (args, ms) => {
    if (args[0] === 'agent' && args[1] === 'read') reads.push(args[2].replace('orca_session_id:', ''))
    return orca.runner(args, ms)
  }
  const dir = mkdtempSync(join(tmpdir(), 'session-links-'))
  dirs.push(dir)
  const fleet = createFleet(createCli(runner), Date.now, { dataDir: dir, sleep: async () => {} })
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir)
  const rpc = async (name: string, input: unknown = {}) => { fleet.invalidate(); return handlers.get(name)!(input) as Promise<any> }
  const select = (id: string, enabled = true) => rpc('board.scope', { kind: 'project', projectId: id, enabled })
  const link = (target: string | null = 'public', expected: string | null = null, sessionId = 'worker', sourceProjectId = 'origin') =>
    rpc('board.link-session', { sessionId, sourceProjectId, targetProjectId: target, expectedTargetProjectId: expected })
  const board = () => rpc('board.snapshot', { fresh: true })
  return { orca, reads, rpc, select, link, board }
}

test('linking moves one existing session onto the chosen project, keeping its source and id', async () => {
  const f = fixture()
  await f.select('public')
  await f.link()
  const snapshot = await f.board()
  expect(snapshot.projects.find((p: any) => p.id === 'origin').selected).toBe(false)
  expect(snapshot.sessions.map((s: any) => s.id).sort()).toEqual(['coord', 'worker'])
  expect(snapshot.sessions.find((s: any) => s.id === 'worker')).toMatchObject({ projectId: 'public', sourceProjectId: 'origin' })
  expect([...new Set(f.reads)].sort()).toEqual(['coord', 'worker'])
  await f.select('origin')
  const both = await f.board()
  expect(both.sessions.filter((s: any) => s.id === 'worker').map((s: any) => s.projectId)).toEqual(['public'])
  expect(both.sessions.find((s: any) => s.id === 'sibling').projectId).toBe('origin')
  await f.link(null, 'public')
  expect((await f.board()).sessions.find((s: any) => s.id === 'worker')).toMatchObject({ id: 'worker', projectId: 'origin' })
  expect(f.orca.writes).toEqual([])
})

test('the link list reads no transcript, tells sessions apart by id, and releases a vanished source', async () => {
  const f = fixture()
  await f.select('public')
  await expect(f.link('other')).rejects.toThrow('먼저 선택')
  await expect(f.link('public', null, 'worker', 'other')).rejects.toThrow()
  await f.link()
  await expect(f.link(null, null)).rejects.toThrow('바뀌었습니다')
  f.orca.sessions.splice(f.orca.sessions.findIndex(s => s.id === 'worker'), 1)
  const result = await f.rpc('board.session-links')
  expect(result.sessions.find((s: any) => s.sessionId === 'worker')).toMatchObject({ available: false, sourceProjectId: 'origin', targetProjectId: 'public' })
  expect(f.reads).toEqual([])
  await f.link(null, 'public')
  expect((await f.rpc('board.session-links')).sessions.some((s: any) => s.sessionId === 'worker')).toBe(false)
})
