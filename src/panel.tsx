// The board's sidebar panel: how many decisions wait, the first three, and a way into the full board.
// Loaded from source by Orca, so it imports nothing that uses npm packages.
import { atom, Button, Callout, Heading, List, ListItem, plugin, read, set, Skeleton, Stack, storage, Text, env, type PanelContext } from 'orca'
import { translator } from './i18n'

type Readiness = { configured: boolean; coordinator: string | null; decisionTitles?: string[] }

const count = atom<number | null>(null)
const readiness = atom<Readiness | null>(null)
const failure = atom<string | null>(null)
const notice = atom<string | null>(null)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

let generation = 0
async function refresh(): Promise<void> {
  const mine = ++generation
  try {
    // The count builds the snapshot the readiness titles come from.
    const counted = await plugin.request('board.decision-count', {}) as { count: number }
    const ready = await plugin.request('board.readiness', {}) as Readiness
    if (mine !== generation) return
    set(count, counted.count)
    set(readiness, ready)
    set(failure, null)
  } catch (error) {
    if (mine === generation) set(failure, message(error))
  }
}

async function openBoard(): Promise<void> {
  const answer = await plugin.request('board.open-dashboard', {}).catch((error: unknown) => ({ message: message(error) })) as { message: string | null }
  set(notice, answer.message)
}

export function setup(ctx: PanelContext): void {
  // The worker writes the status bar in the person's language.
  void storage.set('locale', env.locale)
  ctx.subscriptions.push(plugin.on('board.changed', () => void refresh()))
  void refresh()
}

export default function Panel() {
  const t = translator(env.locale)
  const ready = read(readiness)
  const n = read(count)
  const error = read(failure)
  const note = read(notice)
  const titles = ready?.decisionTitles ?? []
  return (
    <Stack gap="md">
      <Heading>{t('코디네이터 보드', 'Coordinator Board')}</Heading>
      {error && <Callout tone="danger" icon="error" title={t('보드를 읽지 못했습니다', 'Could not load the board')}><Text size="sm">{error}</Text></Callout>}
      {!ready ? (
        !error && <Skeleton lines={2} label={t('보드를 읽는 중', 'Loading the board')} />
      ) : !ready.configured ? (
        <Text size="sm">{t('보드를 열어 관리할 프로젝트를 고르세요.', 'Open the board to choose the projects it manages.')}</Text>
      ) : (
        <Stack gap="sm">
          <Text>{n ? t(`내 결정 ${n}`, `${n} to decide`) : t('지금 내릴 결정이 없습니다.', 'Nothing to decide right now.')}</Text>
          {titles.length > 0 && (
            <List label={t('먼저 볼 결정', 'Decisions first in line')}>
              {titles.map((title, index) => <ListItem key={String(index)} icon="flag" title={title} />)}
            </List>
          )}
        </Stack>
      )}
      <Button icon="open-external" onPress={openBoard}>{t('보드 열기', 'Open board')}</Button>
      {note && <Text size="sm" muted>{note}</Text>}
    </Stack>
  )
}
