// The only way the board sends anything to a session: a marked text, recorded in the outbox before
// the orca process starts, so a messageId is sent at most once and a lost answer is settled by
// reading the recipient's transcript instead of sending again.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { OrcaCli, WriteResult } from './cli'
import { agentRead, readMarked } from './conversation'
import type { SessionId, SessionRecord, TerminalHandle, World, WorkspaceRecord } from './view'

/** Who pressed send. Agent and board senders come with the coordinator. */
export type Sender = { kind: 'person' }

export interface Delivery {
  /** A UUID; the marker [cb:<messageId>] is put on the first line. */
  messageId: string
  to: SessionId
  text: string
  /** The mail subject on the chat route. */
  subject: string
  from: Sender
  /** Phase 2 never queues into a working session. */
  whenWorking: 'refuse'
  /** The session's updatedAt the caller checked; any other value refuses with "changed". */
  unchangedSince?: number
}

export type Route = 'terminal-input' | 'mail'

export type RefuseReason =
  | 'gone' | 'blocked' | 'waiting' | 'working' | 'changed' | 'asleep' | 'other-host'
  | 'too-long' | 'needs-focus' | 'no-board-sender' | 'rejected' | 'content-changed'

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

export const stamp = (text: string, messageId: string) => `[cb:${messageId}]\n${text}`

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
 * THE route table. A person's send becomes a user turn: typed into a terminal agent, or mailed to a
 * chat. First matching row wins.
 *
 *  | session                              | person          |
 *  | workspace on another host            | other-host      |
 *  | terminal without a live handle       | asleep          |
 *  | terminal                             | terminal-input  |
 *  | chat                                 | mail            |
 *
 * Mail needs a sender terminal: from a process outside every Orca terminal, orchestration send
 * refuses without --from (observed 2026-11-26), so the board mails from its own terminal.
 */
export function chooseRoute(session: SessionRecord, workspace: WorkspaceRecord | undefined, _from: Sender): Route | RefuseReason {
  if (workspace?.hostId && workspace.hostId !== 'local') return 'other-host'
  if (session.surface === 'chat') return 'mail'
  return session.handle && session.livePty ? 'terminal-input' : 'asleep'
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

/** Orca refuses to type into a terminal outside the focused workspace. */
const OUTSIDE_FOCUS = /outside (?:the )?active (?:worktree|workspace)|not (?:in )?(?:the )?focused workspace/i

export interface DeliverDeps {
  cli: OrcaCli
  view(options: { maxAgeMs: number }): Promise<World>
  /** The board's data folder: outbox.json and the mail body files. */
  dataDir: string
  /**
   * v0.1's path for a terminal outside the focused workspace: show it, then type. Only a person's
   * send uses it, because it moves the window. Resolves whether the host accepted the text.
   */
  focusAndType?: (handle: TerminalHandle, text: string) => Promise<boolean>
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
        '--to', 'orca_session_id:' + d.to, ...(from ? ['--from', from] : []), '--type', 'question', '--subject', d.subject.replace(/\s+/g, ' ').slice(0, 120), '--body-file', body
      ])
    } finally {
      rmSync(body, { force: true })
    }
  }

  async function deliverNow(d: Delivery): Promise<DeliveryOutcome> {
    const text = stamp(d.text, d.messageId)
    const digest = createHash('sha256').update(text).digest('hex')
    const earlier = outbox.get(d.messageId)
    if (earlier) {
      if (earlier.digest !== digest) return { status: 'refused', reason: 'content-changed' }
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
    if (route === 'terminal-input' && text.length > MAX_TERMINAL_TEXT) return { status: 'refused', reason: 'too-long' }
    const from = route === 'mail' ? await deps.mailSender?.().catch(() => null) ?? null : null
    if (route === 'mail' && !from) return { status: 'refused', reason: 'no-board-sender' }

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
      if (route === 'terminal-input' && d.from.kind === 'person' && deps.focusAndType && OUTSIDE_FOCUS.test(result.message)) {
        let accepted: boolean
        try {
          accepted = await deps.focusAndType(session.handle!, text)
        } catch {
          settle(d.messageId, { state: 'unconfirmed' })
          return { status: 'unconfirmed', route }
        }
        if (accepted) {
          settle(d.messageId, { state: 'delivered', proof: 'host-accepted' })
          return { status: 'delivered', route, proof: 'host-accepted' }
        }
        outbox.change((records) => { delete records[d.messageId] })
        return { status: 'refused', reason: 'needs-focus' }
      }
      outbox.change((records) => { delete records[d.messageId] })
      return { status: 'refused', reason: OUTSIDE_FOCUS.test(result.message) ? 'needs-focus' : 'rejected', detail: result.message }
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
