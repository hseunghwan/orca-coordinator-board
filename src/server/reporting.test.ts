// The RPCs the dashboard frame calls are all served, and Paseo's report_to_board rule holds on Orca: a session
// other than the coordinator reports only with its reporting flag, which board.set-reporting keeps.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { createFleet } from '../orca'
import { contribute } from './board'
import { rpcServer } from './rpc'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const orca = fakeOrca([
    { id: 'coord', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'acme' },
    { id: 'writer', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_w', title: 'Writer', project: 'acme' }
  ])
  const dir = mkdtempSync(join(tmpdir(), 'board-reporting-'))
  dirs.push(dir)
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir: dir, sleep: async () => {} })
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const board = contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir)
  const request = async (name: string, input: unknown = {}) => { fleet.invalidate(); return handlers.get(name)!(input) as Promise<any> }
  return { orca, board, handlers, request }
}

test('every RPC the dashboard calls has a handler', () => {
  const f = setup()
  for (const name of ['board.set-worker-mode', 'board.set-provider-inclusion', 'board.update-routing', 'board.set-usage-routing', 'board.save-note',
    'board.set-reporting', 'board.read-reply-photo', 'board.read-session-photo', 'board.session-links', 'board.link-session', 'board.hosts']) {
    expect(f.handlers.has(name), name).toBe(true)
  }
})

test('a session reports on its card only with the reporting flag; the coordinator always may; notes save as in Paseo', async () => {
  const f = setup()
  await f.request('board.scope', { kind: 'project', projectId: 'acme', enabled: true })
  await f.request('board.scope', { kind: 'coordinator', sessionId: 'coord' })
  const report = (id: string) => f.board.command('report', { kind: 'review', text: 'Done; see the diff.' }, id)
  expect(await report('writer')).toEqual({ isError: true, text: 'Board reporting is disabled for this session.' })
  expect((await f.request('board.snapshot', { fresh: true })).sessions.find((s: any) => s.id === 'writer').reporting).toBeUndefined()
  expect(await f.request('board.set-reporting', { sessionId: 'writer', enabled: true })).toEqual({ ok: true })
  expect(await report('writer')).toEqual({ text: 'Reported on your own Coordinator Board card.' })
  const snap = await f.request('board.snapshot', { fresh: true })
  expect(snap.sessions.find((s: any) => s.id === 'writer')).toMatchObject({ reporting: true })
  expect(snap.notes.writer).toMatchObject({ kind: 'review', origin: 'agent' })
  await f.request('board.set-reporting', { sessionId: 'writer', enabled: false })
  expect((await report('writer')).isError).toBe(true)
  expect((await report('coord')).isError).toBeUndefined()
  await expect(f.request('board.set-reporting', { sessionId: 'nobody', enabled: true })).rejects.toThrow('세션')
  const saved = await f.request('board.save-note', { sessionId: 'writer', kind: 'question', text: 'Which title?', expectedRevision: snap.notes.writer.revision })
  expect(saved).toMatchObject({ ok: true })
  await expect(f.request('board.save-note', { sessionId: 'nobody', kind: 'question', text: 'x', expectedRevision: 0 })).rejects.toThrow('세션')
})
