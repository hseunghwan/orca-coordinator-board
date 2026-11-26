// The board's sidebar panel: the decision the dashboard's Focus view shows first, answered in place, and a
// way into the full board. Loaded from source by Orca, so it imports nothing that uses npm packages: the
// worker ranks and shapes the cards (src/focus-cards.ts) and the panel only walks them.
import {
  atom, Badge, Box, Button, Callout, env, Heading, Markdown, plugin, read, Row, set, Skeleton, Stack, storage, Text, Textarea,
  type PanelContext, type Tone
} from 'orca'
import type { FocusCard, FocusDeck } from './contract'
import { noRetry, retryKey } from './dashboard/request-key'
import { deferFocus, focusQueue, resolveFocus, stepFocus, type FocusEntry } from './paseo/client/focus-queue'
import { translator } from './i18n'

type Receipt = { key: string; text: string }

const deck = atom<FocusDeck | null>(null)
const failure = atom<string | null>(null)
const notice = atom<string | null>(null)
// The Focus view's visit state: the card in view, the queue it was chosen from, and "later" for this panel session.
const chosen = atom<string | null>(null)
const seen = atom<string[]>([])
const deferred = atom<string[]>([])
// Decisions sent from this panel leave the queue at once, as the dashboard's completed rows do.
const handled = atom<Receipt[]>([])
const drafts = atom<Record<string, string>>({})
const sending = atom(false)
const sendError = atom<string | null>(null)
const retry = atom(noRetry)
const delivered = atom<string[]>([])

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
// Orca's longest text value; a dashboard reply may be longer, the sidebar's may not.
const MAX_REPLY = 16384
const tones: Record<FocusCard['tone'], Tone> = { danger: 'danger', warning: 'warning', success: 'success', muted: 'neutral' }

function entriesOf(cards: readonly FocusCard[], done: readonly Receipt[]): FocusEntry[] {
  return cards.map((card) => {
    const receipts = done.filter((receipt) => receipt.key === card.key)
    return { key: card.key, row: receipts.length ? null : card, receipts }
  })
}

/** Moves the view to `prefer`, or to whatever took its place in the queue. */
function settle(cards: readonly FocusCard[], done: readonly Receipt[], prefer: string | null): void {
  const queue = focusQueue(entriesOf(cards, done), read(deferred))
  set(chosen, resolveFocus(prefer, read(seen), queue))
  set(seen, queue)
}

let generation = 0
async function refresh(): Promise<void> {
  const mine = ++generation
  try {
    const next = await plugin.request('board.focus-cards', {}) as FocusDeck
    if (mine !== generation) return
    set(deck, next)
    set(failure, null)
    settle(next.cards, read(handled), read(chosen))
  } catch (error) {
    if (mine === generation) set(failure, message(error))
  }
}

async function openBoard(): Promise<void> {
  const answer = await plugin.request('board.open-dashboard', {}).catch((error: unknown) => ({ message: message(error) })) as { message: string | null }
  set(notice, answer.message)
}

async function openSession(sessionId: string): Promise<void> {
  const t = translator(env.locale)
  const answer = await plugin.request('board.open-session', { sessionId }).catch(() => ({ opened: false })) as { opened: boolean }
  set(notice, answer.opened ? null : t('세션을 열지 못했습니다. 보드를 새로 고친 뒤 다시 누르세요.', 'Could not open the session. Refresh the board and try again.'))
}

function move(action: 'previous' | 'next' | 'later', queue: readonly string[], current: string | null): void {
  set(sendError, null)
  if (action !== 'later') {
    set(chosen, stepFocus(queue, current, action === 'next' ? 1 : -1))
    return
  }
  const cards = read(deck)?.cards ?? []
  const result = deferFocus(entriesOf(cards, read(handled)), read(deferred), current)
  set(deferred, result.deferred)
  set(chosen, result.current)
}

// The dashboard's send rules: one request key per payload so a retry is recognised, and the same reply
// is never sent twice from this panel.
async function send(card: FocusCard, text: string): Promise<void> {
  const t = translator(env.locale)
  const answer = card.answer
  if (answer.kind !== 'reply' || read(sending) || !text.trim()) return
  const input = { projectId: answer.projectId, sessionId: answer.sessionId, version: answer.version, action: 'reply', recipientId: answer.sessionId, text }
  const payload = JSON.stringify(input)
  if (read(delivered).includes(payload)) {
    set(sendError, t('이 카드에서 같은 내용을 이미 보냈습니다.', 'You already sent this message from this card.'))
    return
  }
  const key = retryKey(read(retry), payload, 'decision')
  set(retry, key)
  set(sending, true)
  set(sendError, null)
  try {
    const result = await plugin.request('board.send-decision', { ...input, requestKey: key.key }) as { ok: boolean; recipientId: string }
    if (!result.ok || result.recipientId !== answer.sessionId) {
      set(sendError, t('영수증의 수신자를 확인할 수 없습니다. 원래 세션을 확인해 주세요.', 'The receipt does not confirm the recipient. Check the original session.'))
      return
    }
    const name = card.session ?? answer.sessionId
    const done = [...read(handled), { key: card.key, text: [card.projects, t(`${name}에 답장을 보냈습니다.`, `Sent a reply to ${name}.`)].filter(Boolean).join(' · ') }]
    const { [card.key]: _sent, ...rest } = read(drafts)
    set(delivered, [...read(delivered), payload])
    set(drafts, rest)
    set(handled, done)
    settle(read(deck)?.cards ?? [], done, card.key)
    void refresh()
  } catch (error) {
    set(sendError, message(error))
  } finally {
    set(sending, false)
  }
}

export function setup(ctx: PanelContext): void {
  // The worker writes the status bar and the cards in the person's language.
  void storage.set('locale', env.locale)
  ctx.subscriptions.push(plugin.on('board.changed', () => void refresh()))
  void refresh()
}

function Answer({ card }: { card: FocusCard }) {
  const t = translator(env.locale)
  const answer = card.answer
  const open = card.openSessionId
  const openButton = open && <Button variant="outline" size="sm" icon="open-external" onPress={() => openSession(open)}>{t('세션 열기', 'Open session')}</Button>
  if (answer.kind === 'permission') {
    return (
      <Stack gap="sm">
        <Callout tone="warning" icon="warning" title={t('세션에서 승인', 'Approve in session')}>
          <Text size="sm">{t('승인 요청은 담당 세션에서 확인해 주세요.', 'Review the approval request in the assigned session.')}</Text>
        </Callout>
        {openButton}
      </Stack>
    )
  }
  if (answer.kind !== 'reply') {
    return (
      <Stack gap="sm">
        {answer.kind === 'board' && <Text size="sm" muted>{t('이 결정은 보드에서 답합니다.', 'Answer this decision on the board.')}</Text>}
        {openButton}
      </Stack>
    )
  }
  const busy = read(sending)
  const text = read(drafts)[card.key] ?? answer.suggested
  const ready = !busy && !!text.trim() && text.length <= MAX_REPLY
  const draft = (value: string) => set(drafts, { ...read(drafts), [card.key]: value })
  return (
    <Stack gap="sm">
      {answer.options.length > 0 && (
        <Row gap="xs" wrap>
          {answer.options.map((option, index) => (
            <Button key={String(index)} variant="outline" size="sm" disabled={busy} onPress={() => draft(option.reply)}>{option.label}</Button>
          ))}
        </Row>
      )}
      <Textarea key={card.key} label={t('답장 내용', 'Reply text')} labelHidden rows={4} maxLength={MAX_REPLY} value={text} disabled={busy}
        placeholder={t('담당 세션에 보낼 답을 입력하세요', 'Write a reply to the assigned session')}
        onChange={draft} onSubmit={(value) => void send(card, value)} />
      <Row gap="sm" wrap>
        <Button variant="solid" tone="accent" size="sm" icon="play" disabled={!ready} onPress={() => send(card, text)}>
          {busy ? t('전송 중…', 'Sending…') : t('답장 보내기', 'Send reply')}
        </Button>
        {openButton}
      </Row>
    </Stack>
  )
}

function Decision({ card }: { card: FocusCard }) {
  const t = translator(env.locale)
  return (
    <Box border radius="md" padding="md" gap="sm">
      <Row gap="sm" wrap align="center">
        <Badge tone={tones[card.tone]}>{card.priority}</Badge>
        <Text size="sm" muted>{[card.projects, card.session].filter(Boolean).join(' · ')}</Text>
      </Row>
      <Markdown content={card.headline} />
      {card.body && <Markdown content={card.body} />}
      {card.recommendation && (
        <Callout tone="accent" icon="info" title={t('코디네이터 추천', 'Coordinator recommendation')}>
          <Markdown content={card.recommendation} />
          {card.recommendationReason && <Text size="sm" muted>{card.recommendationReason}</Text>}
        </Callout>
      )}
      <Answer card={card} />
    </Box>
  )
}

export default function Panel() {
  const t = translator(env.locale)
  const board = read(deck)
  const error = read(failure)
  const note = read(notice)
  const done = read(handled)
  const cards = board?.cards ?? []
  const queue = focusQueue(entriesOf(cards, done), read(deferred))
  const current = resolveFocus(read(chosen), read(seen), queue)
  const index = current === null ? -1 : queue.indexOf(current)
  const card = cards.find((entry) => entry.key === current)
  const problem = read(sendError)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>{t('코디네이터 보드', 'Coordinator Board')}</Heading>
        {card && <Text size="sm" muted>{`${index + 1} / ${queue.length}`}</Text>}
      </Row>
      {error && <Callout tone="danger" icon="error" title={t('보드를 읽지 못했습니다', 'Could not load the board')}><Text size="sm">{error}</Text></Callout>}
      {!board ? (
        !error && <Skeleton lines={3} label={t('보드를 읽는 중', 'Loading the board')} />
      ) : !board.configured ? (
        <Text size="sm">{t('보드를 열어 관리할 프로젝트를 고르세요.', 'Open the board to choose the projects it manages.')}</Text>
      ) : !card ? (
        <Text>{t('지금 내릴 결정이 없습니다.', 'Nothing to decide right now.')}</Text>
      ) : (
        <Stack gap="sm">
          <Decision card={card} />
          {problem && <Callout tone="danger" icon="error" title={t('전송을 확인하지 못했습니다', 'Delivery was not confirmed')}><Text size="sm">{problem}</Text></Callout>}
          <Row gap="xs" justify="between">
            <Row gap="xs">
              <Button variant="ghost" size="sm" disabled={index <= 0} onPress={() => move('previous', queue, current)}>{t('이전', 'Previous')}</Button>
              <Button variant="ghost" size="sm" disabled={queue.length < 2} onPress={() => move('later', queue, current)}>{t('나중에', 'Later')}</Button>
            </Row>
            <Button variant="ghost" size="sm" icon="next" disabled={index >= queue.length - 1} onPress={() => move('next', queue, current)}>{t('다음', 'Next')}</Button>
          </Row>
        </Stack>
      )}
      {board?.incomplete && <Text size="sm" muted>{t('결정 기록 일부를 읽지 못했습니다. 보드에서 확인하세요.', 'Part of the decision ledger could not be read. Check the board.')}</Text>}
      {done.length > 0 && (
        <Stack gap="xs">
          <Text size="sm" weight="medium">{t(`처리한 결정 ${done.length}`, `Handled decisions ${done.length}`)}</Text>
          {done.slice(-3).map((receipt) => <Text key={receipt.key} size="sm" tone="success">{receipt.text}</Text>)}
        </Stack>
      )}
      <Button icon="open-external" onPress={openBoard}>{t('보드 열기', 'Open board')}</Button>
      {note && <Text size="sm" muted>{note}</Text>}
    </Stack>
  )
}
