// What the status bar item, the dashboard header and the dashboard's project cards show, and the
// small key file the dashboard tab opens on. No Orca or DOM imports: tests run it directly.
import type { T } from './i18n'

export type StatusTone = 'neutral' | 'accent' | 'warning'
export type StatusItem = { text: string; tone: StatusTone; tooltip: string }

/** The status bar item: Paseo's decision count (src/paseo/shared/decision-count.ts); null before projects are chosen. */
export function statusItem(t: T, count: number | null, failed = false): StatusItem {
  const open = t(' · 눌러서 대시보드 열기', ' · Click to open the dashboard')
  if (failed) return { text: t('보드', 'Board'), tone: 'warning', tooltip: t('코디네이터 보드: Orca 세션을 읽지 못했습니다', 'Coordinator Board: could not read Orca sessions') + open }
  if (count === null) return { text: t('보드', 'Board'), tone: 'neutral', tooltip: t('코디네이터 보드: 눌러서 프로젝트를 고르세요', 'Coordinator Board: click to choose projects') }
  return {
    text: count ? t(`내 결정 ${count}`, `${count} to decide`) : t('결정 없음', 'Nothing to decide'),
    tone: count ? 'accent' : 'neutral',
    tooltip: t('코디네이터 보드', 'Coordinator Board') + open
  }
}

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
