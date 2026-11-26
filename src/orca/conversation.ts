// `orca agent read` as the Paseo timeline page that the verbatim conversation.ts excerpt() reads.
import { z } from 'zod'
import type { SessionRecord } from './view'

export const agentRead = z.object({
  orcaSessionId: z.string(),
  entries: z.array(z.object({ kind: z.string(), role: z.string().nullish(), text: z.string().nullish() })),
  state: z.enum(['working', 'blocked', 'waiting', 'done']).nullish()
})
export type AgentRead = z.output<typeof agentRead>

/** The Paseo item shapes excerpt() reads. Orca yields only the two text kinds. */
export type TimelineItem =
  | { type: 'user_message'; text: string; messageId?: string; clientMessageId?: string }
  | { type: 'assistant_message'; text: string }
  | { type: 'tool_call'; callId: string; name: string; status: string; agentMessage?: { event: 'message'; sender: { id: string }; text: string } }
export interface TimelinePage {
  epoch: string
  entries: { item: TimelineItem; seqEnd: number; timestamp?: string }[]
  /** Set when the read shows an unfinished turn: excerpt() then refuses, as for a Paseo timeline gap. */
  gap?: boolean
  error?: string | null
  staleCursor?: boolean
}

/**
 * A user entry as Paseo would show it. Mail signed by another session's terminal is that agent's
 * message (Paseo's agent-message tool call, with the board's marker as its id); anything else is a
 * user message, with the board's marker as its messageId.
 */
function userItem(text: string, sentText: (messageId: string) => string | undefined, senderOf: (handle: string) => string | undefined): TimelineItem {
  // Paseo's excerpt counts a heartbeat as input that is not a person's turn, which is what this notice is.
  if (MAIL_NOTICE.test(text.trim())) return { type: 'tool_call', name: 'heartbeat', status: 'completed', callId: 'orca-mail-notice' }
  const marked = readMarked(text)
  const full = marked?.cut ? readMarked(sentText(marked.messageId) ?? '')?.body : undefined
  const body = marked ? (full?.startsWith(marked.body) ? full : marked.body) : null
  const handle = MAIL_SENDER.exec(text.replace(/\r\n/g, '\n').split('\n', 1)[0])?.[1]
  const sender = handle ? senderOf(handle) : undefined
  if (sender) {
    return { type: 'tool_call', name: 'agent_message', status: 'completed', callId: 'paseo-agent-message:' + (marked?.messageId ?? 'unmarked'),
      agentMessage: { event: 'message', sender: { id: sender }, text: body ?? unframe(text) } }
  }
  if (!marked) return { type: 'user_message', text }
  return { type: 'user_message', text: body!, messageId: marked.messageId }
}

/** What a terminal transcript read puts after a long entry it cut (about 1 200 characters kept). */
export const TRUNCATED = '\n… (truncated)'

const MARKER = /^\[cb:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/i
const MAIL_HEAD = /^─+ From: .* ─+$/
const MAIL_SENDER = /^─+ From: .* \((term_[^()\s]+)\) \([^()]*\) ─+$/
const MAIL_RULE = /^─+$/
const MAIL_REPLY = /^\[Reply: orca orchestration reply /
/**
 * A terminal agent does not get the mail itself: Orca types this notice, and the body reaches the agent
 * only through the check command's output, never as a transcript message (observed 2026-11-26, Orca 1.4.277).
 */
const MAIL_NOTICE = /^You have \d+ orchestration messages?\. Run `orca orchestration check --terminal term_[^`\s]+`\.$/

/** A transcript user entry without Orca's mail framing (From line, Subject line, Reply hint, closing rule). */
export function unframe(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (!MAIL_HEAD.test(lines[0] ?? '')) return text.replace(/\r\n/g, '\n')
  lines.shift()
  if (lines[0]?.startsWith('Subject: ')) lines.shift()
  while (lines.length && !lines[0].trim()) lines.shift()
  while (lines.length && (!lines.at(-1)!.trim() || MAIL_RULE.test(lines.at(-1)!) || MAIL_REPLY.test(lines.at(-1)!))) lines.pop()
  return lines.join('\n')
}

const PHOTO_LINE = /^\[사진 \d+\] \S/

/**
 * Orca cannot attach an image to a message, so a board message names each image file on its own line
 * right after the marker, where a cut transcript entry still keeps them, and a blank line ends them.
 */
export function photoLines(paths: readonly string[]): string {
  return paths.map((path, i) => `[사진 ${i + 1}] ${path}`).join('\n')
}

/** The board message a transcript user entry carries, if it starts with a marker. The body leaves out the photo lines. */
export function readMarked(entry: string): { messageId: string; body: string; cut: boolean } | null {
  let text = unframe(entry)
  const cut = text.endsWith(TRUNCATED)
  if (cut) text = text.slice(0, -TRUNCATED.length)
  const newline = text.indexOf('\n')
  const first = (newline < 0 ? text : text.slice(0, newline)).trim()
  const marker = MARKER.exec(first)
  if (!marker) return null
  const lines = newline < 0 ? [] : text.slice(newline + 1).split('\n')
  let photos = 0
  while (photos < lines.length && PHOTO_LINE.test(lines[photos])) photos++
  const body = photos && lines[photos] === '' ? lines.slice(photos + 1) : lines
  return { messageId: marker[1].toLowerCase(), body: body.join('\n'), cut }
}

/**
 * Only text turns, and mail another session signed, which Paseo shows as an agent-message tool
 * call: excerpt() hashes text turns and records agent messages as deliveries and later input.
 *
 * seqEnd counts the text turns after an entry, so the same text history gives the same evidenceId
 * and a new turn changes it. The epoch names the session, as Paseo's epoch names a timeline.
 *
 * A terminal transcript cuts a long last answer; the session row holds it whole, so a cut last
 * assistant turn is restored when the row's text starts with what the transcript kept. A chat row
 * holds only a 200-character head and its history is never cut, so nothing is restored there.
 *
 * A user entry that starts with the board's marker becomes a Paseo user message with that
 * messageId and the text the board sent, without mail framing or marker. A cut one is restored
 * from sentText, the outbox copy, when that starts with what the transcript kept. senderOf names
 * the session a terminal handle belongs to: mail it signed becomes that agent's message.
 */
export function timelinePage(read: AgentRead, session: SessionRecord | undefined, sentText: (messageId: string) => string | undefined = () => undefined,
  senderOf: (handle: string) => string | undefined = () => undefined): TimelinePage {
  const texts = read.entries.flatMap(({ kind, role, text }) =>
    kind === 'message' && (role === 'user' || role === 'assistant') && text?.trim() ? [{ role, text }] : [])
  const entries = texts.map((entry, index) => {
    const last = index === texts.length - 1
    let text = entry.text
    if (last && entry.role === 'assistant' && text.endsWith(TRUNCATED) && session?.surface === 'terminal' && session.lastAssistant?.startsWith(text.slice(0, -TRUNCATED.length))) {
      text = session.lastAssistant
    }
    const item: TimelineItem = entry.role === 'assistant' ? { type: 'assistant_message', text } : userItem(text, sentText, senderOf)
    // The read has no times; a finished last answer was given when the session entered its state.
    const timestamp = last && entry.role === 'assistant' && read.state === 'done' && session ? new Date(session.stateStartedAt).toISOString() : undefined
    return { item, seqEnd: texts.length - 1 - index, ...(timestamp ? { timestamp } : {}) }
  })
  return { epoch: 'orca-evidence/v1:' + read.orcaSessionId, entries, ...(read.state === 'working' ? { gap: true } : {}) }
}
