import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from './cli'
import { excerpt } from '../server/conversation'
import { readMarked, TRUNCATED, unframe } from './conversation'
import { isSameMessage, stamp } from './deliver'
import { fakeOrca, TERMINAL_CUT, type FakeSession } from './fixtures/fake-orca'
import { createFleet, type Delivery, type SessionId } from './index'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const CHAT = 'c4a70000-0000-4000-8000-00000000000c' as SessionId
const TERM = 'c4a70000-0000-4000-8000-00000000000d' as SessionId
const ID = (n: number) => `0b0a0000-0000-4000-8000-${String(n).padStart(12, '0')}`

function setup(extra: FakeSession[] = [], focusAndType?: (handle: string, text: string) => Promise<boolean>) {
  const orca = fakeOrca([
    { id: CHAT, surface: 'chat', state: 'done', updatedAt: 10, title: 'Pick a layout' },
    { id: TERM, surface: 'terminal', state: 'done', updatedAt: 20, handle: 'term_d', title: 'Tag the release' },
    ...extra
  ])
  const dataDir = mkdtempSync(join(tmpdir(), 'board-deliver-'))
  dirs.push(dataDir)
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir, sleep: async () => {}, focusAndType })
  const send = (to: string, text: string, n = 1, more: Partial<Delivery> = {}) =>
    fleet.deliver({ messageId: ID(n), to: to as SessionId, text, subject: 'Pick a layout', from: { kind: 'person' }, whenWorking: 'refuse', ...more })
  const outbox = () => JSON.parse(readFileSync(join(dataDir, 'outbox.json'), 'utf8')).records
  return { orca, fleet, send, outbox, dataDir }
}

test('a chat gets mail whose body starts with the marker, and the transcript entry reads back without framing', async () => {
  const f = setup()
  expect(await f.send(CHAT, 'Use the grid.')).toEqual({ status: 'delivered', route: 'mail', proof: 'mail-id' })
  const args = f.orca.writes[0]
  expect(args.slice(0, 6)).toEqual(['orchestration', 'send', '--to', 'orca_session_id:' + CHAT, '--type', 'question'])
  expect(args).not.toContain('--from')
  const entry = f.orca.transcripts.get(CHAT)!.at(-1)!.text
  expect(entry.split('\n')[0]).toMatch(/^──── From: /)
  expect(unframe(entry)).toBe(stamp('Use the grid.', ID(1)))
  expect(readMarked(entry)).toEqual({ messageId: ID(1), body: 'Use the grid.', cut: false })
})

test('a repeated messageId never sends again: delivered stays delivered, a changed text is refused', async () => {
  const f = setup()
  await f.send(CHAT, 'Use the grid.')
  expect(await f.send(CHAT, 'Use the grid.')).toMatchObject({ status: 'delivered' })
  expect(await f.send(CHAT, 'Use the list.')).toEqual({ status: 'refused', reason: 'content-changed' })
  expect(f.orca.writes).toHaveLength(1)
})

test('the outbox says attempting before the orca process starts', async () => {
  const f = setup()
  const seen: string[] = []
  f.orca.behavior.onWrite = () => { seen.push(f.outbox()[ID(1)].state) }
  await f.send(TERM, 'Tag 3.0.0.')
  expect(seen).toEqual(['attempting'])
  expect(f.outbox()[ID(1)].state).toBe('delivered')
})

test('a terminal gets the text typed with Enter, waiting for the submit', async () => {
  const f = setup()
  expect(await f.send(TERM, 'Tag 3.0.0.')).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'cli' })
  expect(f.orca.writes[0]).toEqual(['terminal', 'send', '--terminal', 'term_d', '--text', stamp('Tag 3.0.0.', ID(1)), '--enter', '--wait-submit', '10', '--json'])
})

test('a lost answer is settled from the transcript, even when the terminal cut the entry, and never sent twice', async () => {
  const f = setup()
  f.orca.behavior.loseAnswer = true
  const long = 'Tag 3.0.0 and write the notes.\n' + 'x'.repeat(3000)
  expect(await f.send(TERM, long)).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'transcript' })
  const kept = f.orca.transcripts.get(TERM)!.at(-1)!.text
  expect(kept.length).toBeGreaterThan(TERMINAL_CUT)
  expect(await f.send(TERM, long)).toMatchObject({ status: 'delivered' })
  expect(f.orca.writes).toHaveLength(1)
})

test('an answer lost and not in the transcript stays unconfirmed; asking again only reads, and finds it once it lands', async () => {
  const f = setup()
  f.orca.behavior.loseAnswer = true
  f.orca.behavior.dropText = true
  expect(await f.send(CHAT, 'Use the grid.')).toEqual({ status: 'unconfirmed', route: 'mail' })
  expect(await f.send(CHAT, 'Use the grid.')).toEqual({ status: 'unconfirmed', route: 'mail' })
  expect(await f.fleet.reconcile(ID(1))).toEqual({ status: 'unconfirmed', route: 'mail' })
  expect(await f.fleet.reconcile(ID(9))).toBeNull()
  f.orca.say(CHAT, 'user', stamp('Use the grid.', ID(1)))
  expect(await f.fleet.reconcile(ID(1))).toEqual({ status: 'delivered', route: 'mail', proof: 'transcript' })
  expect(f.orca.writes).toHaveLength(1)
})

test('blocked, waiting, working, changed, asleep, other-host and too-long are refused before anything is written', async () => {
  const f = setup([
    { id: ID(11), surface: 'terminal', state: 'blocked', updatedAt: 1, handle: 'term_b' },
    { id: ID(12), surface: 'terminal', state: 'waiting', updatedAt: 1, handle: 'term_w' },
    { id: ID(13), surface: 'chat', state: 'working', updatedAt: 1 },
    { id: ID(14), surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_z', livePty: false },
    { id: ID(15), surface: 'chat', state: 'done', updatedAt: 1, hostId: 'runtime:remote', project: 'far' }
  ])
  expect(await f.send(ID(11), 'x')).toEqual({ status: 'refused', reason: 'blocked' })
  expect(await f.send(ID(12), 'x')).toEqual({ status: 'refused', reason: 'waiting' })
  expect(await f.send(ID(13), 'x')).toEqual({ status: 'refused', reason: 'working' })
  expect(await f.send(ID(14), 'x')).toEqual({ status: 'refused', reason: 'asleep' })
  expect(await f.send(ID(15), 'x')).toEqual({ status: 'refused', reason: 'other-host' })
  expect(await f.send(ID(16), 'x')).toEqual({ status: 'refused', reason: 'gone' })
  expect(await f.send(TERM, 'x'.repeat(30_000))).toEqual({ status: 'refused', reason: 'too-long' })
  expect(await f.send(CHAT, 'x', 1, { unchangedSince: 9 })).toEqual({ status: 'refused', reason: 'changed' })
  expect(f.orca.writes).toEqual([])
  expect(await f.send(CHAT, 'x', 1, { unchangedSince: 10 })).toMatchObject({ status: 'delivered' })
})

test('outside the focused workspace a person send falls back to focus and type; without it the refusal frees the id', async () => {
  const typed: [string, string][] = []
  const f = setup([], async (handle, text) => { typed.push([handle, text]); return true })
  f.orca.behavior.outsideFocus = true
  expect(await f.send(TERM, 'Tag 3.0.0.')).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'host-accepted' })
  expect(typed).toEqual([['term_d', stamp('Tag 3.0.0.', ID(1))]])

  const g = setup()
  g.orca.behavior.outsideFocus = true
  expect(await g.send(TERM, 'Tag 3.0.0.')).toEqual({ status: 'refused', reason: 'needs-focus', detail: 'terminal is outside the active worktree' })
  expect(g.outbox()[ID(1)]).toBeUndefined()
  g.orca.behavior.outsideFocus = false
  expect(await g.send(TERM, 'Tag 3.0.0.')).toMatchObject({ status: 'delivered' })
})

test('the board reads its own message back with its id, and a cut one whole from the outbox', async () => {
  const f = setup()
  const text = '[Coordinator Board · acme · Tag the release]\n{}\n\n' + 'Tag 3.0.0. '.repeat(300)
  await f.send(TERM, text)
  f.orca.say(TERM, 'assistant', 'Tagged.')
  const page = await f.fleet.paseo.agents.ref(TERM).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 48 })
  expect(page.entries[0].item).toEqual({ type: 'user_message', text, messageId: ID(1) })
  expect(excerpt(page).replies?.get(ID(1))).toBe('Tagged.')
})

test('matching wants the same marker and the same head', () => {
  const sent = stamp('Use the grid.', ID(1))
  expect(isSameMessage(sent, ID(1), sent)).toBe(true)
  expect(isSameMessage(sent, ID(2), sent)).toBe(false)
  expect(isSameMessage(stamp('Use the list.', ID(1)), ID(1), sent)).toBe(false)
  expect(isSameMessage('Use the grid.', ID(1), sent)).toBe(false)
  const long = stamp('y'.repeat(2000), ID(1))
  expect(isSameMessage(long.slice(0, TERMINAL_CUT) + TRUNCATED, ID(1), long)).toBe(true)
})
