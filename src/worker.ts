// The plugin's worker: reads projects, workspaces and agents from Orca, pull requests through
// git and gh, and types the person's replies into session terminals.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { commandEnv, GH_FIELDS, GH_PROJECTION, githubRepository, parseOpenPulls, SCAN_LIMIT } from './github'
import { translator } from './i18n'
import { DASHBOARD_FILE, dashboardFileText, focusedWorkspace, statusItem, withExcludeLine } from './summary'
import {
  buildBoard, cleanTail, isResumeAgent, remember, replyGuard, resumeGuard, strings,
  type BoardView, type ProjectPulls, type PullItem, type RawAgent, type RawHistorySession, type RawProject, type ReplyRecord, type ReplyStatus
} from './model'

export type GithubDeps = {
  originOf(path: string): Promise<string | null>
  openPulls(repo: string): Promise<{ status: 'ok' | 'truncated'; items: PullItem[] }>
  now(): number
}

export type FileDeps = {
  /** Writes the dashboard key file in a local checkout and hides it from git. */
  ensureDashboard(root: string): Promise<void>
}

export type WorkerOptions = {
  files?: FileDeps
  /** How often the status bar count is read again; 0 turns the background read off (tests). */
  pollMs?: number
}

const SELECTED = 'selectedProjects'
const DISMISSED = 'dismissed'
const REPLIES = 'replies'
const LOCALE = 'locale'
export const STATUS_ITEM = 'waiting'
export const OPEN_DASHBOARD = 'open-dashboard'
const POLL_MS = 30_000
const MAX_WORKSPACES = 60
const MAX_TAILS = 12
const TTL = 60_000
const FAILED_TTL = 15_000

// shell:false, a timeout and a buffer cap; commandEnv turns prompts off.
function run(command: 'git' | 'gh', args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: command === 'gh' ? 15_000 : 3_000,
      maxBuffer: 2 * 1024 * 1024,
      env: commandEnv(process.env, process.platform)
    }, (error: Error | null, stdout: string | Buffer) => (error ? reject(error) : resolve(String(stdout))))
  })
}

export const hostGithub: GithubDeps = {
  async originOf(path) {
    // A nested non-Git folder would otherwise inherit a parent repository from git -C.
    if (!(await isCheckout(path))) return null
    try {
      return githubRepository(await run('git', ['-C', path, 'remote', 'get-url', 'origin']))
    } catch {
      return null
    }
  },
  async openPulls(repo) {
    return parseOpenPulls(repo, await run('gh', [
      'pr', 'list', '--repo', 'github.com/' + repo, '--state', 'open',
      '--limit', String(SCAN_LIMIT + 1), '--json', GH_FIELDS, '--jq', GH_PROJECTION
    ]))
  },
  now: () => Date.now()
}

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

async function mapLimited<V, R>(items: readonly V[], limit: number, fn: (item: V) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index])
    }
  }))
  return out
}

type Entry<V> = { expires: number; value: Promise<V> }

function replyRecords(value: unknown): ReplyRecord[] {
  return Array.isArray(value) ? (value as ReplyRecord[]).filter((row) => row && typeof row.at === 'number') : []
}

export function activateWith(orca: OrcaWorkerApi, github: GithubDeps, options: WorkerOptions = {}): () => void {
  const files = options.files ?? hostFiles
  const pollMs = options.pollMs ?? POLL_MS
  let locale = 'en'
  void orca.storage.get(LOCALE).then((value) => { if (typeof value === 'string') locale = value }, () => undefined)
  const origins = new Map<string, Entry<string | null>>()
  const pullLists = new Map<string, Entry<{ status: 'ok' | 'truncated' | 'unavailable'; items: PullItem[] }>>()

  function cached<V>(map: Map<string, Entry<V>>, key: string, refresh: boolean, load: () => Promise<V>, ttl: (value: V) => number): Promise<V> {
    const hit = map.get(key)
    // A lookup still running is shared, even by a refresh.
    if (hit && (hit.expires === Infinity || (!refresh && hit.expires > github.now()))) return hit.value
    const entry: Entry<V> = { expires: Infinity, value: load() }
    map.set(key, entry)
    entry.value.then(
      (value) => { entry.expires = github.now() + ttl(value) },
      () => { if (map.get(key) === entry) map.delete(key) }
    )
    return entry.value
  }

  async function agentsOf(workspaceId: string): Promise<RawAgent[]> {
    // Checked live on Orca 1.4.272: agents.list takes the id workspace.list gives.
    return (await orca.host.call('agents.list', { workspaceId })).agents
  }

  async function pullsFor(project: RawProject, refresh: boolean): Promise<ProjectPulls> {
    if (project.hostId && project.hostId !== 'local') return { repo: null, status: 'remote', items: [] }
    const repo = await cached(origins, project.path, refresh, () => github.originOf(project.path), () => TTL)
    if (!repo) return { repo: null, status: 'unmapped', items: [] }
    const list = await cached(pullLists, repo, refresh, async () => {
      try {
        return await github.openPulls(repo)
      } catch (error) {
        const { code, stderr } = error as { code?: unknown; stderr?: unknown }
        orca.log(`gh pr list failed for ${repo}: exit ${String(code ?? '')}: ${String(stderr ?? '').trim().slice(0, 300)}`)
        return { status: 'unavailable' as const, items: [] }
      }
    }, (value) => (value.status === 'unavailable' ? FAILED_TTL : TTL))
    return { repo, status: list.status, items: list.items }
  }

  async function readHistory(workspaceId?: string): Promise<RawHistorySession[] | undefined> {
    try {
      const { sessions } = await orca.host.call('agent.listSessions', workspaceId ? { workspaceId, limit: 200 } : { limit: 200 })
      return sessions
    } catch (error) {
      orca.log(`agent history unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  type ReadOptions = { pulls: boolean; tails: boolean }
  async function readBoard(refresh: boolean, read: ReadOptions = { pulls: true, tails: true }): Promise<BoardView> {
    const [projectList, workspaceList, selectedRaw, dismissedRaw, repliesRaw] = await Promise.all([
      orca.host.call('project.list', {}),
      orca.host.call('workspace.list', { includeStatus: true }),
      orca.storage.get(SELECTED),
      orca.storage.get(DISMISSED),
      orca.storage.get(REPLIES)
    ])
    const projects: RawProject[] = projectList.projects
    const selected = strings(selectedRaw).filter((id) => projects.some((project) => project.id === id))
    const workspaces = workspaceList.workspaces.filter((w) => w.projectId != null && selected.includes(w.projectId))
    // Ask every workspace: Orca lists agents even where the terminal count is 0.
    const scanned = workspaces.slice(0, MAX_WORKSPACES)
    let truncated = projectList.truncated || workspaceList.truncated || workspaces.length > scanned.length
    const agents = new Map<string, RawAgent[]>()
    await mapLimited(scanned, 4, async (workspace) => {
      try {
        agents.set(workspace.id, await agentsOf(workspace.id))
      } catch {
        truncated = true
      }
    })
    const chosen = projects.filter((project) => selected.includes(project.id))
    const pulls = new Map(read.pulls ? await mapLimited(chosen, 3, async (project) => [project.id, await pullsFor(project, refresh)] as const) : [])
    // Closed sessions come from Orca's history (history:read); without it the board just shows none.
    const history = read.pulls ? await readHistory() : undefined
    const board = buildBoard({
      projects, selected, workspaces, agents, pulls,
      dismissed: new Set(strings(dismissedRaw)),
      replies: replyRecords(repliesRaw).slice(-20).reverse(),
      history,
      now: github.now(),
      truncated
    })
    if (!read.tails) return board
    const waiting = board.decisions.filter((d) => d.kind === 'reply' && d.session?.terminalId).slice(0, MAX_TAILS)
    await mapLimited(waiting, 4, async (decision) => {
      try {
        const output = await orca.host.call('terminal.read', { terminalId: decision.session!.terminalId!, maxLines: 60 })
        decision.tail = cleanTail(output.lines)
      } catch {
        // The card still works without recent output.
      }
    })
    return board
  }

  // The status bar shows how many sessions wait for the person. A board read by a panel or the
  // dashboard updates it at once; otherwise the worker reads sessions alone (no gh, no terminal output).
  let statusRun: Promise<void> | null = null
  let statusTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  async function showStatus(view: BoardView | null): Promise<void> {
    if (stopped) return
    try {
      await orca.host.call('statusBar.update', { id: STATUS_ITEM, ...statusItem(translator(locale), view) })
    } catch {
      // The browser client has no status bar.
    }
  }
  function updateStatus(): Promise<void> {
    statusRun ??= readBoard(false, { pulls: false, tails: false })
      .then((view) => showStatus(view), () => undefined)
      .finally(() => { statusRun = null })
    return statusRun
  }
  function statusSoon(): void {
    if (stopped) return
    if (statusTimer) clearTimeout(statusTimer)
    statusTimer = setTimeout(() => { statusTimer = undefined; void updateStatus() }, 500)
  }
  const poll = pollMs > 0 ? setInterval(() => void updateStatus(), pollMs) : undefined
  if (pollMs > 0) void updateStatus()

  orca.panels.handle('board.read', async (input) => {
    if (typeof input?.locale === 'string' && input.locale && input.locale !== locale) {
      locale = input.locale.slice(0, 35)
      await orca.storage.set(LOCALE, locale)
    }
    const board = await readBoard(input?.refresh === true)
    void showStatus(board)
    return board
  })

  orca.panels.handle('board.projects', async () => {
    const [{ projects }, selected] = await Promise.all([orca.host.call('project.list', {}), orca.storage.get(SELECTED)])
    return {
      projects: projects
        .filter((project) => !project.hidden)
        .map((project) => ({ id: project.id, name: project.name, path: project.path, remote: !!project.hostId && project.hostId !== 'local' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      selected: strings(selected)
    }
  })

  orca.panels.handle('board.select-projects', async (input) => {
    const { projects } = await orca.host.call('project.list', {})
    const known = new Set(projects.map((project) => project.id))
    const selected = [...new Set(strings(input?.projectIds))].filter((id) => known.has(id))
    await orca.storage.set(SELECTED, selected)
    orca.panels.post('board.changed', { at: github.now() })
    statusSoon()
    return { selected }
  })

  // Orca types only into terminals of the focused workspace, so a reply first shows its session.
  // Only a person pressing send gets here; the window moves to the session they answered.
  async function typeInto(terminalId: string, text: string): Promise<boolean> {
    const inFocus = async () => {
      const context = await orca.host.call('workspace.readContext', {}).catch(() => null)
      return !!context?.terminals.some((terminal) => terminal.id === terminalId)
    }
    if (!(await inFocus())) {
      const moved = await orca.host.call('terminal.focus', { terminalId }).catch(() => ({ focused: false }))
      if (!moved.focused) return false
      let shown = false
      for (let tries = 0; tries < 20 && !(shown = await inFocus()); tries += 1) await new Promise((done) => setTimeout(done, 100))
      if (!shown) return false
    }
    const sent = await orca.host.call('terminal.sendText', { terminalId, text, enter: true })
    return sent.accepted
  }

  orca.panels.handle('board.reply', async (input) => {
    const at = github.now()
    const text = typeof input?.text === 'string' ? input.text : ''
    let status: ReplyStatus | null = null
    if (typeof input?.workspaceId !== 'string' || typeof input?.terminalId !== 'string' || typeof input?.expectedSince !== 'number') {
      status = 'gone'
    } else {
      // Re-read the agent now: the card may be minutes old.
      let agents: RawAgent[] = []
      try { agents = await agentsOf(input.workspaceId) } catch { /* gone */ }
      const agent = agents.find((row) => row.terminalId === input.terminalId)
      status = replyGuard(agent, text, input.expectedSince)
      if (!status) {
        // The person wrote this text and pressed send, so it goes as typed, without a board label.
        // Never retry: a send that may have landed must not be typed twice.
        try {
          status = (await typeInto(input.terminalId, text.trimEnd())) ? 'sent' : 'failed'
        } catch (error) {
          orca.log(`reply failed: ${error instanceof Error ? error.message : String(error)}`)
          status = 'failed'
        }
      }
    }
    const record: ReplyRecord = {
      projectName: String(input?.projectName ?? '').slice(0, 200),
      workspaceName: String(input?.workspaceName ?? '').slice(0, 200),
      title: String(input?.title ?? '').slice(0, 200),
      text: text.slice(0, 2000),
      status,
      at
    }
    await orca.storage.set(REPLIES, remember(replyRecords(await orca.storage.get(REPLIES)), record, 50))
    orca.panels.post('board.changed', { at })
    statusSoon()
    return { status, at }
  })

  // A resumed agent starts in a new terminal: wait until its screen has drawn and stopped changing.
  async function settled(terminalId: string, timeoutMs = 30_000): Promise<boolean> {
    let last = ''
    let same = 0
    for (const end = Date.now() + timeoutMs; Date.now() < end;) {
      await new Promise((done) => setTimeout(done, 500))
      const output = await orca.host.call('terminal.read', { terminalId, maxLines: 40 }).catch(() => null)
      const text = output ? output.lines.join('\n').trim() : ''
      same = text && text === last ? same + 1 : 0
      last = text
      if (same >= 3) return true
    }
    return false
  }

  orca.panels.handle('board.resume-reply', async (input) => {
    const at = github.now()
    const text = typeof input?.text === 'string' ? input.text : ''
    let status: ReplyStatus
    if (typeof input?.workspaceId !== 'string' || typeof input?.sessionId !== 'string' || typeof input?.agent !== 'string') {
      status = 'gone'
    } else {
      // Read again now: the session may have been opened somewhere since the card was drawn.
      const [live, history] = await Promise.all([agentsOf(input.workspaceId).catch(() => undefined), readHistory(input.workspaceId)])
      const row = history?.find((session) => session.sessionId === input.sessionId)
      const refused = resumeGuard({ text, sessionId: input.sessionId, agent: input.agent, row, live })
      status = refused ?? 'failed'
      if (!refused && isResumeAgent(input.agent)) {
        // The person wrote this text and pressed send: it goes as typed. Never retried.
        try {
          const resumed = await orca.host.call('agent.resume', { workspaceId: input.workspaceId, agent: input.agent, sessionId: input.sessionId })
          orca.log(`resume reply: ${resumed.started ? 'started' : 'already running'} in ${resumed.terminalId}`)
          if (await settled(resumed.terminalId)) status = (await typeInto(resumed.terminalId, text.trimEnd())) ? 'sent' : 'failed'
          else orca.log('resume reply: the resumed terminal did not settle; nothing typed')
        } catch (error) {
          orca.log(`resume reply failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    const record: ReplyRecord = {
      projectName: String(input?.projectName ?? '').slice(0, 200),
      workspaceName: String(input?.workspaceName ?? '').slice(0, 200),
      title: String(input?.title ?? '').slice(0, 200),
      text: text.slice(0, 2000),
      status,
      at
    }
    await orca.storage.set(REPLIES, remember(replyRecords(await orca.storage.get(REPLIES)), record, 50))
    orca.panels.post('board.changed', { at })
    statusSoon()
    return { status, at }
  })

  orca.panels.handle('board.focus', async (input) => {
    try {
      if (typeof input?.terminalId === 'string') return await orca.host.call('terminal.focus', { terminalId: input.terminalId })
      // A chat tab has no terminal Orca lets a plugin reach: show its workspace instead.
      if (typeof input?.workspaceId === 'string') return { focused: (await orca.host.call('workspace.open', { workspaceId: input.workspaceId })).opened }
    } catch { /* not focusable */ }
    return { focused: false }
  })

  orca.panels.handle('board.dismiss', async (input) => {
    if (typeof input?.key === 'string' && input.key.length <= 1024) {
      await orca.storage.set(DISMISSED, remember(strings(await orca.storage.get(DISMISSED)).filter((key) => key !== input.key), input.key, 300))
      orca.panels.post('board.changed', { at: github.now() })
      statusSoon()
    }
    return { ok: true as const }
  })

  // The status bar item and the palette open the dashboard: an editor tab on a key file in the
  // focused workspace, drawn by src/dashboard/ with the same requests as the panel.
  orca.commands.register(OPEN_DASHBOARD, async () => {
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
      await files.ensureDashboard(workspace.path)
      await orca.host.call('editor.open', { workspaceId: workspace.id, path: DASHBOARD_FILE })
      orca.log('open dashboard: opened')
      return undefined
    } catch (error) {
      orca.log(`open dashboard failed: ${error instanceof Error ? error.message : String(error)}`)
      return t('대시보드를 열지 못했습니다.', 'Could not open the dashboard.')
    }
  })

  return () => {
    stopped = true
    if (poll) clearInterval(poll)
    if (statusTimer) clearTimeout(statusTimer)
  }
}

let stop: (() => void) | undefined

export default function activate(orca: OrcaWorkerApi): void {
  stop = activateWith(orca, hostGithub)
}

export function deactivate(): void {
  stop?.()
  stop = undefined
}
