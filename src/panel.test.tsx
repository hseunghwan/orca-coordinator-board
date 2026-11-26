import { assert, mockHost, mount } from 'orca/testing'
import { test } from 'vitest'
import type { FocusCard, FocusDeck } from './contract'
import * as panel from './panel'

// A plain string, so the post stays the bare change signal whatever the old frame declares.
const BOARD_CHANGED: string = 'board.changed'

const reply = (sessionId: string, extra: Partial<Extract<FocusCard['answer'], { kind: 'reply' }>> = {}): FocusCard['answer'] =>
  ({ kind: 'reply', projectId: 'app', sessionId, version: 'v1', suggested: '', options: [], ...extra })

function card(key: string, extra: Partial<FocusCard> = {}): FocusCard {
  return {
    key, tone: 'warning', priority: 'Awaiting reply · 2h', projects: 'acme-app', session: key, headline: `Question from ${key}`,
    body: null, recommendation: null, recommendationReason: null, openSessionId: key, answer: reply(key), ...extra
  }
}

const deck = (cards: FocusCard[], over: Partial<FocusDeck> = {}): FocusDeck => ({ configured: true, incomplete: false, cards, ...over })

const writer = card('writer', {
  tone: 'danger', priority: 'Needs a decision now', headline: 'Which layout?', body: 'Name the page width.',
  recommendation: 'Two columns.', recommendationReason: 'Matches the guide.',
  answer: reply('writer', { version: 'v7', suggested: 'Two columns.', options: [{ label: 'One', reply: 'Use one column.' }] })
})
const tester = card('tester', { answer: { kind: 'permission' }, priority: 'Awaiting permission · 1h', headline: 'Run npm test?' })
const pull = card('pull', { tone: 'success', session: null, openSessionId: null, headline: 'Move the docs', answer: { kind: 'board' } })

test('shows the first decision as a card with its priority, project, question and recommendation', async () => {
  const opened: unknown[] = []
  const host = mockHost({
    requests: { 'board.focus-cards': deck([writer, tester, pull]), 'board.open-dashboard': (input: unknown) => { opened.push(input); return { message: null } } }
  })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: '1 / 3' }))
  assert.ok(view.find({ text: 'Needs a decision now' }))
  assert.ok(view.find({ text: 'acme-app · writer' }))
  assert.ok(view.find({ text: 'Which layout?' }))
  assert.ok(view.find({ text: 'Name the page width.' }))
  assert.ok(view.find({ label: 'Coordinator recommendation' }))
  assert.equal(view.valueOf({ label: 'Reply text' }), 'Two columns.')
  await view.press({ text: 'Open board' })
  assert.equal(opened.length, 1)
  assert.equal(view.persisted.storage.locale, 'en')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('an option fills the reply, and sending it uses board.send-decision once with a request key, then moves on', async () => {
  const sent: Record<string, unknown>[] = []
  let cards = [writer, tester, pull]
  const host = mockHost({
    requests: {
      'board.focus-cards': () => deck(cards),
      'board.send-decision': (input: Record<string, unknown>) => {
        sent.push(input)
        cards = [tester, pull]
        return { ok: true, recipientId: 'writer', messageId: '00000000-0000-4000-8000-000000000000' }
      }
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  await view.press({ text: 'One' })
  assert.equal(view.valueOf({ label: 'Reply text' }), 'Use one column.')
  await view.press({ text: 'Send reply' })
  assert.equal(sent.length, 1)
  const { requestKey, ...input } = sent[0]
  assert.deepEqual(input, { projectId: 'app', sessionId: 'writer', version: 'v7', action: 'reply', recipientId: 'writer', text: 'Use one column.' })
  assert.match(String(requestKey), /^decision-[a-z0-9]+-[a-z0-9]+$/)
  assert.ok(view.find({ text: 'acme-app · Sent a reply to writer.' }))
  assert.ok(view.find({ text: 'Run npm test?' }))
  assert.ok(view.find({ text: '1 / 2' }))
  await view.unmount()
})

test('Cmd or Ctrl+Enter sends what was typed, and a refused send shows why', async () => {
  const sent: Record<string, unknown>[] = []
  const host = mockHost({
    requests: {
      'board.focus-cards': deck([card('writer')]),
      'board.send-decision': (input: Record<string, unknown>) => { sent.push(input); throw new Error('The session is working. Send when it is idle.') }
    }
  })
  const view = await mount(panel, { host, locale: 'en' })
  await view.type({ label: 'Reply text' }, 'Go ahead.')
  await view.submit({ label: 'Reply text' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].text, 'Go ahead.')
  assert.ok(view.find({ label: 'Delivery was not confirmed' }))
  assert.ok(view.find({ text: 'The session is working. Send when it is idle.' }))
  await view.press({ text: 'Send reply' })
  assert.equal(sent[1].requestKey, sent[0].requestKey)
  await view.unmount()
})

test('previous, next and later walk the queue as the Focus view does', async () => {
  const host = mockHost({ requests: { 'board.focus-cards': deck([writer, tester, pull]) } })
  const view = await mount(panel, { host, locale: 'en' })
  await view.press({ text: 'Next' })
  assert.ok(view.find({ text: 'Run npm test?' }))
  assert.ok(view.find({ text: '2 / 3' }))
  await view.press({ text: 'Previous' })
  assert.ok(view.find({ text: 'Which layout?' }))
  await view.press({ text: 'Later' })
  assert.ok(view.find({ text: 'Run npm test?' }))
  assert.ok(view.find({ text: '1 / 3' }))
  await view.press({ text: 'Next' })
  await view.press({ text: 'Next' })
  assert.ok(view.find({ text: 'Which layout?' }))
  assert.ok(view.find({ text: '3 / 3' }))
  await view.unmount()
})

test('a permission decision only says to approve in the session and opens it', async () => {
  const opened: unknown[] = []
  const host = mockHost({
    requests: { 'board.focus-cards': deck([tester]), 'board.open-session': (input: unknown) => { opened.push(input); return { opened: true } } }
  })
  const view = await mount(panel, { host, locale: 'ko' })
  assert.ok(view.find({ label: '세션에서 승인' }))
  assert.equal(view.find({ text: '답장 보내기' }), null)
  assert.equal(view.find({ label: '답장 내용' }), null)
  await view.press({ text: '세션 열기' })
  assert.deepEqual(opened, [{ sessionId: 'tester' }])
  await view.unmount()
})

test('says there is nothing to decide, or to choose projects first, and keeps the board button', async () => {
  const empty = await mount(panel, { host: mockHost({ requests: { 'board.focus-cards': deck([]) } }), locale: 'ko' })
  assert.ok(empty.find({ text: '지금 내릴 결정이 없습니다.' }))
  assert.ok(empty.find({ text: '보드 열기' }))
  await empty.unmount()
  const fresh = await mount(panel, { host: mockHost({ requests: { 'board.focus-cards': deck([], { configured: false }) } }), locale: 'ko' })
  assert.ok(fresh.find({ text: '보드를 열어 관리할 프로젝트를 고르세요.' }))
  assert.ok(fresh.find({ text: '보드 열기' }))
  await fresh.unmount()
})

test('says why the dashboard did not open', async () => {
  const host = mockHost({ requests: { 'board.focus-cards': deck([]), 'board.open-dashboard': { message: 'Open a workspace, then try again.' } } })
  const view = await mount(panel, { host, locale: 'en' })
  await view.press({ text: 'Open board' })
  assert.ok(view.find({ text: 'Open a workspace, then try again.' }))
  await view.unmount()
})

test('reads again when the worker says the board changed, and shows a failed read', async () => {
  let cards = [writer]
  const host = mockHost({ requests: { 'board.focus-cards': () => deck(cards) } })
  const view = await mount(panel, { host, locale: 'en' })
  assert.ok(view.find({ text: '1 / 1' }))
  cards = [writer, tester]
  await view.post(BOARD_CHANGED, {})
  assert.ok(view.find({ text: '1 / 2' }))
  await view.unmount()
  const failed = await mount(panel, { host: mockHost({ requests: {} }), locale: 'en' })
  assert.ok(failed.find({ label: 'Could not load the board' }))
  await failed.unmount()
})
