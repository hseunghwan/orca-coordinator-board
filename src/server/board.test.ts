import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { createFleet } from '../orca'
import { fixturePulls, fixtureRunner, sid } from '../orca/fixtures/load'
import { contribute } from './board'
import { rpcServer } from './rpc'

const APP = 'aaaa1111-0000-4000-8000-000000000000'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function board() {
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  dirs.push(dir)
  const calls: string[][] = []
  const fleet = createFleet(createCli(fixtureRunner(calls)))
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const live = contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir, fixturePulls)
  const request = (name: string, input: unknown = {}) => handlers.get(name)!(input) as Promise<any>
  return { request, calls, live, dir }
}

test('a selected project shows its sessions in Paseo lanes, with a plain-text question as a human decision', async () => {
  const { request, dir } = board()
  expect(await request('board.readiness')).toEqual({ configured: false, coordinator: null, decisionTitles: [] })
  await request('board.scope', { kind: 'project', projectId: APP, enabled: true })
  const snap = await request('board.snapshot', { fresh: true })
  const lanes = Object.fromEntries(snap.sessions.map((s: any) => [s.title, [s.lane, s.decision?.source ?? null]]))
  expect(lanes).toEqual({
    'Ask about the release': ['human', 'conversation'],
    'Read and done': ['idle', null],
    'Port the parser': ['running', null],
    'Delete build cache': ['human', 'permission'],
    'Pick a layout': ['human', 'permission'],
    'Broken run': ['review', null],
    'Long release answer': ['human', 'conversation'],
    'Asleep terminal': ['idle', null]
  })
  const asked = snap.sessions.find((s: any) => s.id === sid(1))
  expect(asked.detail).toContain('골라 주세요')
  expect(asked.evidenceId).toMatch(/^[0-9a-f]{24}$/)
  expect(snap.sessions.find((s: any) => s.id === sid(8)).detail).toBe('대화 종료')
  expect(snap.projects.map((p: any) => [p.title, p.selected, !!p.icon])).toEqual([['app', true, true], ['site', false, false], ['Notes', false, false]])
  expect(snap.pullRequests.items.map((pr: any) => [pr.repo, pr.number, pr.lane])).toEqual([['acme/app', 7, 'review']])
  expect(await request('board.decision-count')).toEqual({ count: 5 })
  expect((await request('board.readiness')).decisionTitles).toEqual([])
  writeFileSync(join(dir, 'tracked-decisions.json'), JSON.stringify({ version: 1, items: [
    { source: 'ops', projectId: APP, id: 'later', title: 'Pick a launch week', urgency: 'week' },
    { source: 'ops', projectId: APP, id: 'now', title: 'Approve the release', dueAt: '2000-01-01T00:00:00Z' },
    { source: 'ops', projectId: 'elsewhere', id: 'hidden', title: 'Not this project' }
  ] }))
  expect((await request('board.readiness')).decisionTitles).toEqual(['Approve the release', 'Pick a launch week'])
  expect((await request('board.snapshot', { fresh: true })).trackedDecisions.items.map((i: any) => i.title)).toEqual(['Pick a launch week', 'Approve the release'])
})

test('closed, working and waiting sessions are never read; a read is kept while its session is unchanged, a failed one is not', async () => {
  const { request, calls } = board()
  await request('board.scope', { kind: 'project', projectId: APP, enabled: true })
  await request('board.snapshot', {})
  const read = calls.filter((c) => c[0] === 'agent').map((c) => c[2].slice('orca_session_id:'.length))
  expect(read.sort()).toEqual([sid(1), sid(2), sid(6), sid(7)].sort())
  await request('board.snapshot', { fresh: true })
  expect(calls.filter((c) => c[0] === 'agent').map((c) => c[2]).slice(4)).toEqual(['orca_session_id:' + sid(6)])
})

test('the coordinator must be a managed session, and leaving its project releases it', async () => {
  const { request } = board()
  await expect(request('board.scope', { kind: 'coordinator', sessionId: sid(2) })).rejects.toThrow('관리할 프로젝트')
  await request('board.scope', { kind: 'project', projectId: APP, enabled: true })
  await request('board.scope', { kind: 'coordinator', sessionId: sid(2) })
  expect((await request('board.readiness')).coordinator).toBe(sid(2))
  await request('board.scope', { kind: 'project', projectId: APP, enabled: false })
  expect(await request('board.readiness')).toMatchObject({ configured: false, coordinator: null })
  await expect(request('board.scope', { kind: 'project', projectId: 'nope', enabled: true })).rejects.toThrow('프로젝트를 찾을 수 없습니다')
})
