// The board's sidebar panel: views only. Decisions, labels and guards live in .ts files.
import {
  atom, Badge, Button, Callout, Card, Checkbox, CodeView, Collapsible, EmptyState, env, Heading,
  IconButton, Link, List, ListItem, on, plugin, read, RelativeTime, Row, set, shell, Skeleton, Stack,
  Tab, Tabs, Text, Textarea, update, type PanelContext
} from 'orca'
import { translator, type T } from './i18n'
import { pullReasonLabel, pullStatusNote, replyStatusLabel, stateLabel, stateTone } from './labels'
import { MAX_REPLY, without, type BoardView, type Decision, type ProjectChoice, type ProjectLane, type ReplyResult } from './model'

const view = atom<BoardView | null>(null)
const failure = atom<string | null>(null)
const choices = atom<{ projects: ProjectChoice[]; selected: string[] } | null>(null)
const picking = atom<string[]>([])
/** Unsent replies, by terminal: they survive closing the panel. */
const drafts = atom('drafts', {} as Record<string, string>, { persist: 'plugin' })
const receipts = atom<Record<string, ReplyResult>>({})
const sending = atom<Record<string, boolean>>({})
const tab = atom('tab', 'decisions', { persist: 'plugin' })

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

let generation = 0
async function refresh(force = false): Promise<void> {
  const mine = ++generation
  try {
    const board = await plugin.request('board.read', { refresh: force })
    if (mine !== generation) return
    set(view, board)
    set(failure, null)
    if (!board.selected.length && !read(choices)) await loadChoices()
  } catch (error) {
    if (mine === generation) set(failure, message(error))
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
function soon(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    void refresh()
  }, 400)
}

async function loadChoices(): Promise<void> {
  const answer = await plugin.request('board.projects')
  set(choices, answer)
  set(picking, answer.selected)
}

async function saveProjects(): Promise<void> {
  await plugin.request('board.select-projects', { projectIds: read(picking) })
  set(tab, 'decisions')
  await refresh(true)
}

async function focus(terminalId: string | null): Promise<void> {
  if (terminalId) await plugin.request('board.focus', { terminalId })
}

async function dismiss(key: string): Promise<void> {
  await plugin.request('board.dismiss', { key })
}

async function send(decision: Decision): Promise<void> {
  const session = decision.session
  if (!session?.terminalId) return
  const terminalId = session.terminalId
  update(sending, (map) => ({ ...map, [terminalId]: true }))
  try {
    const result = await plugin.request('board.reply', {
      workspaceId: session.workspaceId,
      terminalId,
      text: read(drafts)[terminalId] ?? '',
      expectedSince: session.since,
      projectName: decision.projectName,
      workspaceName: session.workspaceName,
      title: session.title
    })
    update(receipts, (map) => ({ ...map, [terminalId]: result }))
    if (result.status === 'sent') update(drafts, (map) => without(map, terminalId))
  } catch {
    update(receipts, (map) => ({ ...map, [terminalId]: { status: 'failed' as const, at: Date.now() } }))
  } finally {
    update(sending, (map) => without(map, terminalId))
  }
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(
    plugin.on('board.changed', () => void refresh()),
    on('agent.status.changed', soon),
    on('workspace.created', soon),
    on('workspace.removed', soon)
  )
  void refresh()
  return () => {
    if (timer) clearTimeout(timer)
  }
}

function permissionCard(t: T, decision: Decision) {
  const session = decision.session!
  return (
    <Callout tone="warning" icon="warning" title={session.title}>
      <Stack gap="xs">
        <Text size="sm" muted>{decision.projectName} · {session.workspaceName} · <RelativeTime at={session.since} /></Text>
        <Text size="sm">
          {t('권한 요청을 기다리는 중입니다. 보드는 이 세션에 글을 보내지 않습니다. 세션에서 직접 승인하거나 거절하세요.',
            'This session is waiting for permission. The board never types into it. Approve or deny in the session.')}
        </Text>
        <Row>
          <Button size="sm" icon="terminal" disabled={!session.terminalId} onPress={() => focus(session.terminalId)}>
            {t('세션 열기', 'Open session')}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function replyCard(t: T, decision: Decision) {
  const session = decision.session!
  const terminalId = session.terminalId!
  const draft = read(drafts)[terminalId] ?? ''
  const busy = !!read(sending)[terminalId]
  const receipt = read(receipts)[terminalId]
  return (
    <Card title={session.title} description={`${decision.projectName} · ${session.workspaceName}`}>
      <Stack gap="sm">
        <Row gap="xs">
          <Badge tone={stateTone[session.state]}>{stateLabel(t, session.state)}</Badge>
          <Text size="xs" muted><RelativeTime at={session.since} /></Text>
        </Row>
        {decision.tail && decision.tail.length > 0 && (
          <Collapsible title={t('최근 출력', 'Recent output')} defaultOpen>
            <CodeView code={decision.tail.join('\n')} wrap label={t('최근 출력', 'Recent output')} />
          </Collapsible>
        )}
        <Textarea
          label={t('답장', 'Reply')}
          labelHidden
          placeholder={t('이 세션에 보낼 답을 쓰세요', 'Write your reply to this session')}
          rows={3}
          maxLength={MAX_REPLY}
          value={draft}
          disabled={busy}
          onChange={(value) => update(drafts, (map) => ({ ...map, [terminalId]: value }))}
        />
        {receipt && (
          <Row gap="xs">
            <Text size="sm" tone={receipt.status === 'sent' ? 'success' : 'warning'}>{replyStatusLabel(t, receipt.status)}</Text>
            <Text size="xs" muted><RelativeTime at={receipt.at} /></Text>
          </Row>
        )}
        <Row gap="xs" wrap>
          <Button size="sm" icon="next" disabled={busy || !draft.trim()} onPress={() => send(decision)}>
            {t('보내기', 'Send')}
          </Button>
          <Button size="sm" variant="ghost" icon="terminal" onPress={() => focus(terminalId)}>
            {t('세션 열기', 'Open session')}
          </Button>
          <Button size="sm" variant="ghost" icon="check" onPress={() => dismiss(decision.key)}>
            {t('확인함', 'Mark reviewed')}
          </Button>
        </Row>
      </Stack>
    </Card>
  )
}

function reviewCard(t: T, decision: Decision) {
  const pull = decision.pull!
  return (
    <Card title={`${pull.repo}#${pull.number}`} description={pull.title}>
      <Row gap="xs" wrap>
        <Badge tone="success">{pullReasonLabel(t, pull.reason)}</Badge>
        <Text size="xs" muted>{decision.projectName}</Text>
        <Link href={pull.url}>{t('GitHub에서 보기', 'Open on GitHub')}</Link>
        <Button size="sm" variant="ghost" icon="check" onPress={() => dismiss(decision.key)}>
          {t('확인함', 'Mark reviewed')}
        </Button>
      </Row>
    </Card>
  )
}

function decisionList(t: T, board: BoardView) {
  if (!board.decisions.length) {
    return <EmptyState icon="check" title={t('지금 결정할 일이 없습니다', 'Nothing needs you right now')} />
  }
  return (
    <Stack gap="sm">
      {board.decisions.map((decision) =>
        decision.kind === 'permission' ? permissionCard(t, decision)
          : decision.kind === 'reply' ? replyCard(t, decision)
            : reviewCard(t, decision))}
    </Stack>
  )
}

function laneView(t: T, lane: ProjectLane) {
  const note = pullStatusNote(t, lane.pullStatus)
  const summary = `${t('세션', 'Sessions')} ${lane.sessions.length} · PR ${lane.pulls.length}`
  return (
    <Collapsible title={lane.name} description={summary} defaultOpen>
      <Stack gap="sm">
        {lane.sessions.length > 0 ? (
          <List label={t('세션', 'Sessions')}>
            {lane.sessions.map((session) => (
              <ListItem
                icon="agent"
                title={session.title}
                description={`${session.workspaceName} · ${stateLabel(t, session.state)}`}
                disabled={!session.terminalId}
                onPress={() => focus(session.terminalId)}
              />
            ))}
          </List>
        ) : (
          <Text size="sm" muted>{t('열린 세션이 없습니다.', 'No open sessions.')}</Text>
        )}
        {lane.pulls.length > 0 && (
          <List label="Pull requests">
            {lane.pulls.map((pull) => (
              <ListItem
                icon="branch"
                title={`#${pull.number} ${pull.title}`}
                description={pullReasonLabel(t, pull.reason)}
                onPress={() => shell.openExternal(pull.url)}
              />
            ))}
          </List>
        )}
        {note && <Text size="xs" muted>{note}</Text>}
      </Stack>
    </Collapsible>
  )
}

function projectPicker(t: T) {
  const list = read(choices)
  if (!list) return <Skeleton lines={3} label={t('프로젝트를 읽는 중', 'Loading projects')} />
  if (!list.projects.length) {
    return <EmptyState icon="folder" title={t('Orca에 프로젝트가 없습니다', 'Orca has no projects')} />
  }
  const chosen = read(picking)
  return (
    <Stack gap="sm">
      <Text size="sm">{t('보드에 모을 프로젝트를 고르세요.', 'Choose the projects this board gathers.')}</Text>
      {list.projects.map((project) => (
        <Checkbox
          label={project.name}
          description={project.remote ? t('다른 호스트', 'Another host') : project.path}
          checked={chosen.includes(project.id)}
          onChange={(checked) => update(picking, (ids) => (checked ? [...ids, project.id] : ids.filter((id) => id !== project.id)))}
        />
      ))}
      <Row>
        <Button icon="check" onPress={saveProjects}>{t('저장', 'Save')}</Button>
      </Row>
    </Stack>
  )
}

function history(t: T, board: BoardView) {
  if (!board.replies.length) return null
  return (
    <Collapsible title={t('최근 보낸 답장', 'Recent replies')}>
      <List label={t('최근 보낸 답장', 'Recent replies')}>
        {board.replies.map((reply) => (
          <ListItem
            icon={reply.status === 'sent' ? 'check' : 'warning'}
            title={reply.text.split('\n')[0].slice(0, 120)}
            description={`${reply.projectName} · ${reply.title} · ${replyStatusLabel(t, reply.status)} · ${new Date(reply.at).toLocaleString(env.locale)}`}
          />
        ))}
      </List>
    </Collapsible>
  )
}

export default function Panel() {
  const t = translator(env.locale)
  const board = read(view)
  const error = read(failure)
  const current = read(tab)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>{t('코디네이터 보드', 'Coordinator Board')}</Heading>
        <Row gap="xs">
          {board && <Text size="xs" muted><RelativeTime at={board.at} /></Text>}
          <IconButton icon="refresh" label={t('새로 고침', 'Refresh')} onPress={() => refresh(true)} />
        </Row>
      </Row>
      {error && <Callout tone="danger" icon="error" title={t('보드를 읽지 못했습니다', 'Could not load the board')}><Text size="sm">{error}</Text></Callout>}
      {!board ? (
        <Skeleton lines={4} label={t('보드를 읽는 중', 'Loading the board')} />
      ) : !board.selected.length ? (
        projectPicker(t)
      ) : (
        <Tabs
          label={t('보드 보기', 'Board view')}
          value={current}
          onChange={(value) => {
            set(tab, value)
            if (value === 'settings') void loadChoices()
          }}
        >
          <Tab value="decisions" label={`${t('내 결정', 'My decisions')} ${board.decisions.length}`}>
            <Stack gap="md">
              {decisionList(t, board)}
              {history(t, board)}
            </Stack>
          </Tab>
          <Tab value="progress" label={t('세션 진행', 'Session progress')}>
            <Stack gap="sm">
              {board.truncated && <Text size="xs" muted>{t('세션이 많아 일부만 보입니다.', 'Showing only some sessions.')}</Text>}
              {board.projects.map((lane) => laneView(t, lane))}
            </Stack>
          </Tab>
          <Tab value="settings" label={t('프로젝트', 'Projects')}>
            {projectPicker(t)}
          </Tab>
        </Tabs>
      )}
    </Stack>
  )
}
