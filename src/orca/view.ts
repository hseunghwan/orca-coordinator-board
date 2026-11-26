// Orca's state as one World, read from `orca worktree ps` and `orca repo list`, and the table that
// projects it onto the Paseo agent, workspace and project fields the ported server code reads.
import { z } from 'zod'

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

/** orca_session_id: the board's session id (Paseo agent id). A terminal agent gets a new one after /clear. */
export type SessionId = Brand<string, 'SessionId'>
/** Terminal "<tabId>:<leafId>"; chat "structured-agent-session-<SessionId>:<pane>". */
export type PaneKey = Brand<string, 'PaneKey'>
/** "term_<uuid>": the CLI handle, also the host's terminalId. */
export type TerminalHandle = Brand<string, 'TerminalHandle'>
/** "<repoId>::<path>" or "folder:<uuid>": the CLI worktree id, also the event's workspaceId. */
export type WorktreeId = Brand<string, 'WorktreeId'>
/** "identity:wt2:<host>:<uuid>" or "folder:<uuid>": the host workspace.list id, events' workspaceListId. */
export type WorkspaceListId = Brand<string, 'WorkspaceListId'>
/** orca repo list id: Paseo's projectId. */
export type RepoId = Brand<string, 'RepoId'>

export type OrcaState = 'working' | 'blocked' | 'waiting' | 'done'

const state = z.enum(['working', 'blocked', 'waiting', 'done'])
const text = z.string().nullish()

const psAgent = z.object({
  paneKey: z.string(),
  address: text,
  orcaSessionId: text,
  state,
  agentType: text,
  taskTitle: text,
  displayName: text,
  conversationName: text,
  lastAssistantMessage: text,
  toolName: text,
  toolInput: z.unknown(),
  mainAgent: z.object({ outcome: text }).nullish(),
  stateStartedAt: z.number(),
  updatedAt: z.number(),
  hasLivePty: z.boolean().nullish(),
  children: z.array(z.object({ state: text })).nullish(),
  activity: z.object({ listed: z.boolean().nullish(), unread: z.boolean().nullish(), title: text }).nullish()
})

const psWorktree = z.object({
  worktreeId: z.string(),
  repoId: z.string(),
  hostId: text,
  path: z.string(),
  branch: text,
  displayName: text,
  repo: text,
  isArchived: z.boolean().nullish(),
  address: z.object({ worktree: text }).nullish(),
  agents: z.array(psAgent).nullish()
})

export const worktreePs = z.object({ worktrees: z.array(psWorktree), truncated: z.boolean().nullish() })
export type WorktreePs = z.output<typeof worktreePs>

export const repoList = z.object({
  repos: z.array(z.object({
    id: z.string(),
    path: z.string(),
    displayName: z.string(),
    repoIcon: z.object({ src: text }).nullish(),
    gitRemoteIdentity: z.object({ remoteUrl: text }).nullish()
  }))
})
export type RepoList = z.output<typeof repoList>

export interface SessionRecord {
  readonly id: SessionId
  readonly paneKey: PaneKey
  readonly surface: 'terminal' | 'chat'
  readonly agent: string | null
  readonly state: OrcaState
  readonly stateStartedAt: number
  readonly updatedAt: number
  readonly outcome: string | null
  readonly title: string | null
  readonly tool: string | null
  readonly toolInput: string | null
  /** Terminal rows carry the whole last message; chat rows a 200-character head. */
  readonly lastAssistant: string | null
  readonly unread: boolean
  readonly livePty: boolean
  readonly handle: TerminalHandle | null
  readonly worktree: WorktreeId
  readonly backgroundWork: number
  readonly listed: boolean
}

export interface WorkspaceRecord {
  readonly id: WorktreeId
  readonly listId: WorkspaceListId | null
  readonly projectId: RepoId
  readonly projectName: string
  readonly path: string
  readonly branch: string | null
  readonly title: string
  readonly archived: boolean
  readonly hostId: string | null
}

export interface ProjectRecord {
  readonly id: RepoId
  readonly name: string
  readonly path: string
  readonly remoteUrl: string | null
  /** A data: URL of a raster image, the only icon form an isolated frame can draw without a fetch. */
  readonly icon: string | undefined
}

export interface World {
  readonly at: number
  readonly sessions: ReadonlyMap<SessionId, SessionRecord>
  readonly workspaces: ReadonlyMap<WorktreeId, WorkspaceRecord>
  readonly projects: ReadonlyMap<RepoId, ProjectRecord>
  /** Terminal agents that have not reported an orca_session_id yet. Counted, not boarded. */
  readonly unidentified: number
  readonly truncated: boolean
}

export type WorkspaceKey = Brand<string, 'WorkspaceKey'>

function normalPath(path: string): string {
  const slashes = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(slashes) ? slashes.toLowerCase() : slashes
}

/** Two local paths name one folder: Windows paths compare without case and with either slash. */
export const samePath = (a: string, b: string) => normalPath(a) === normalPath(b)

/**
 * One join key for every workspace id Orca prints: "folder:<uuid>" stays as it is; "<repo>::<path>"
 * (CLI rows, event workspaceId) and an "identity:..." id with its row path (host workspace.list)
 * both become the normalized path on its host.
 */
export function workspaceKey(input: { id?: string | null; path?: string | null; hostId?: string | null }): WorkspaceKey | null {
  if (input.id?.startsWith('folder:')) return input.id as WorkspaceKey
  const cut = input.id?.indexOf('::') ?? -1
  const path = cut >= 0 ? input.id!.slice(cut + 2) : input.path
  return path ? (`path:${normalPath(path)}@${input.hostId ?? 'local'}` as WorkspaceKey) : null
}

const RASTER_ICON = /^data:image\/(?:png|jpeg|webp|x-icon);base64,[a-z0-9+/=]+$/i
const MAX_ICON_CHARS = 350_000

export function buildWorld(ps: WorktreePs, repos: RepoList, at: number): World {
  const projects = new Map<RepoId, ProjectRecord>()
  for (const repo of repos.repos) {
    const src = repo.repoIcon?.src
    projects.set(repo.id as RepoId, {
      id: repo.id as RepoId,
      name: repo.displayName,
      path: repo.path,
      remoteUrl: repo.gitRemoteIdentity?.remoteUrl ?? null,
      icon: src && src.length <= MAX_ICON_CHARS && RASTER_ICON.test(src) ? src : undefined
    })
  }
  const workspaces = new Map<WorktreeId, WorkspaceRecord>()
  const sessions = new Map<SessionId, SessionRecord>()
  let unidentified = 0
  for (const w of ps.worktrees) {
    const id = w.worktreeId as WorktreeId
    const title = w.displayName?.trim() || w.branch?.replace(/^refs\/heads\//, '') || w.path
    workspaces.set(id, {
      id,
      // A folder project's address is an "id:<repo>::<path>" selector, not a workspace.list id.
      listId: (w.address?.worktree && !w.address.worktree.startsWith('id:') ? w.address.worktree : null) as WorkspaceListId | null,
      projectId: w.repoId as RepoId,
      projectName: projects.get(w.repoId as RepoId)?.name ?? w.repo ?? title,
      path: w.path,
      branch: w.branch?.replace(/^refs\/heads\//, '') || null,
      title,
      archived: w.isArchived === true,
      hostId: w.hostId ?? null
    })
    for (const a of w.agents ?? []) {
      if (!a.orcaSessionId) {
        unidentified++
        continue
      }
      const surface = a.paneKey.startsWith('structured-agent-session-') ? 'chat' : 'terminal'
      const record: SessionRecord = {
        id: a.orcaSessionId as SessionId,
        paneKey: a.paneKey as PaneKey,
        surface,
        agent: a.agentType ?? null,
        state: a.state,
        stateStartedAt: a.stateStartedAt,
        updatedAt: a.updatedAt,
        outcome: a.mainAgent?.outcome ?? null,
        title: a.taskTitle?.trim() || a.displayName?.trim() || a.conversationName?.trim() || a.activity?.title?.trim() || null,
        tool: a.toolName ?? null,
        toolInput: typeof a.toolInput === 'string' ? a.toolInput : null,
        lastAssistant: a.lastAssistantMessage ?? null,
        unread: a.activity?.unread === true,
        livePty: surface === 'chat' || a.hasLivePty === true,
        handle: a.address?.startsWith('term_') ? (a.address as TerminalHandle) : null,
        worktree: id,
        backgroundWork: (a.children ?? []).filter((child) => child.state === 'working').length,
        listed: a.activity?.listed !== false
      }
      // One conversation can show in two panes; the listed, newest one speaks for it.
      const seen = sessions.get(record.id)
      if (!seen || (record.listed && !seen.listed) || (record.listed === seen.listed && record.updatedAt > seen.updatedAt)) {
        sessions.set(record.id, record)
      }
    }
  }
  return { at, sessions, workspaces, projects, unidentified, truncated: ps.truncated === true }
}

const iso = (ms: number) => new Date(ms).toISOString()

/** The Paseo agent fields the ported discovery and conversation code reads, and nothing more. */
export interface PaseoAgentView {
  id: string
  title: string | null
  workspaceId?: string
  archivedAt: string | null
  internal: boolean
  provider: string | null
  model: string | null
  metadata: Record<string, unknown>
  status: 'initializing' | 'running' | 'idle' | 'error' | 'closed'
  updatedAt: string
  activeTurn: { startedAt: string } | null
  pendingPermissions: { id: string; title: string; name: string; description: string }[]
  attentionReason: 'permission' | 'error' | 'finished' | null
  attentionTimestamp: string | null
  lastError: string | null
  requiresAttention: boolean
  backgroundWork: { count: number }
}

type Lane = Pick<PaseoAgentView, 'status' | 'activeTurn' | 'pendingPermissions' | 'attentionReason' | 'attentionTimestamp' | 'requiresAttention'>

/**
 * THE lane table: Orca facts to the Paseo agent state that discovery's verbatim observedState() turns
 * into a lane. First matching row wins.
 *
 *  | Orca facts                          | Paseo view                                         | lane            |
 *  | blocked or waiting                  | running + one pending permission (pane@since)      | human, native   |
 *  | working                             | running + activeTurn                               | running         |
 *  | done, last turn outcome failure     | error                                              | review          |
 *  | done, unread                        | idle + requiresAttention, attention finished       | review          |
 *  | done, terminal without a live PTY   | closed                                             | idle (no reads) |
 *  | done                                | idle                                               | idle            |
 *
 * conversation.ts classify() (verbatim) then lifts an idle or review row whose last assistant turn is a
 * plain-text question to human: that is how a question Orca reports as "done" reaches the board.
 */
function lane(s: SessionRecord): Lane {
  const quiet: Lane = { status: 'idle', activeTurn: null, pendingPermissions: [], attentionReason: null, attentionTimestamp: null, requiresAttention: false }
  if (s.state === 'blocked' || s.state === 'waiting') {
    // The id carries when this wait began, so a new wait gets a new permissionVersion.
    const request = { id: `${s.paneKey}@${s.stateStartedAt}`, title: s.tool ?? '', name: s.tool ?? '', description: s.toolInput ?? '' }
    return { ...quiet, status: 'running', pendingPermissions: [request], attentionReason: 'permission', attentionTimestamp: iso(s.stateStartedAt) }
  }
  if (s.state === 'working') return { ...quiet, status: 'running', activeTurn: { startedAt: iso(s.stateStartedAt) } }
  if (s.outcome === 'failure') return { ...quiet, status: 'error', attentionReason: 'error' }
  if (s.unread) return { ...quiet, requiresAttention: true, attentionReason: 'finished', attentionTimestamp: iso(s.stateStartedAt) }
  if (!s.livePty) return { ...quiet, status: 'closed' }
  return quiet
}

export function paseoAgentView(s: SessionRecord, ws: WorkspaceRecord | undefined): PaseoAgentView {
  return {
    id: s.id,
    title: s.title,
    workspaceId: s.worktree,
    archivedAt: ws?.archived ? iso(s.updatedAt) : null,
    internal: false,
    provider: s.agent,
    model: null,
    metadata: {},
    updatedAt: iso(s.updatedAt),
    lastError: null,
    backgroundWork: { count: s.backgroundWork },
    ...lane(s)
  }
}

export interface PaseoWorkspaceView {
  id: string
  projectId: string
  title: string
  name: string
  projectDisplayName: string
  projectCustomName: string | null
  internal: boolean
  archivingAt: string | null
  workspaceDirectory: string
  projectRootPath: string
  gitRuntime: { currentBranch: string | null; remoteUrl: string | null }
  githubRuntime: null
  project: { checkout: { remoteUrl: string | null; cwd: string; mainRepoRoot: string } }
}

export function paseoWorkspaceView(ws: WorkspaceRecord, project: ProjectRecord | undefined): PaseoWorkspaceView {
  const remoteUrl = project?.remoteUrl ?? null
  const root = project?.path ?? ws.path
  return {
    id: ws.id,
    projectId: ws.projectId,
    title: ws.title,
    name: ws.title,
    projectDisplayName: ws.projectName,
    projectCustomName: null,
    internal: false,
    archivingAt: ws.archived ? 'archived' : null,
    workspaceDirectory: ws.path,
    projectRootPath: root,
    gitRuntime: { currentBranch: ws.branch, remoteUrl },
    githubRuntime: null,
    project: { checkout: { remoteUrl, cwd: ws.path, mainRepoRoot: root } }
  }
}

export interface PaseoProjectView {
  projectId: string
  projectDisplayName: string
  projectCustomName: string | null
  projectRootPath: string
  icon: string | undefined
}

export function paseoProjectView(p: ProjectRecord): PaseoProjectView {
  return { projectId: p.id, projectDisplayName: p.name, projectCustomName: null, projectRootPath: p.path, icon: p.icon }
}
