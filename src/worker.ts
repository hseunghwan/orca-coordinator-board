// The plugin's worker: serves the board's read requests from Orca's CLI with the ported Paseo
// server code, keeps the status bar count, and opens the dashboard tab.
import type { OrcaWorkerApi } from 'orca/worker'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { identifyCaller } from './channel/caller'
import { withChannel } from './channel/hook'
import { channelPath } from './channel/path'
import { EXIT, type ChannelReply, type ChannelRequest } from './channel/protocol'
import { serveChannel } from './channel/server'
import { run } from './github'
import { translator } from './i18n'
import { createFleet, workspaceKey, type Fleet, type SessionId, type World, type WorkspaceRecord } from './orca'
import { noSignals, reduceSignals, type Observation } from './orca/signals'
import { createCli, hostCli, type OrcaCli, type Runner } from './orca/cli'
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
  /** The coordinator channel; null leaves it closed (tests that do not use it). */
  channel: ChannelDeps | null
}

export type ChannelDeps = {
  /** The pipe or socket to listen on. */
  path: string
  /** The plugin's bin folder. */
  bin: string
  /** The runtime the shims run the CLI with. */
  node: string
}

const LOCALE = 'locale'
/** The board's own terminal that chat mail is sent from: { terminalId, workspaceId }. */
const MAILBOX = 'mailbox'
const MAILBOX_TITLE = 'Coordinator Board mail'
const LEGACY_SELECTION = 'selectedProjects'
/** The HMAC key of the channel's caller tokens; made once. */
const CHANNEL_SECRET = 'channelSecret'
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
  // orchestration send from the worker, a process in no Orca terminal, needs --from. The board opens one
  // quiet shell terminal of its own and reuses it while it lives; replies to its mail land in its
  // mailbox. It lives in the coordinator's workspace, and moves there when the coordinator does;
  // before there is a coordinator, in the board's coordinator home, so it never opens in a person's project.
  async function hostWorkspace(ws: WorkspaceRecord | null | undefined): Promise<string | null> {
    if (!ws || (ws.hostId && ws.hostId !== 'local')) return null
    if (ws.listId) return ws.listId
    const { workspaces } = await orca.host.call('workspace.list', {})
    const key = workspaceKey(ws)
    return workspaces.find((w) => key && workspaceKey(w) === key)?.id ?? null
  }
  async function coordinatorWorkspace(): Promise<string | null> {
    const id = board.coordinator()
    if (!id) return null
    const world = await fleet.view()
    const session = world.sessions.get(id as SessionId)
    return hostWorkspace(session ? world.workspaces.get(session.worktree) : undefined)
  }
  async function homeWorkspace(): Promise<string | null> {
    if (!fleet.home) return null
    await fleet.home.ensure(translator(locale))
    fleet.invalidate()
    return hostWorkspace(fleet.home.workspace(await fleet.view({ maxAgeMs: 0 })))
  }
  async function mailSender(): Promise<string | null> {
    const saved = await orca.storage.get(MAILBOX).catch(() => null) as { terminalId?: unknown; workspaceId?: unknown } | null
    const target = await coordinatorWorkspace().catch(() => null) ?? await homeWorkspace().catch((error: unknown) => {
      orca.log(`coordinator home failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    let alive = false
    if (typeof saved?.terminalId === 'string' && typeof saved.workspaceId === 'string') {
      const listed = await orca.host.call('terminal.list', { workspaceId: saved.workspaceId }).catch(() => null)
      alive = !!listed?.terminals.some((terminal) => terminal.id === saved.terminalId)
      if (alive && (!target || target === saved.workspaceId)) return saved.terminalId as string
      if (alive) await orca.host.call('terminal.close', { terminalId: saved.terminalId as string }).catch(() => undefined)
    }
    if (!target) return null
    try {
      const { terminalId } = await orca.host.call('terminal.create', { workspaceId: target, title: MAILBOX_TITLE })
      await orca.storage.set(MAILBOX, { terminalId, workspaceId: target })
      orca.log(alive ? 'moved the board mail terminal' : 'opened the board mail terminal')
      return terminalId
    } catch (error) {
      orca.log(`board mail terminal failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  const fleet: Fleet = createFleet(deps.cli, Date.now, { dataDir: deps.dataDir, mailSender })
  let locale = 'en'
  const board = contribute(rpcServer((name, handler) => orca.panels.handle(name, handler), fleet.paseo), fleet, deps.dataDir, deps.pulls, {
    t: () => translator(locale),
    bin: deps.channel?.bin ?? '',
    focusedWorkspace: async () => (await orca.host.call('workspace.readContext', {}).catch(() => null))?.workspaceId ?? null
  })
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
      void board.adoptCoordinator().then((adopted) => {
        if (!adopted || stopped) return
        board.invalidate()
        orca.panels.post(BOARD_CHANGED, {})
      }, (error: unknown) => orca.log(`coordinator adoption failed: ${error instanceof Error ? error.message : String(error)}`))
    }, CHANGE_DEBOUNCE_MS)
  }
  // Paseo drains its queues from turn, permission, close and archive hooks; Orca reports state changes.
  let signalState = noSignals
  function observe(observation: Observation): void {
    const { state, signals } = reduceSignals(signalState, observation)
    signalState = state
    // The same observation moves the work items: Orca state mirrors running and awaiting-input, turn-ended leaves a done candidate.
    // An event is a state beginning now; a World read says when its state began.
    const states = observation.kind === 'status' ? [[observation.session, observation.state, Date.now()] as const]
      : observation.kind === 'world' ? [...observation.world.sessions].map(([id, session]) => [id, session.state, session.stateStartedAt] as const) : []
    try {
      if (board.track(states, signals)) changed()
    } catch (error) {
      orca.log(`work item update failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const signal of signals) {
      void board.signal(signal).then(changed, (error: unknown) => orca.log(`queued reply check failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  orca.events.on('agent.status.changed', (event) => {
    changed()
    const world = fleet.peek()
    const session = world && [...world.sessions.values()].find((s) => s.paneKey === event.paneKey || (!!event.terminalId && s.handle === event.terminalId))
    if (session) observe({ kind: 'status', session: session.id, state: event.state })
  })
  orca.events.on('workspace.removed', (event) => {
    changed()
    const world = fleet.peek()
    if (!world) return
    const key = workspaceKey({ id: event.workspaceId, path: event.path })
    const gone = [...world.workspaces.values()].filter((w) => w.id === event.workspaceId || w.listId === event.workspaceListId || (key && workspaceKey(w) === key))
    observe({ kind: 'workspace-removed', sessions: [...world.sessions.values()].filter((s) => gone.some((w) => w.id === s.worktree)).map((s) => s.id) })
  })

  let seen: string | null = null
  async function poll(): Promise<void> {
    try {
      const world = await fleet.view({ maxAgeMs: 0 })
      const now = fingerprint(world)
      if (seen !== null && now !== seen) changed()
      seen = now
      observe({ kind: 'world', world })
      void board.watchWork(world).then((moved) => { if (moved) changed() }, (error: unknown) => orca.log(`work item check failed: ${error instanceof Error ? error.message : String(error)}`))
      void board.resumeWaiting().then((checked) => { if (checked) changed() }, (error: unknown) => orca.log(`queued reply check failed: ${error instanceof Error ? error.message : String(error)}`))
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
      if (board.reopened(session.id)) changed()
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

  const secret: Promise<string> = orca.storage.get(CHANNEL_SECRET).then(async (value) => {
    if (typeof value === 'string' && value.length >= 64) return value
    const made = randomBytes(32).toString('hex')
    await orca.storage.set(CHANNEL_SECRET, made)
    return made
  })
  secret.catch((error: unknown) => orca.log(`channel secret failed: ${error instanceof Error ? error.message : String(error)}`))

  async function answerChannel(request: ChannelRequest, exec: Runner | null): Promise<ChannelReply> {
    const world = await fleet.view({ maxAgeMs: 0 })
    const caller = identifyCaller(request.caller, await secret, world)
    if ('denied' in caller) return { exit: EXIT.denied, text: caller.denied }
    if (board.audience(request.command) === 'coordinator' && (caller.via !== 'terminal' || board.coordinator() !== caller.sessionId)) {
      return { exit: EXIT.denied, text: caller.via === 'chat' ? '채팅 세션은 report만 쓸 수 있습니다.' : '지금 지정된 코디네이터만 쓸 수 있는 명령입니다.' }
    }
    try {
      // One orca at a time in the caller's shell.
      const result = await board.command(request.command, request.input, caller.sessionId, exec ? createCli(exec, Date.now, 1) : null)
      if (request.command !== 'read') changed()
      return { exit: result.isError ? EXIT.error : EXIT.ok, text: result.text }
    } catch (error) {
      return { exit: EXIT.error, text: error instanceof Error ? error.message : String(error) }
    }
  }

  let channel: { close(): Promise<void> } | null = null
  const channelDeps = deps.channel
  if (channelDeps) {
    serveChannel(channelDeps.path, answerChannel).then((server) => {
      if (stopped) void server.close()
      else channel = server
    }, (error: unknown) => orca.log(`coordinator channel did not open: ${error instanceof Error ? error.message : String(error)}`))
    orca.hooks.on('agent.launch.before', async (event, next) => {
      // Key names only: which PATH spelling Orca hands the hook decides whether the bin reaches the agent.
      orca.log(`launch hook: PATH keys in the launch env: ${Object.keys(event.env).filter((key) => key.toUpperCase() === 'PATH').join(', ') || 'none'}`)
      return next(withChannel(event, { pipe: channelDeps.path, bin: channelDeps.bin, node: channelDeps.node, secret: await secret, delimiter }, board.pendingLaunches()))
    })
  }

  return () => {
    stopped = true
    void channel?.close()
    if (timer) clearInterval(timer)
    if (changeTimer) clearTimeout(changeTimer)
    localeWatch.dispose()
  }
}

let stop: (() => void) | undefined

/** The plugin folder: dist/worker.mjs sits one level below it. */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export default function activate(orca: OrcaWorkerApi): void {
  stop = activateWith(orca, {
    cli: hostCli(), dataDir: join(homedir(), '.orca-coordinator-board'), files: hostFiles, pollMs: POLL_MS,
    channel: { path: channelPath(PLUGIN_ROOT, process.platform, tmpdir()), bin: join(PLUGIN_ROOT, 'bin'), node: process.execPath }
  })
}

export function deactivate(): void {
  stop?.()
  stop = undefined
}
