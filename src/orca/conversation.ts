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

function userItem(text: string, sentText: (messageId: string) => string | undefined): TimelineItem {
  const marked = readMarked(text)
  if (!marked) return { type: 'user_message', text }
  const full = marked.cut ? readMarked(sentText(marked.messageId) ?? '')?.body : undefined
  const body = full?.startsWith(marked.body) ? full : marked.body
  return { type: 'user_message', text: body, messageId: marked.messageId }
}

/** What a terminal transcript read puts after a long entry it cut (about 1 200 characters kept). */
export const TRUNCATED = '\n… (truncated)'

const MARKER = /^\[cb:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/i
const MAIL_HEAD = /^─+ From: .* ─+$/
const MAIL_RULE = /^─+$/
const MAIL_REPLY = /^\[Reply: orca orchestration reply /

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

/** The board message a transcript user entry carries, if it starts with a marker. */
export function readMarked(entry: string): { messageId: string; body: string; cut: boolean } | null {
  let text = unframe(entry)
  const cut = text.endsWith(TRUNCATED)
  if (cut) text = text.slice(0, -TRUNCATED.length)
  const newline = text.indexOf('\n')
  const first = (newline < 0 ? text : text.slice(0, newline)).trim()
  const marker = MARKER.exec(first)
  if (!marker) return null
  return { messageId: marker[1].toLowerCase(), body: newline < 0 ? '' : text.slice(newline + 1), cut }
}

/**
 * Only text turns: excerpt() hashes text turns and ignores plain tool calls, and Orca has no
 * message ids or agent-message tool calls to carry.
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
 * from sentText, the outbox copy, when that starts with what the transcript kept.
 */
export function timelinePage(read: AgentRead, session: SessionRecord | undefined, sentText: (messageId: string) => string | undefined = () => undefined): TimelinePage {
  const texts = read.entries.flatMap(({ kind, role, text }) =>
    kind === 'message' && (role === 'user' || role === 'assistant') && text?.trim() ? [{ role, text }] : [])
  const entries = texts.map((entry, index) => {
    const last = index === texts.length - 1
    let text = entry.text
    if (last && entry.role === 'assistant' && text.endsWith(TRUNCATED) && session?.surface === 'terminal' && session.lastAssistant?.startsWith(text.slice(0, -TRUNCATED.length))) {
      text = session.lastAssistant
    }
    const item: TimelineItem = entry.role === 'assistant' ? { type: 'assistant_message', text } : userItem(text, sentText)
    // The read has no times; a finished last answer was given when the session entered its state.
    const timestamp = last && entry.role === 'assistant' && read.state === 'done' && session ? new Date(session.stateStartedAt).toISOString() : undefined
    return { item, seqEnd: texts.length - 1 - index, ...(timestamp ? { timestamp } : {}) }
  })
  return { epoch: 'orca-evidence/v1:' + read.orcaSessionId, entries, ...(read.state === 'working' ? { gap: true } : {}) }
}
