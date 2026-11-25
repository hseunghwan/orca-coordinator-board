// What the status bar item, the dashboard header and the dashboard's project cards show, and the
// small key file the dashboard tab opens on. No Orca or DOM imports: tests run it directly.
import type { T } from './i18n'
import type { AgentState, BoardView, ProjectLane, SessionRow } from './model'

export type Counts = { permission: number; reply: number; review: number; working: number }

export function waitingCounts(view: BoardView): Counts {
  const counts: Counts = { permission: 0, reply: 0, review: 0, working: 0 }
  for (const decision of view.decisions) counts[decision.kind] += 1
  for (const lane of view.projects) counts.working += lane.sessions.filter((session) => session.state === 'working').length
  return counts
}

export type StatusTone = 'neutral' | 'accent' | 'warning'
export type StatusItem = { text: string; tone: StatusTone; tooltip: string }

/** The status bar item: sessions waiting for the person (permission + reply). Pull requests are not counted. */
export function statusItem(t: T, view: BoardView | null): StatusItem {
  if (!view || !view.selected.length) {
    return { text: t('보드', 'Board'), tone: 'neutral', tooltip: t('코디네이터 보드: 눌러서 프로젝트를 고르세요', 'Coordinator Board: click to choose projects') }
  }
  const counts = waitingCounts(view)
  const waiting = counts.permission + counts.reply
  return {
    text: waiting ? t(`기다림 ${waiting}`, `${waiting} waiting`) : t('기다림 없음', 'Nothing waiting'),
    // Permission first: only the session itself can clear it.
    tone: counts.permission ? 'warning' : counts.reply ? 'accent' : 'neutral',
    tooltip: [
      `${t('권한 대기', 'Permission')} ${counts.permission}`,
      `${t('답 기다림', 'Waiting for you')} ${counts.reply}`,
      `${t('작업 중', 'Working')} ${counts.working}`
    ].join(' · ') + t(' · 눌러서 대시보드 열기', ' · Click to open the dashboard')
  }
}

const RANK: Record<AgentState, number> = { blocked: 0, waiting: 1, working: 2, done: 3 }

export type LaneGroups = { active: SessionRow[]; done: SessionRow[]; counts: Record<AgentState, number> }

/** A project card's sessions: those that need someone first, finished ones apart. */
export function laneGroups(lane: ProjectLane): LaneGroups {
  const counts: Record<AgentState, number> = { blocked: 0, waiting: 0, working: 0, done: 0 }
  for (const session of lane.sessions) counts[session.state] += 1
  const sorted = [...lane.sessions].sort((a, b) => RANK[a.state] - RANK[b.state] || b.since - a.since)
  return { active: sorted.filter((session) => session.state !== 'done'), done: sorted.filter((session) => session.state === 'done'), counts }
}

export function ago(t: T, now: number, at: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return t('방금', 'just now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t(`${minutes}분 전`, `${minutes}m ago`)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t(`${hours}시간 전`, `${hours}h ago`)
  return t(`${Math.round(hours / 24)}일 전`, `${Math.round(hours / 24)}d ago`)
}

// The dashboard opens as an editor tab on a key file in the focused workspace. The file holds no
// board data; .git/info/exclude keeps it out of git without adding a tracked .gitignore.
export const DASHBOARD_DIR = '.coordinator-board'
export const DASHBOARD_FILE = DASHBOARD_DIR + '/board.coordinator-board'
export const EXCLUDE_LINE = '/' + DASHBOARD_DIR + '/'

export function dashboardFileText(): string {
  return JSON.stringify({ coordinatorBoard: 1, note: 'Opens the Coordinator Board dashboard in Orca. The board keeps no data here.' }, null, 2) + '\n'
}

/** The exclude file with the dashboard folder added, or null when it is already there. */
export function withExcludeLine(current: string): string | null {
  const present = current.split(/\r?\n/).map((line) => line.trim())
    .some((line) => line === EXCLUDE_LINE || line === DASHBOARD_DIR + '/' || line === '/' + DASHBOARD_DIR || line === DASHBOARD_DIR)
  if (present) return null
  const head = current && !current.endsWith('\n') ? current + '\n' : current
  return head + '# Coordinator Board (Orca plugin): the dashboard key file\n' + EXCLUDE_LINE + '\n'
}

export type WorkspaceRow = { id: string; name: string; path: string; branch: string | null }
export type FocusContext = { workspaceId?: string; branch: string; displayName: string } | null

function samePath(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The `workspace.list` row of the focused workspace. Orca names a workspace in more than one way
 * (`identity:...`, `folder:...`, `<project>::<path>`), so after the id this tries the path in a
 * `::` id, then a unique name and branch.
 */
export function focusedWorkspace<W extends WorkspaceRow>(context: FocusContext, workspaces: readonly W[]): W | undefined {
  if (!context) return undefined
  const id = context.workspaceId
  if (id) {
    const exact = workspaces.find((row) => row.id === id)
    if (exact) return exact
    const cut = id.indexOf('::')
    if (cut >= 0) {
      const path = id.slice(cut + 2)
      const byPath = workspaces.filter((row) => samePath(row.path, path))
      if (byPath.length === 1) return byPath[0]
    }
  }
  if (!context.displayName) return undefined
  const byName = workspaces.filter((row) => row.name === context.displayName && (row.branch ?? '') === context.branch)
  return byName.length === 1 ? byName[0] : undefined
}
