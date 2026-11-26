// The plugin's worker: serves the board's read requests from Orca's CLI with the ported Paseo
// server code, keeps the status bar count, and opens the dashboard tab.
import type { OrcaWorkerApi } from 'orca/worker'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { run } from './github'
import { translator } from './i18n'
import { createFleet, workspaceKey, type Fleet, type SessionId, type World } from './orca'
import { hostCli, type OrcaCli } from './orca/cli'
import { contribute, type PullDeps } from './server/board'
import { rpcServer } from './server/rpc'
import { DASHBOARD_FILE, dashboardFileText, focusedWorkspace, statusItem, withExcludeLine } from './summary'

export type FileDeps = {
  /** Writes the dashboard key file in a local checkout and hides it from git. */
  ensureDashboard(root: string): Promise<void>
}

export type WorkerDeps = {
  cli: OrcaCli
  /** Where the board keeps its scope, notes and receipts (Paseo's plugin-data folder). */
  dataDir: string
  files: FileDeps
  /** How often Orca is read again for the status bar and for changes no event reports; 0 turns it off (tests). */
  pollMs: number
  /** git and gh lookups for pull requests; the real ones when absent. */
  pulls?: PullDeps
}

const LOCALE = 'locale'
const LEGACY_SELECTION = 'selectedProjects'
export const STATUS_ITEM = 'waiting'
export const OPEN_DASHBOARD = 'open-dashboard'
const POLL_MS = 30_000
const CHANGE_DEBOUNCE_MS = 500
// Typed as a plain string so the post stays the contract's bare change signal, whatever the frame declares.
const BOARD_CHANGED: string = 'board.changed'

/** A folder with its own .git, not one nested in another repository. */
async function isCheckout(path: string): Promise<boolean> {
  if (!isAbsolute(path)) return false
  try {
    const marker = await stat(join(path, '.git'))
    return marker.isFile() || marker.isDirectory()
  } catch {
    return false
  }
}

export const hostFiles: FileDeps = {
  async ensureDashboard(root) {
    if (!isAbsolute(root)) throw new Error('not a local path')
    const target = join(root, DASHBOARD_FILE)
    await mkdir(dirname(target), { recursive: true })
    const text = dashboardFileText()
    if ((await readFile(target, 'utf8').catch(() => null)) !== text) await writeFile(target, text)
    if (!(await isCheckout(root))) return
    // A worktree's .git is a file; git names the exclude file the checkout really reads.
    const reported = (await run('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'])).trim()
    if (!reported) return
    const exclude = isAbsolute(reported) ? reported : join(root, reported)
    const next = withExcludeLine(await readFile(exclude, 'utf8').catch(() => ''))
    if (next === null) return
    await mkdir(dirname(exclude), { recursive: true })
    await writeFile(exclude, next)
  }
}

/** What a session looks like to a change check: polling sees chat sessions that send no events. */
function fingerprint(world: World): string {
  return [...world.sessions.values()].map((s) => `${s.id}:${s.state}:${s.updatedAt}:${s.unread}`).sort().join('|')
}

const openSession = z.object({ sessionId: z.string().min(1).max(256) })

export function activateWith(orca: OrcaWorkerApi, deps: WorkerDeps): () => void {
  const fleet: Fleet = createFleet(deps.cli)
  const board = contribute(rpcServer((name, handler) => orca.panels.handle(name, handler), fleet.paseo), fleet, deps.dataDir, deps.pulls)
  let locale = 'en'
  let stopped = false
  void orca.storage.get(LEGACY_SELECTION).then(async (value) => {
    if (Array.isArray(value) && board.adoptLegacySelection(value)) {
      orca.log(`took ${value.length} project(s) chosen in version 0.1`)
      changed()
    }
    await orca.storage.delete(LEGACY_SELECTION)
  }, () => undefined)
  const readLocale = () => orca.storage.get(LOCALE).then((value) => { if (typeof value === 'string' && value) locale = value }, () => undefined)
  void readLocale()
  const localeWatch = orca.storage.onDidChange((change) => { if (change.key === LOCALE) void readLocale() })

  let statusRun: Promise<void> | null = null
  function updateStatus(): Promise<void> {
    statusRun ??= board.count()
      .then((count) => ({ count, failed: false }), (error: unknown) => {
        orca.log(`board count failed: ${error instanceof Error ? error.message : String(error)}`)
        return { count: null, failed: true }
      })
      .then(async ({ count, failed }) => {
        if (stopped) return
        // The browser client has no status bar.
        await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...statusItem(translator(locale), board.configured() ? count : null, failed) }).catch(() => undefined)
      })
      .finally(() => { statusRun = null })
    return statusRun
  }

  let changeTimer: ReturnType<typeof setTimeout> | undefined
  function changed(): void {
    if (stopped) return
    if (changeTimer) clearTimeout(changeTimer)
    // Once per burst: invalidating per event would restart a snapshot still being built.
    changeTimer = setTimeout(() => {
      changeTimer = undefined
      board.invalidate()
      orca.panels.post(BOARD_CHANGED, {})
      void updateStatus()
    }, CHANGE_DEBOUNCE_MS)
  }
  orca.events.on('agent.status.changed', changed)
  orca.events.on('workspace.removed', changed)

  let seen: string | null = null
  async function poll(): Promise<void> {
    try {
      const now = fingerprint(await fleet.view({ maxAgeMs: 0 }))
      if (seen !== null && now !== seen) changed()
      seen = now
    } catch {
      // updateStatus reports the failure.
    }
    await updateStatus()
  }
  const timer = deps.pollMs > 0 ? setInterval(() => void poll(), deps.pollMs) : undefined
  if (deps.pollMs > 0) void poll()

  // A terminal is focused by its handle; a chat, or a terminal asleep without one, by showing its workspace.
  orca.panels.handle('board.open-session', async (input) => {
    const { sessionId } = openSession.parse(input)
    try {
      const world = await fleet.view({ maxAgeMs: 0 })
      const session = world.sessions.get(sessionId as SessionId)
      if (!session) return { opened: false }
      if (session.handle) return { opened: (await orca.host.call('terminal.focus', { terminalId: session.handle })).focused }
      const ws = world.workspaces.get(session.worktree)
      if (!ws) return { opened: false }
      const { workspaces } = await orca.host.call('workspace.list', {})
      const key = workspaceKey({ id: ws.id, hostId: ws.hostId })
      const row = workspaces.find((w) => w.id === ws.listId) ?? workspaces.find((w) => key && workspaceKey(w) === key)
      if (!row) return { opened: false }
      return { opened: (await orca.host.call('workspace.open', { workspaceId: row.id })).opened }
    } catch (error) {
      orca.log(`open session failed: ${error instanceof Error ? error.message : String(error)}`)
      return { opened: false }
    }
  })

  // The status bar item, the palette and the panel open the dashboard: an editor tab on a key file
  // in the focused workspace, drawn by src/dashboard/. A string result says why it did not open.
  async function openDashboard(): Promise<string | undefined> {
    const t = translator(locale)
    const context = await orca.host.call('workspace.readContext', {}).catch((error: unknown) => {
      orca.log(`open dashboard: readContext failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    const { workspaces } = await orca.host.call('workspace.list', {})
    const workspace = focusedWorkspace(context, workspaces)
    orca.log(`open dashboard: focused ${context?.workspaceId ?? 'none'} -> ${workspace?.id ?? 'no match'}`)
    if (!workspace) {
      return t('워크스페이스를 하나 연 뒤 다시 누르세요. 대시보드는 지금 보고 있는 워크스페이스에 탭으로 열립니다.',
        'Open a workspace, then try again. The dashboard opens as a tab in the workspace you are looking at.')
    }
    if (workspace.hostId && workspace.hostId !== 'local') {
      return t('다른 호스트의 워크스페이스에서는 대시보드를 열 수 없습니다. 이 컴퓨터의 워크스페이스로 옮긴 뒤 누르세요.',
        'The dashboard cannot open in a workspace on another host. Switch to a workspace on this computer.')
    }
    try {
      await deps.files.ensureDashboard(workspace.path)
      await orca.host.call('editor.open', { workspaceId: workspace.id, path: DASHBOARD_FILE })
      orca.log('open dashboard: opened')
      return undefined
    } catch (error) {
      orca.log(`open dashboard failed: ${error instanceof Error ? error.message : String(error)}`)
      return t('대시보드를 열지 못했습니다.', 'Could not open the dashboard.')
    }
  }
  orca.commands.register(OPEN_DASHBOARD, openDashboard)
  orca.panels.handle('board.open-dashboard', async () => ({ message: (await openDashboard()) ?? null }))

  return () => {
    stopped = true
    if (timer) clearInterval(timer)
    if (changeTimer) clearTimeout(changeTimer)
    localeWatch.dispose()
  }
}

let stop: (() => void) | undefined

export default function activate(orca: OrcaWorkerApi): void {
  stop = activateWith(orca, { cli: hostCli(), dataDir: join(homedir(), '.orca-coordinator-board'), files: hostFiles, pollMs: POLL_MS })
}

export function deactivate(): void {
  stop?.()
  stop = undefined
}
