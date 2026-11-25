// The dashboard: a full-width editor tab Orca opens on .coordinator-board files. The file is only a
// key; everything shown comes from the worker through the same requests the sidebar panel makes.
import { translator } from '../i18n'
import type { Decision } from '../model'
import { STYLE } from './style'
import { renderApp, type Actions, type DashState } from './view'

const REFRESH_MS = 30_000
const t = translator(orca.locale)
const style = document.createElement('style')
style.textContent = STYLE
document.head.append(style)
const app = document.createElement('div')
document.body.append(app)

const state: DashState = {
  board: null, error: null, choices: null, picking: null,
  drafts: {}, receipts: {}, sending: {}, open: {}, refreshing: false, now: Date.now()
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The page is rebuilt on each change, so it waits while the person types (an IME composition
// would break) or holds a pointer down (the button under it would be replaced before its click).
let pending = false
let pressing = false
function busyTyping(): boolean {
  const active = document.activeElement
  return !!active && active.tagName === 'TEXTAREA' && app.contains(active)
}
function draw(): void {
  if (pressing || busyTyping()) {
    pending = true
    return
  }
  pending = false
  const scroll = window.scrollY
  state.now = Date.now()
  app.replaceChildren(renderApp(t, state, actions))
  // A session's question sits at the end of its output: show the newest lines first.
  app.querySelectorAll<HTMLElement>('pre.tail').forEach((tail) => { tail.scrollTop = tail.scrollHeight })
  window.scrollTo(0, scroll)
}
window.addEventListener('pointerdown', () => { pressing = true }, true)
window.addEventListener('pointerup', () => {
  pressing = false
  if (pending) setTimeout(draw, 0)
}, true)
app.addEventListener('focusout', () => setTimeout(() => { if (pending) draw() }, 0))

let generation = 0
async function refresh(force = false): Promise<void> {
  const mine = ++generation
  state.refreshing = true
  draw()
  try {
    const board = await orca.plugin.request('board.read', { refresh: force, locale: orca.locale })
    if (mine !== generation) return
    state.board = board
    state.error = null
    if (!board.selected.length && !state.picking) await openPicker()
  } catch (error) {
    if (mine === generation) state.error = message(error)
  } finally {
    if (mine === generation) {
      state.refreshing = false
      draw()
    }
  }
}

let soonTimer: ReturnType<typeof setTimeout> | undefined
function soon(): void {
  if (soonTimer) clearTimeout(soonTimer)
  soonTimer = setTimeout(() => { soonTimer = undefined; void refresh() }, 400)
}

async function openPicker(): Promise<void> {
  state.picking = state.board?.selected ? [...state.board.selected] : []
  draw()
  try {
    const choices = await orca.plugin.request('board.projects')
    state.choices = choices
    state.picking = [...choices.selected]
  } catch (error) {
    state.error = message(error)
  }
  draw()
}

async function send(decision: Decision): Promise<void> {
  const session = decision.session
  if (!session?.terminalId) return
  const terminalId = session.terminalId
  state.sending[terminalId] = true
  draw()
  try {
    const result = await orca.plugin.request('board.reply', {
      workspaceId: session.workspaceId,
      terminalId,
      text: state.drafts[terminalId] ?? '',
      expectedSince: session.since,
      projectName: decision.projectName,
      workspaceName: session.workspaceName,
      title: session.title
    })
    state.receipts[terminalId] = result
    if (result.status === 'sent') delete state.drafts[terminalId]
  } catch {
    state.receipts[terminalId] = { status: 'failed', at: Date.now() }
  } finally {
    delete state.sending[terminalId]
    // A Ctrl+Enter send leaves the focus in this card's box; let the page redraw.
    const active = document.activeElement as HTMLElement | null
    if (active?.dataset?.terminal === terminalId) active.blur()
    draw()
  }
}

const actions: Actions = {
  refresh: () => void refresh(true),
  openPicker: () => void openPicker(),
  togglePick(projectId, on) {
    const ids = (state.picking ?? []).filter((id) => id !== projectId)
    state.picking = on ? [...ids, projectId] : ids
  },
  savePicker() {
    const projectIds = state.picking ?? []
    void orca.plugin.request('board.select-projects', { projectIds })
      .then(() => { state.picking = null; return refresh(true) })
      .catch((error: unknown) => { state.error = message(error); draw() })
  },
  closePicker() {
    state.picking = null
    draw()
  },
  draft(terminalId, text) {
    state.drafts[terminalId] = text
  },
  send: (decision) => void send(decision),
  focus(session) {
    void orca.plugin.request('board.focus', { terminalId: session.terminalId, workspaceId: session.workspaceId }).catch(() => undefined)
  },
  dismiss(key) {
    void orca.plugin.request('board.dismiss', { key }).catch((error: unknown) => { state.error = message(error); draw() })
  },
  openUrl(url) {
    void orca.shell?.openExternal(url)
  },
  toggle(key, open) {
    state.open[key] = open
  }
}

// Orca waits for an editor to ask for its file. The key file carries nothing the board needs.
void orca.document?.get().catch(() => undefined)
orca.plugin.on('board.changed', () => void refresh())
orca.on('agent.status.changed', soon)
orca.on('workspace.created', soon)
orca.on('workspace.removed', soon)
setInterval(() => void refresh(), REFRESH_MS)
void refresh()
