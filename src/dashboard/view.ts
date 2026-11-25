// The dashboard's view: builds the whole page from the state main.ts keeps. Decisions, labels and
// guards come from the shared .ts modules; nothing here decides what may be sent.
import type { T } from '../i18n'
import { pullReasonLabel, pullStatusNote, replyStatusLabel, stateLabel } from '../labels'
import { MAX_REPLY, type AgentState, type BoardView, type Decision, type ProjectChoice, type ProjectLane, type ReplyResult, type SessionRow } from '../model'
import { ago, laneGroups, waitingCounts } from '../summary'
import { h, type Child } from './dom'

export type DashState = {
  board: BoardView | null
  error: string | null
  choices: { projects: ProjectChoice[]; selected: string[] } | null
  /** The projects ticked while the picker is open; null when it is closed. */
  picking: string[] | null
  drafts: Record<string, string>
  receipts: Record<string, ReplyResult>
  sending: Record<string, boolean>
  /** Open <details> sections, so a redraw keeps them open. */
  open: Record<string, boolean>
  refreshing: boolean
  now: number
}

export type Actions = {
  refresh(): void
  openPicker(): void
  togglePick(projectId: string, on: boolean): void
  savePicker(): void
  closePicker(): void
  draft(terminalId: string, text: string): void
  send(decision: Decision): void
  /** Shows the session: its terminal, or its workspace for a chat tab. */
  focus(session: SessionRow): void
  dismiss(key: string): void
  openUrl(url: string): void
  toggle(key: string, open: boolean): void
}

const STATES: AgentState[] = ['blocked', 'waiting', 'working', 'done']

function button(label: string, onClick: () => void, options: { kind?: 'primary' | 'ghost'; disabled?: boolean; title?: string } = {}): HTMLElement {
  return h('button', { type: 'button', class: options.kind ?? null, disabled: options.disabled, title: options.title ?? null, onClick }, label)
}

function badge(state: string, label: string): HTMLElement {
  return h('span', { class: 'badge ' + state }, label)
}

function details(s: DashState, a: Actions, key: string, summary: Child, ...children: Child[]): HTMLElement {
  return h('details', { open: !!s.open[key], onToggle: (event: Event) => a.toggle(key, (event.currentTarget as HTMLDetailsElement).open) },
    h('summary', { class: 'muted small' }, summary), ...children)
}

function header(t: T, s: DashState, a: Actions): HTMLElement {
  const board = s.board
  const counts = board ? waitingCounts(board) : null
  const sessions = board ? board.projects.reduce((sum, lane) => sum + lane.sessions.length, 0) : 0
  const chip = (state: string, label: string, value: number) =>
    h('span', { class: 'chip' + (value ? '' : ' zero') }, h('span', { class: 'dot ' + state }), label, h('strong', null, value))
  return h('header', { class: 'top' },
    h('div', { class: 'title' },
      h('h1', null, t('코디네이터 보드', 'Coordinator Board')),
      board && h('div', { class: 'muted small' },
        `${t('프로젝트', 'Projects')} ${board.projects.length} · ${t('세션', 'Sessions')} ${sessions} · ${t('갱신', 'Updated')} ${ago(t, s.now, board.at)}`)),
    counts && h('div', { class: 'chips' },
      chip('blocked', t('권한 대기', 'Permission'), counts.permission),
      chip('waiting', t('답 기다림', 'Waiting for you'), counts.reply),
      chip('review', t('리뷰 가능', 'Ready for review'), counts.review),
      chip('working', t('작업 중', 'Working'), counts.working)),
    h('div', { class: 'actions' },
      button(t('프로젝트 고르기', 'Choose projects'), a.openPicker, { kind: 'ghost' }),
      button(s.refreshing ? t('읽는 중', 'Loading') : t('새로 고침', 'Refresh'), a.refresh, { disabled: s.refreshing })))
}

function meta(t: T, s: DashState, decision: Decision, session: SessionRow): HTMLElement {
  const where = [decision.projectName, session.workspaceName, session.branch].filter(Boolean).join(' · ')
  return h('div', { class: 'muted small' }, `${where} · ${ago(t, s.now, session.since)}`)
}

function permissionCard(t: T, s: DashState, a: Actions, decision: Decision): HTMLElement {
  const session = decision.session!
  return h('article', { class: 'card permission' },
    h('div', { class: 'card-head' }, h('h3', { title: session.title }, session.title), badge('blocked', stateLabel(t, 'blocked'))),
    meta(t, s, decision, session),
    h('div', { class: 'small' }, t('권한 요청을 기다리는 중입니다. 보드는 이 세션에 글을 보내지 않습니다. 세션에서 직접 승인하거나 거절하세요.',
      'This session is waiting for permission. The board never types into it. Approve or deny in the session.')),
    h('div', { class: 'actions' }, button(openLabel(t, session), () => a.focus(session))))
}

function openLabel(t: T, session: SessionRow): string {
  return session.terminalId ? t('세션 열기', 'Open session') : t('채팅 열기', 'Open chat')
}

/** A chat tab waiting for an answer: Orca gives plugins no way to type into it, so the person answers there. */
function chatCard(t: T, s: DashState, a: Actions, decision: Decision): HTMLElement {
  const session = decision.session!
  return h('article', { class: 'card reply' },
    h('div', { class: 'card-head' }, h('h3', { title: session.title }, session.title), badge('waiting', stateLabel(t, 'waiting'))),
    meta(t, s, decision, session),
    h('div', { class: 'small' }, t('채팅 탭에서 도는 세션이라 보드에서 답을 보낼 수 없습니다. 채팅 열기로 가서 답하세요.',
      'This session runs in a chat tab, so the board cannot send to it. Open the chat to answer.')),
    h('div', { class: 'actions' },
      button(t('채팅 열기', 'Open chat'), () => a.focus(session), { kind: 'primary' }),
      button(t('확인함', 'Mark reviewed'), () => a.dismiss(decision.key), { kind: 'ghost' })))
}

function replyCard(t: T, s: DashState, a: Actions, decision: Decision): HTMLElement {
  const session = decision.session!
  if (!session.terminalId) return chatCard(t, s, a, decision)
  const terminalId = session.terminalId
  const busy = !!s.sending[terminalId]
  const receipt = s.receipts[terminalId]
  const send = button(busy ? t('보내는 중', 'Sending') : t('보내기', 'Send'), () => a.send(decision), {
    kind: 'primary', disabled: busy || !(s.drafts[terminalId] ?? '').trim(), title: t('Ctrl+Enter로 보내기', 'Ctrl+Enter to send')
  }) as HTMLButtonElement
  const box = h('textarea', {
    rows: 3,
    maxlength: MAX_REPLY,
    placeholder: t('이 세션에 보낼 답을 쓰세요', 'Write your reply to this session'),
    'aria-label': t('답장', 'Reply'),
    'data-terminal': terminalId,
    value: s.drafts[terminalId] ?? '',
    disabled: busy,
    onInput: (event: Event) => {
      const text = (event.currentTarget as HTMLTextAreaElement).value
      a.draft(terminalId, text)
      send.disabled = busy || !text.trim()
    },
    onKeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault()
        if (!send.disabled) a.send(decision)
      }
    }
  })
  return h('article', { class: 'card reply' },
    h('div', { class: 'card-head' }, h('h3', { title: session.title }, session.title), badge('waiting', stateLabel(t, 'waiting'))),
    meta(t, s, decision, session),
    decision.tail && decision.tail.length > 0 && h('pre', { class: 'tail', 'aria-label': t('최근 출력', 'Recent output') }, decision.tail.join('\n')),
    box,
    receipt && h('div', { class: 'small', style: receipt.status === 'sent' ? null : 'color: var(--cb-blocked)' },
      `${replyStatusLabel(t, receipt.status)} · ${ago(t, s.now, receipt.at)}`),
    h('div', { class: 'actions' },
      send,
      button(t('세션 열기', 'Open session'), () => a.focus(session), { kind: 'ghost' }),
      button(t('확인함', 'Mark reviewed'), () => a.dismiss(decision.key), { kind: 'ghost' })))
}

function reviewCard(t: T, s: DashState, a: Actions, decision: Decision): HTMLElement {
  const pull = decision.pull!
  return h('article', { class: 'card review' },
    h('div', { class: 'card-head' }, h('h3', { title: pull.title }, `${pull.repo}#${pull.number}`), badge('review', pullReasonLabel(t, pull.reason))),
    h('div', null, pull.title),
    h('div', { class: 'muted small' }, `${decision.projectName} · ${ago(t, s.now, decision.since)}`),
    h('div', { class: 'actions' },
      button(t('GitHub에서 보기', 'Open on GitHub'), () => a.openUrl(pull.url)),
      button(t('확인함', 'Mark reviewed'), () => a.dismiss(decision.key), { kind: 'ghost' })))
}

function decisionColumn(t: T, s: DashState, a: Actions, board: BoardView): HTMLElement {
  const cards = board.decisions.map((decision) =>
    decision.kind === 'permission' ? permissionCard(t, s, a, decision)
      : decision.kind === 'reply' ? replyCard(t, s, a, decision)
        : reviewCard(t, s, a, decision))
  return h('section', { class: 'column', 'aria-label': t('내 결정', 'My decisions') },
    h('div', { class: 'column-head' }, h('h2', null, t('내 결정', 'My decisions')), h('span', { class: 'count' }, board.decisions.length)),
    cards.length ? cards : h('div', { class: 'empty muted' }, t('지금 결정할 일이 없습니다', 'Nothing needs you right now')),
    history(t, s, a, board))
}

function history(t: T, s: DashState, a: Actions, board: BoardView): Child {
  if (!board.replies.length) return null
  return h('div', { class: 'history' }, details(s, a, 'history', t('최근 보낸 답장', 'Recent replies'),
    h('ul', null, board.replies.map((reply) => h('li', { class: 'small' },
      h('span', null, reply.text.split('\n')[0].slice(0, 160)),
      h('span', { class: 'muted' }, ` · ${reply.projectName} · ${reply.title} · ${replyStatusLabel(t, reply.status)} · ${ago(t, s.now, reply.at)}`))))))
}

function sessionRow(t: T, s: DashState, a: Actions, session: SessionRow): HTMLElement {
  const go = () => a.focus(session)
  return h('div', {
    class: 'session',
    role: 'button',
    tabindex: 0,
    title: session.terminalId ? t('눌러서 세션 열기', 'Open the session') : t('눌러서 채팅이 있는 워크스페이스 열기', 'Open the workspace of this chat'),
    onClick: go,
    onKeydown: (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go() } }
  },
  h('span', { class: 'dot ' + session.state }),
  h('span', { class: 'name' }, session.title),
  h('span', { class: 'where muted small' }, session.workspaceName),
  h('span', { class: 'muted small' }, ago(t, s.now, session.since)))
}

function laneCard(t: T, s: DashState, a: Actions, lane: ProjectLane): HTMLElement {
  const groups = laneGroups(lane)
  const note = pullStatusNote(t, lane.pullStatus)
  const total = lane.sessions.length
  return h('article', { class: 'card lane' },
    h('div', { class: 'card-head' }, h('h3', { title: lane.name }, lane.name),
      h('span', { class: 'muted small' }, `${t('세션', 'Sessions')} ${total} · PR ${lane.pulls.length}`)),
    total > 0 && h('div', { class: 'bar', title: STATES.map((state) => `${stateLabel(t, state)} ${groups.counts[state]}`).join(' · ') },
      STATES.filter((state) => groups.counts[state]).map((state) => h('span', { class: state, style: `flex: ${groups.counts[state]}` }))),
    groups.active.length
      ? h('div', { class: 'sessions' }, groups.active.map((session) => sessionRow(t, s, a, session)))
      : h('div', { class: 'muted small' }, t('진행 중인 세션이 없습니다.', 'No active sessions.')),
    groups.done.length > 0 && details(s, a, 'done:' + lane.projectId, t(`완료 ${groups.done.length}개`, `${groups.done.length} done`),
      h('div', { class: 'sessions' }, groups.done.map((session) => sessionRow(t, s, a, session)))),
    lane.pulls.length > 0 && h('div', { class: 'pulls' }, lane.pulls.map((pull) => h('div', { class: 'pull small' },
      h('a', { href: pull.url, title: pull.title, onClick: (event: MouseEvent) => { event.preventDefault(); a.openUrl(pull.url) } }, `#${pull.number} ${pull.title}`),
      badge(pull.reason === 'ready' ? 'review' : '', pullReasonLabel(t, pull.reason))))),
    note && h('div', { class: 'muted small' }, note))
}

function progressColumn(t: T, s: DashState, a: Actions, board: BoardView): HTMLElement {
  const sessions = board.projects.reduce((sum, lane) => sum + lane.sessions.length, 0)
  return h('section', { class: 'column', 'aria-label': t('세션 진행', 'Session progress') },
    h('div', { class: 'column-head' }, h('h2', null, t('세션 진행', 'Session progress')), h('span', { class: 'count' }, sessions)),
    board.truncated && h('div', { class: 'muted small' }, t('세션이 많아 일부만 보입니다.', 'Showing only some sessions.')),
    h('div', { class: 'lanes' }, board.projects.map((lane) => laneCard(t, s, a, lane))))
}

function picker(t: T, s: DashState, a: Actions): HTMLElement {
  const list = s.choices
  const chosen = s.picking ?? []
  return h('section', { class: 'card picker' },
    h('h2', null, t('보드에 모을 프로젝트', 'Projects on this board')),
    !list ? h('div', { class: 'muted' }, t('프로젝트를 읽는 중', 'Loading projects'))
      : !list.projects.length ? h('div', { class: 'muted' }, t('Orca에 프로젝트가 없습니다', 'Orca has no projects'))
        : list.projects.map((project) => h('label', null,
          h('input', { type: 'checkbox', checked: chosen.includes(project.id), onChange: (event: Event) => a.togglePick(project.id, (event.currentTarget as HTMLInputElement).checked) }),
          h('span', null, h('div', null, project.name), h('div', { class: 'muted small' }, project.remote ? t('다른 호스트', 'Another host') : project.path)))),
    h('div', { class: 'actions' },
      button(t('저장', 'Save'), a.savePicker, { kind: 'primary', disabled: !list }),
      s.board?.selected.length ? button(t('취소', 'Cancel'), a.closePicker, { kind: 'ghost' }) : null))
}

export function renderApp(t: T, s: DashState, a: Actions): HTMLElement {
  const board = s.board
  return h('div', { class: 'app' },
    header(t, s, a),
    s.error && h('div', { class: 'banner', role: 'alert' }, `${t('보드를 읽지 못했습니다', 'Could not load the board')}: ${s.error}`),
    s.picking ? picker(t, s, a)
      : !board ? h('div', { class: 'empty muted' }, t('보드를 읽는 중', 'Loading the board'))
        : h('div', { class: 'layout' }, decisionColumn(t, s, a, board), progressColumn(t, s, a, board)))
}
