import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCli } from './cli'
import { excerpt } from '../server/conversation'
import { readMarked, TRUNCATED, unframe } from './conversation'
import { chooseRoute, isSameMessage, stamp, wireText, type Sender } from './deliver'
import { fakeOrca, TERMINAL_CUT, type FakeSession } from './fixtures/fake-orca'
import { createFleet, type Delivery, type SessionId } from './index'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const CHAT = 'c4a70000-0000-4000-8000-00000000000c' as SessionId
const TERM = 'c4a70000-0000-4000-8000-00000000000d' as SessionId
const ID = (n: number) => `0b0a0000-0000-4000-8000-${String(n).padStart(12, '0')}`

function setup(extra: FakeSession[] = []) {
  const orca = fakeOrca([
    { id: CHAT, surface: 'chat', state: 'done', updatedAt: 10, title: 'Pick a layout' },
    { id: TERM, surface: 'terminal', state: 'done', updatedAt: 20, handle: 'term_d', title: 'Tag the release' },
    ...extra
  ])
  const dataDir = mkdtempSync(join(tmpdir(), 'board-deliver-'))
  dirs.push(dataDir)
  const fleet = createFleet(createCli(orca.runner), Date.now, { dataDir, sleep: async () => {}, mailSender: async () => 'term_board' })
  const send = (to: string, text: string, n = 1, more: Partial<Delivery> = {}) =>
    fleet.deliver({ messageId: ID(n), to: to as SessionId, text, subject: 'Pick a layout', from: { kind: 'person' }, whenWorking: 'refuse', ...more })
  const outbox = () => JSON.parse(readFileSync(join(dataDir, 'outbox.json'), 'utf8')).records
  return { orca, fleet, send, outbox, dataDir }
}

test('a chat gets mail whose body starts with the marker, and the transcript entry reads back without framing', async () => {
  const f = setup()
  expect(await f.send(CHAT, 'Use the grid.')).toEqual({ status: 'delivered', route: 'mail', proof: 'mail-id' })
  const args = f.orca.writes[0]
  expect(args.slice(0, 8)).toEqual(['orchestration', 'send', '--to', 'orca_session_id:' + CHAT, '--from', 'term_board', '--type', 'question'])
  const entry = f.orca.transcripts.get(CHAT)!.at(-1)!.text
  expect(entry.split('\n')[0]).toMatch(/^──── From: /)
  expect(unframe(entry)).toBe(stamp('Use the grid.', ID(1)))
  expect(readMarked(entry)).toEqual({ messageId: ID(1), body: 'Use the grid.', cut: false })
})

test('without a board terminal to mail from, a chat send is refused before anything is written', async () => {
  const f = setup()
  const dataDir = mkdtempSync(join(tmpdir(), 'board-deliver-'))
  dirs.push(dataDir)
  const bare = createFleet(createCli(f.orca.runner), Date.now, { dataDir, sleep: async () => {}, mailSender: async () => null })
  expect(await bare.deliver({ messageId: ID(1), to: CHAT, text: 'x', subject: 's', from: { kind: 'person' }, whenWorking: 'refuse' }))
    .toEqual({ status: 'refused', reason: 'no-board-sender' })
  expect(f.orca.writes).toEqual([])
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

test('the route table: a chat always gets mail, a live terminal always typed input, a sleeping one mail only from the board or an agent', () => {
  const session = (surface: 'chat' | 'terminal', live: boolean) =>
    ({ id: TERM, surface, state: 'done', updatedAt: 1, ...(surface === 'terminal' ? { handle: 'term_d', livePty: live } : {}) }) as never
  const senders: Sender[] = [{ kind: 'person' }, { kind: 'agent', session: CHAT }, { kind: 'board' }]
  const row = (s: never, ws?: never) => senders.map((from) => chooseRoute(s, ws, from))
  expect(row(session('terminal', true), { hostId: 'ssh-1' } as never)).toEqual(['other-host', 'other-host', 'other-host'])
  expect(row(session('chat', true))).toEqual(['mail', 'mail', 'mail'])
  expect(row(session('terminal', true))).toEqual(['terminal-input', 'terminal-input', 'terminal-input'])
  expect(row(session('terminal', false))).toEqual(['asleep', 'mail', 'mail'])
})

test('an agent sender types into a terminal under the board header, which reads back as that agent\'s message', async () => {
  const COORD = ID(20) as SessionId
  const f = setup([{ id: COORD, surface: 'terminal', state: 'working', updatedAt: 1, handle: 'term_coord', title: 'Coordinator', livePty: false }])
  const fact = JSON.stringify({ type: 'coordinator-board.fact', answer: 'Managed project: acme.' })
  const d = { from: { kind: 'agent', session: COORD } } as const
  expect(await f.send(TERM, fact, 1, d)).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'cli' })
  const typed = f.orca.writes[0][f.orca.writes[0].indexOf('--text') + 1]
  expect(f.orca.writes[0].slice(0, 4)).toEqual(['terminal', 'send', '--terminal', 'term_d'])
  expect(typed.split('\n').slice(0, 3)).toEqual(['[cb:' + ID(1) + ']', '[coordinator-board] ' + JSON.stringify({ from: COORD, subject: 'Pick a layout' }), fact])
  expect(f.orca.mailbox).toEqual([])
  f.orca.say(TERM, 'assistant', 'Thanks.')
  const page = await f.fleet.paseo.agents.ref(TERM).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 48 })
  expect(page.entries[0].item).toEqual({ type: 'tool_call', name: 'agent_message', status: 'completed', callId: 'paseo-agent-message:' + ID(1),
    agentMessage: { event: 'message', sender: { id: COORD }, text: fact } })
  expect(excerpt(page).deliveries).toEqual([{ id: ID(1), sender: COORD, bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }])
  expect(await f.send(TERM, fact, 1, d)).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'cli' })
  expect(f.orca.writes).toHaveLength(1)
})

test('a board message typed into a terminal whose answer was lost is settled from the transcript, never typed twice', async () => {
  const f = setup()
  f.orca.behavior.loseAnswer = true
  const d = { from: { kind: 'board' } } as const
  expect(await f.send(TERM, 'PR #7 merged.', 1, d)).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'transcript' })
  f.orca.behavior.loseAnswer = false
  expect(await f.send(TERM, 'PR #7 merged.', 1, d)).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'transcript' })
  expect(f.orca.writes).toHaveLength(1)
  expect(f.outbox()[ID(1)].text).toBe(wireText({ messageId: ID(1), to: TERM, text: 'PR #7 merged.', subject: 'Pick a layout', from: d.from, whenWorking: 'refuse' }, 'terminal-input'))
  const page = await f.fleet.paseo.agents.ref(TERM).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 48 })
  expect(page.entries[0].item).toMatchObject({ type: 'tool_call', name: 'agent_message', agentMessage: { sender: { id: 'board' }, text: 'PR #7 merged.' } })
})

test('a board message to a busy terminal or one Orca refuses leaves nothing behind, so it may be sent later', async () => {
  const f = setup()
  f.orca.find(TERM)!.state = 'working'
  expect(await f.send(TERM, 'PR #7 merged.', 1, { from: { kind: 'board' } })).toEqual({ status: 'refused', reason: 'working' })
  f.orca.find(TERM)!.state = 'done'
  f.orca.behavior.refuseWith = 'terminal closed'
  expect(await f.send(TERM, 'PR #7 merged.', 1, { from: { kind: 'board' } })).toMatchObject({ status: 'refused', reason: 'rejected' })
  expect(f.outbox()).toEqual({})
  f.orca.behavior.refuseWith = null
  expect(await f.send(TERM, 'PR #7 merged.', 1, { from: { kind: 'board' } })).toEqual({ status: 'delivered', route: 'terminal-input', proof: 'cli' })
})
test('an agent\'s mail to a chat session reads as that agent\'s message', async () => {
  const COORD = ID(20) as SessionId
  const f = setup([{ id: COORD, surface: 'terminal', state: 'working', updatedAt: 1, handle: 'term_coord', title: 'Coordinator' }])
  const fact = JSON.stringify({ type: 'coordinator-board.fact', answer: 'Managed project: acme.' })
  expect(await f.send(CHAT, fact, 1, { from: { kind: 'agent', session: COORD } })).toEqual({ status: 'delivered', route: 'mail', proof: 'mail-id' })
  f.orca.say(CHAT, 'assistant', 'Thanks.')
  const page = await f.fleet.paseo.agents.ref(CHAT).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 48 })
  expect(page.entries[0].item).toEqual({ type: 'tool_call', name: 'agent_message', status: 'completed', callId: 'paseo-agent-message:' + ID(1),
    agentMessage: { event: 'message', sender: { id: COORD }, text: fact } })
  expect(excerpt(page).deliveries).toEqual([{ id: ID(1), sender: COORD, bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }])
})

test('an agent without a live local terminal cannot sign mail, and nothing goes out unsigned', async () => {
  const f = setup([
    { id: ID(21), surface: 'chat', state: 'done', updatedAt: 1 },
    { id: ID(22), surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_gone', livePty: false }
  ])
  for (const session of [ID(21), ID(22), ID(23)]) {
    expect(await f.send(CHAT, 'fact', 1, { from: { kind: 'agent', session: session as SessionId } })).toEqual({ status: 'refused', reason: 'no-agent-sender' })
  }
  expect(f.orca.writes).toEqual([])
})

test('the board sender mails from the board terminal, which is no session, so a chat reads it as a user turn', async () => {
  const f = setup()
  expect(await f.send(CHAT, 'PR #7 merged.', 1, { from: { kind: 'board' } })).toEqual({ status: 'delivered', route: 'mail', proof: 'mail-id' })
  expect(f.orca.writes[0].slice(4, 8)).toEqual(['--from', 'term_board', '--type', 'status'])
  const page = await f.fleet.paseo.agents.ref(CHAT).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 48 })
  expect(page.entries[0].item).toEqual({ type: 'user_message', text: 'PR #7 merged.', messageId: ID(1) })
})
