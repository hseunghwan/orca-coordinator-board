// The only way the board sends anything to a session: a marked text, recorded in the outbox before
// the orca process starts, so a messageId is sent at most once and a lost answer is settled by
// reading the recipient's transcript instead of sending again.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OrcaCli, WriteResult } from './cli'
import { agentRead, boardHeader, photoLines, readMarked } from './conversation'
import type { SessionId, SessionRecord, TerminalHandle, World, WorkspaceRecord } from './view'

/**
 * Who a message is from. A person's text becomes a user turn. A session's (the coordinator answering a
 * board fact) and the board's own (a merge notice) carry who sent it: mail signed by a terminal to a chat,
 * typed input under boardHeader's line to a terminal, which shows no mail body. They never go without it.
 */
export type Sender = { kind: 'person' } | { kind: 'agent'; session: SessionId } | { kind: 'board' }

export interface Delivery {
  /** A UUID; the marker [cb:<messageId>] is put on the first line. */
  messageId: string
  to: SessionId
  text: string
  /** The mail subject on the mail route, and the context on a board-made message's header line. */
  subject: string
  from: Sender
  /** Phase 2 never queues into a working session. */
  whenWorking: 'refuse'
  /** The session's updatedAt the caller checked; any other value refuses with "changed". */
  unchangedSince?: number
  /** Absolute paths of image files the board saved for this message; each is named on a line after the marker. */
  photos?: readonly string[]
}

export type Route = 'terminal-input' | 'mail'

export type RefuseReason =
  | 'gone' | 'blocked' | 'waiting' | 'working' | 'changed' | 'asleep' | 'other-host'
  | 'too-long' | 'no-board-sender' | 'no-agent-sender' | 'rejected' | 'content-changed'

export type DeliveryOutcome =
  | { status: 'delivered'; route: Route; proof: 'cli' | 'mail-id' | 'transcript' | 'host-accepted' }
  /** It may have landed. Calling deliver() again with the same messageId only reconciles. */
  | { status: 'unconfirmed'; route: Route }
  /** Nothing left the worker; the same messageId may be sent later. */
  | { status: 'refused'; reason: RefuseReason; detail?: string }

/** terminal send passes the text as one argument. */
export const MAX_TERMINAL_TEXT = 30_000
const RECONCILE_DELAY_MS = 1_500
const KEEP_RECORDS = 500
/** How much of the head must agree; a terminal transcript keeps about 1 200 characters of an entry. */
const MATCH_CHARS = 400

export const stamp = (text: string, messageId: string, photos: readonly string[] = []) =>
  `[cb:${messageId}]\n${photos.length ? photoLines(photos) + '\n\n' : ''}${text}`

const squash = (text: string) => text.replace(/\r\n/g, '\n').trim()

/** The transcript entry is this message: same marker, and the heads agree as far as both go. */
export function isSameMessage(entry: string, messageId: string, stamped: string): boolean {
  const seen = readMarked(entry)
  const sent = readMarked(stamped)
  if (!seen || !sent || seen.messageId !== messageId.toLowerCase()) return false
  const a = squash(seen.body)
  const b = squash(sent.body)
  const n = Math.min(MATCH_CHARS, a.length, b.length)
  return a.slice(0, n) === b.slice(0, n) && (seen.cut || a.length >= Math.min(b.length, MATCH_CHARS))
}

/**
 * THE route table. First matching row wins.
 *
 *  | session                              | person          | agent, board    |
 *  | workspace on another host            | other-host      | other-host      |
 *  | chat                                 | mail            | mail            |
 *  | terminal with a live handle          | terminal-input  | terminal-input  |
 *  | terminal without a live handle       | asleep          | mail            |
 *
 * A terminal session stores a mail only as Orca's notice to run the check command, never its body
 * (observed 2026-11-26), so an agent's or the board's text to a live terminal is typed under
 * boardHeader's line. Mail needs a sender terminal: from a process outside every Orca terminal,
 * orchestration send refuses without --from (observed 2026-11-26). A person's mail and the board's go
 * from the board's own terminal; an agent's from that agent's terminal.
 */
export function chooseRoute(session: SessionRecord, workspace: WorkspaceRecord | undefined, from: Sender): Route | RefuseReason {
  if (workspace?.hostId && workspace.hostId !== 'local') return 'other-host'
  if (session.surface === 'chat') return 'mail'
  if (session.handle && session.livePty) return 'terminal-input'
  return from.kind === 'person' ? 'asleep' : 'mail'
}

/** The text a route carries: the marker, photo lines, then for a board-made message typed into a terminal the header line. */
export function wireText(d: Delivery, route: Route): string {
  const body = route === 'terminal-input' && d.from.kind !== 'person'
    ? boardHeader(d.from.kind === 'agent' ? d.from.session : 'board', { subject: d.subject }) + '\n' + d.text
    : d.text
  return stamp(body, d.messageId, d.photos)
}
const digestOf = (text: string) => createHash('sha256').update(text).digest('hex')

/** The terminal a mail is signed by: the board's own, or the sending agent's live local one. */
async function signer(from: Sender, world: World, boardSender: (() => Promise<string | null>) | undefined): Promise<{ handle: string } | { refuse: RefuseReason }> {
  if (from.kind !== 'agent') {
    const handle = await boardSender?.().catch(() => null)
    return handle ? { handle } : { refuse: 'no-board-sender' }
  }
  const agent = world.sessions.get(from.session)
  const ws = agent && world.workspaces.get(agent.worktree)
  if (!agent?.handle || !agent.livePty || (ws?.hostId && ws.hostId !== 'local')) return { refuse: 'no-agent-sender' }
  return { handle: agent.handle }
}

/** Paseo's canReceiveBoardInput on Orca states: only a finished turn takes input. */
export function stateRefusal(session: SessionRecord): RefuseReason | null {
  return session.state === 'done' ? null : session.state
}

const outboxRecord = z.object({
  messageId: z.string(),
  to: z.string(),
  route: z.enum(['terminal-input', 'mail']),
  digest: z.string(),
  /** The stamped text: reconciliation compares it, and a cut transcript entry is restored from it. */
  text: z.string(),
  state: z.enum(['attempting', 'delivered', 'unconfirmed']),
  at: z.number(),
  // 'host-accepted': records written by version 0.2.0's focus-and-type path.
  proof: z.enum(['cli', 'mail-id', 'transcript', 'host-accepted']).optional(),
  mailId: z.string().optional(),
  /** Orca's id for an ambiguous write; kept for diagnosis, never used to send again. */
  retryRequest: z.string().optional()
})
export type OutboxRecord = z.output<typeof outboxRecord>
const outboxFile = z.object({ records: z.record(z.string(), outboxRecord) })

export class Outbox {
  constructor(private readonly path: string) {}
  read(): Record<string, OutboxRecord> {
    try {
      return outboxFile.parse(JSON.parse(readFileSync(this.path, 'utf8'))).records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }
  get(messageId: string): OutboxRecord | undefined {
    return this.read()[messageId]
  }
  change(edit: (records: Record<string, OutboxRecord>) => void): void {
    const records = this.read()
    edit(records)
    const kept = Object.values(records).sort((a, b) => b.at - a.at).slice(0, KEEP_RECORDS)
    const dir = join(this.path, '..')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = this.path + '.' + randomUUID()
    try {
      writeFileSync(temp, JSON.stringify({ records: Object.fromEntries(kept.map((r) => [r.messageId, r])) }), { flag: 'wx', mode: 0o600 })
      renameSync(temp, this.path)
    } finally {
      rmSync(temp, { force: true })
    }
  }
}

export interface DeliverDeps {
  cli: OrcaCli
  view(options: { maxAgeMs: number }): Promise<World>
  /** The board's data folder: outbox.json and the mail body files. */
  dataDir: string
  /** The board's own terminal to mail from (--from); null when there is none to use. */
  mailSender?: () => Promise<string | null>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function createDeliver(deps: DeliverDeps) {
  const outbox = new Outbox(join(deps.dataDir, 'outbox.json'))
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }
  const settle = (messageId: string, patch: Partial<OutboxRecord>) =>
    outbox.change((records) => { if (records[messageId]) Object.assign(records[messageId], patch) })

  async function reconcile(record: OutboxRecord): Promise<DeliveryOutcome> {
    const read = await deps.cli.read('agent read', ['orca_session_id:' + record.to, '--limit', '100'], (r) => agentRead.parse(r))
      .catch(() => null)
    const found = read?.entries.some((e) => e.kind === 'message' && e.role === 'user' && !!e.text && isSameMessage(e.text, record.messageId, record.text))
    if (found) {
      settle(record.messageId, { state: 'delivered', proof: 'transcript' })
      return { status: 'delivered', route: record.route, proof: 'transcript' }
    }
    settle(record.messageId, { state: 'unconfirmed' })
    return { status: 'unconfirmed', route: record.route }
  }

  async function send(d: Delivery, route: Route, session: SessionRecord, text: string, from: string | null): Promise<WriteResult> {
    if (route === 'terminal-input') {
      return deps.cli.write('terminal send', ['--terminal', session.handle!, '--text', text, '--enter', '--wait-submit', '10'])
    }
    const dir = join(deps.dataDir, 'mail')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const body = join(dir, d.messageId + '.txt')
    writeFileSync(body, text, { mode: 0o600 })
    try {
      return await deps.cli.write('orchestration send', [
        '--to', 'orca_session_id:' + d.to, ...(from ? ['--from', from] : []), '--type', d.from.kind === 'person' ? 'question' : 'status', '--subject', d.subject.replace(/\s+/g, ' ').slice(0, 120), '--body-file', body
      ])
    } finally {
      rmSync(body, { force: true })
    }
  }

  async function deliverNow(d: Delivery): Promise<DeliveryOutcome> {
    const earlier = outbox.get(d.messageId)
    if (earlier) {
      if (earlier.digest !== digestOf(wireText(d, earlier.route))) return { status: 'refused', reason: 'content-changed' }
      if (earlier.state === 'delivered') return { status: 'delivered', route: earlier.route, proof: earlier.proof ?? 'cli' }
      return reconcile(earlier)
    }
    const world = await deps.view({ maxAgeMs: 0 })
    const session = world.sessions.get(d.to)
    if (!session) return { status: 'refused', reason: 'gone' }
    const busy = stateRefusal(session)
    if (busy) return { status: 'refused', reason: busy }
    if (d.unchangedSince !== undefined && session.updatedAt !== d.unchangedSince) return { status: 'refused', reason: 'changed' }
    const route = chooseRoute(session, world.workspaces.get(session.worktree), d.from)
    if (route !== 'terminal-input' && route !== 'mail') return { status: 'refused', reason: route }
    const text = wireText(d, route)
    const digest = digestOf(text)
    if (route === 'terminal-input' && text.length > MAX_TERMINAL_TEXT) return { status: 'refused', reason: 'too-long' }
    const signed = route === 'mail' ? await signer(d.from, world, deps.mailSender) : null
    if (signed && 'refuse' in signed) return { status: 'refused', reason: signed.refuse }
    const from = signed?.handle ?? null

    const record: OutboxRecord = { messageId: d.messageId, to: d.to, route, digest, text, state: 'attempting', at: now() }
    outbox.change((records) => { records[d.messageId] = record })
    const result = await send(d, route, session, text, from)
    if (result.kind === 'ok') {
      const mailId = (result.result as { messageId?: unknown } | null)?.messageId
      const proof = typeof mailId === 'string' ? 'mail-id' : 'cli'
      settle(d.messageId, { state: 'delivered', proof, ...(typeof mailId === 'string' ? { mailId } : {}) })
      return { status: 'delivered', route, proof }
    }
    if (result.kind === 'refused') {
      outbox.change((records) => { delete records[d.messageId] })
      return { status: 'refused', reason: 'rejected', detail: result.message }
    }
    settle(d.messageId, { state: 'unconfirmed', ...(result.retryRequest ? { retryRequest: result.retryRequest } : {}) })
    await sleep(RECONCILE_DELAY_MS)
    return reconcile({ ...record, state: 'unconfirmed' })
  }

  return {
    deliver: (d: Delivery) => serial(() => deliverNow(d)),
    /** What became of a messageId: null when it was never attempted, so nothing of it was sent. Never sends. */
    reconcile: (messageId: string) => serial(async (): Promise<DeliveryOutcome | null> => {
      const record = outbox.get(messageId)
      if (!record) return null
      if (record.state === 'delivered') return { status: 'delivered', route: record.route, proof: record.proof ?? 'cli' }
      return reconcile(record)
    }),
    /** The stamped text sent under this id, for restoring a transcript entry the terminal cut. */
    sentText: (messageId: string) => outbox.get(messageId)?.text
  }
}
