import { expect, test } from 'vitest'
import { agentRead, timelinePage, TRUNCATED } from './conversation'
import { fixtureWorld, result, sid } from './fixtures/load'
import { excerpt } from '../server/conversation'

const read = (name: string) => agentRead.parse(result(name))
const session = (n: number) => fixtureWorld().sessions.get(sid(n))!

test('a cut last terminal answer is restored from the session row when the row starts with what was kept', () => {
  const page = timelinePage(read('agent-read-terminal-cut.json'), session(7))
  const last = page.entries.at(-1)!
  expect(last.item).toEqual({ type: 'assistant_message', text: session(7).lastAssistant })
  expect(session(7).lastAssistant!.endsWith('Please choose the version to tag: 2.4.0 or 3.0.0.')).toBe(true)
  expect(last.timestamp).toBe(new Date(session(7).stateStartedAt).toISOString())
})

test('nothing is restored when the row does not start with the kept text, or the session is a chat', () => {
  const raw = read('agent-read-terminal-cut.json')
  const other = { ...session(7), lastAssistant: 'Something else entirely.' }
  const lastText = (page: ReturnType<typeof timelinePage>) => (page.entries.at(-1)!.item as { text: string }).text
  expect(lastText(timelinePage(raw, other)).endsWith(TRUNCATED)).toBe(true)
  expect(lastText(timelinePage(raw, { ...session(7), surface: 'chat' })).endsWith(TRUNCATED)).toBe(true)
})

test('only text turns count, newest last, with seqEnd counting the text turns after each', () => {
  const page = timelinePage(read('agent-read-chat-question.json'), session(1))
  expect(page.epoch).toBe('orca-evidence/v1:5e550001-0000-4000-8000-000000000000')
  expect(page.entries.map((e) => [e.item.type, e.seqEnd])).toEqual([['user_message', 1], ['assistant_message', 0]])
})

test('an unfinished turn is a gap, so no excerpt is built from it', () => {
  const raw = { ...read('agent-read-chat-question.json'), state: 'working' as const }
  expect(timelinePage(raw, session(1)).gap).toBe(true)
  expect(timelinePage(raw, session(1)).entries.at(-1)!.timestamp).toBeUndefined()
})

test('mail to a terminal agent shows only as Orca\'s check notice, which is later input and not a person\'s turn', () => {
  const notice = 'You have 1 orchestration message. Run `orca orchestration check --terminal term_0000aaaa-0000-4000-8000-000000000000`.'
  const raw = agentRead.parse({ orcaSessionId: sid(7), state: 'done', entries: [
    { kind: 'message', role: 'assistant', text: 'Which version should I tag?' },
    { kind: 'message', role: 'user', text: notice }
  ] })
  const evidence = excerpt(timelinePage(raw, session(7)))
  expect(evidence.turns.map((t) => t.text)).toEqual(['Which version should I tag?'])
  expect(evidence.laterInput).toBe(true)
})
