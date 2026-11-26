// The tracked reply queue on Orca: a busy recipient queues, a turn's end (src/orca/signals.ts) sends it once,
// a vanished recipient stops it, and a queued reply can be canceled.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from '../orca/cli'
import { readMarked } from '../orca/conversation'
import { fakeOrca } from '../orca/fixtures/fake-orca'
import { createFleet, type SessionId } from '../orca'
import { contribute } from './board'
import { rpcServer } from './rpc'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function setup() {
  const orca = fakeOrca([
    { id: 'coord', surface: 'terminal', state: 'working', updatedAt: 1, handle: 'term_c', title: 'Coordinator', project: 'acme' },
    { id: 'worker', surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_w', title: 'Worker', project: 'acme' }
  ])
  const dir = mkdtempSync(join(tmpdir(), 'tracked-queue-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'tracked-decisions.json'), JSON.stringify({ version: 1, items: [
    { source: 'ops', projectId: 'acme', id: 'deploy', title: 'Deploy window', where: 'manager', kind: 'answer' }
  ] }))
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir: dir, sleep: async () => {}, mailSender: async () => 'term_board' })
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>()
  const board = contribute(rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, dir)
  const request = async (name: string, input: unknown = {}) => { fleet.invalidate(); return handlers.get(name)!(input) as Promise<any> }
  await request('board.scope', { kind: 'project', projectId: 'acme', enabled: true })
  await request('board.scope', { kind: 'coordinator', sessionId: 'coord' })
  const item = (await request('board.snapshot', { fresh: true })).trackedDecisions.items[0]
  const resolve = (more: object = {}) => request('board.resolve-tracked-decision',
    { source: item.source, projectId: item.projectId, id: item.id, fingerprint: item.fingerprint, answer: 'Friday evening', recipientId: 'coord', ...more })
  const typed = () => orca.writes.filter(w => w[0] === 'terminal' && w[1] === 'send')
  return { orca, fleet, board, request, item, resolve, typed, dir }
}

test('a reply to a working recipient queues, and goes out once when its turn ends', async () => {
  const f = await setup()
  expect(await f.resolve()).toEqual({ status: 'queued' })
  expect(f.typed()).toEqual([])
  await f.board.signal({ kind: 'turn-ended', session: 'coord' as SessionId })
  expect(f.typed()).toEqual([])
  f.orca.find('coord')!.state = 'done'
  await f.board.signal({ kind: 'turn-ended', session: 'coord' as SessionId })
  expect(f.typed()).toHaveLength(1)
  const body = readMarked(f.orca.transcripts.get('coord')!.at(-1)!.text)!.body
  expect(body.startsWith('[Coordinator Board · ')).toBe(true)
  expect(body).toContain('Friday evening')
  await f.board.signal({ kind: 'turn-ended', session: 'coord' as SessionId })
  expect(await f.board.resumeWaiting()).toBe(false)
  expect(f.typed()).toHaveLength(1)
  const snap = await f.request('board.snapshot', { fresh: true })
  expect(snap.trackedDecisions.items).toEqual([])
  expect(snap.replyHistory.find((r: any) => r.title === 'Deploy window')).toMatchObject({ status: 'sent', recipientId: 'coord' })
})

test('a queued reply can be canceled, and stops when its recipient is gone', async () => {
  const f = await setup()
  await f.resolve()
  const queued = (await f.request('board.snapshot', { fresh: true })).trackedDecisions.items[0].queuedReply
  expect(queued).toMatchObject({ recipientId: 'coord', answer: 'Friday evening', stopped: false })
  expect(await f.request('board.cancel-queued-reply', { source: f.item.source, projectId: f.item.projectId, id: f.item.id, fingerprint: f.item.fingerprint, messageId: queued.messageId }))
    .toEqual({ canceled: true })
  expect(await f.resolve()).toEqual({ status: 'queued' })
  f.orca.sessions.splice(f.orca.sessions.findIndex(s => s.id === 'coord'), 1)
  await f.board.signal({ kind: 'gone', session: 'coord' as SessionId })
  expect(await f.board.resumeWaiting()).toBe(false)
  expect(f.typed()).toEqual([])
  const snap = await f.request('board.snapshot', { fresh: true })
  expect(snap.replyHistory.find((r: any) => r.title === 'Deploy window')).toMatchObject({ status: 'unsent' })
})

test('photos to a recipient are refused before anything is queued or sent', async () => {
  const f = await setup()
  const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' }
  await expect(f.resolve({ images: [image] })).rejects.toThrow('Photos cannot be sent yet')
  expect(f.typed()).toEqual([])
})

test('the coordinator\'s review command lists ledger checks from its own session and refuses anyone else', async () => {
  const f = await setup()
  writeFileSync(join(f.dir, 'tracked-decisions.json'), JSON.stringify({ version: 1, items: [
    { source: 'ops', projectId: 'acme', id: 'qa', title: 'QA pass', where: 'manager', kind: 'check', sessionId: 'worker' }
  ] }))
  const listed = JSON.parse((await f.board.command('review', {}, 'coord')).text)
  expect(listed).toEqual({ closed: [], reviewable: [{ key: expect.any(String), fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), title: 'QA pass', sessionId: 'worker' }] })
  await expect(f.board.command('review', {}, 'worker')).rejects.toThrow()
  expect(f.board.audience('review')).toBe('coordinator')
})
