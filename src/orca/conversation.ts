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

/** What a terminal transcript read puts after a long entry it cut (about 1 200 characters kept). */
export const TRUNCATED = '\n… (truncated)'

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
 */
export function timelinePage(read: AgentRead, session: SessionRecord | undefined): TimelinePage {
  const texts = read.entries.flatMap(({ kind, role, text }) =>
    kind === 'message' && (role === 'user' || role === 'assistant') && text?.trim() ? [{ role, text }] : [])
  const entries = texts.map((entry, index) => {
    const last = index === texts.length - 1
    let text = entry.text
    if (last && entry.role === 'assistant' && text.endsWith(TRUNCATED) && session?.surface === 'terminal' && session.lastAssistant?.startsWith(text.slice(0, -TRUNCATED.length))) {
      text = session.lastAssistant
    }
    const item: TimelineItem = entry.role === 'assistant' ? { type: 'assistant_message', text } : { type: 'user_message', text }
    // The read has no times; a finished last answer was given when the session entered its state.
    const timestamp = last && entry.role === 'assistant' && read.state === 'done' && session ? new Date(session.stateStartedAt).toISOString() : undefined
    return { item, seqEnd: texts.length - 1 - index, ...(timestamp ? { timestamp } : {}) }
  })
  return { epoch: 'orca-evidence/v1:' + read.orcaSessionId, entries, ...(read.state === 'working' ? { gap: true } : {}) }
}
