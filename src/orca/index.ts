// The board's one door to Orca. Ported Paseo server code receives `paseo` from here: the read
// methods it calls, answered from one World per snapshot instead of the Paseo SDK.
import { z } from 'zod'
import type { PluginRpcContract } from '../paseo/plugin-shim'
import { agentRead, timelinePage, type TimelinePage } from './conversation'
import type { OrcaCli } from './cli'
import { createDeliver, type DeliverDeps, type Delivery, type DeliveryOutcome } from './deliver'
import { CoordinatorHome, homeDir } from './home'
import {
  buildWorld, paseoAgentView, paseoProjectView, paseoWorkspaceView, repoList, samePath, worktreePs,
  type PaseoAgentView, type PaseoProjectView, type PaseoWorkspaceView, type SessionId, type TerminalHandle, type World, type WorktreeId
} from './view'

export * from './view'
export { CoordinatorHome, homeDir } from './home'
export type { TimelinePage } from './conversation'
export type { Delivery, DeliveryOutcome, RefuseReason, Route, Sender } from './deliver'

type Page<T> = { entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null; prevCursor: string | null } }
const all = <T>(entries: T[]): Page<T> => ({ entries, pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } })

export type PaseoProjectRef = { projectKey: string; projectName: string; workspaceName: string | null }
const projectRef = (ws: { projectId: string; projectName: string; title: string } | undefined): PaseoProjectRef =>
  ({ projectKey: ws?.projectId ?? 'unassigned', projectName: ws?.projectName ?? '', workspaceName: ws?.title ?? null })

/** The Paseo SDK methods ported code reads. Options are accepted and ignored: one World answers them all. */
export interface PaseoReads {
  agents: {
    list(options?: unknown): Promise<Page<{ agent: PaseoAgentView; project: PaseoProjectRef }>>
    ref(id: string): {
      timeline: { refetch(options: { direction: 'tail'; projection: 'projected'; limit: number }): Promise<TimelinePage> }
      /** The agent as Orca reports it now, not from the shared two-second view. */
      refresh(): Promise<{ agent: PaseoAgentView; project: PaseoProjectRef } | null>
    }
  }
  workspaces: { list(options?: { filter?: { projectId?: string; [key: string]: unknown }; [key: string]: unknown }): Promise<Page<PaseoWorkspaceView>> }
  projects: { list(): Promise<{ projects: PaseoProjectView[] }> }
}

/** Stand in for Paseo's handler and server contexts so ported files change only their import path. */
export type PluginHandlerContext = { paseo: PaseoReads }
export interface PluginServerContext {
  handle<I extends z.ZodType, O extends z.ZodType>(
    rpc: PluginRpcContract<I, O>,
    handler: (input: z.output<I>, context: PluginHandlerContext) => z.input<O> | Promise<z.input<O>>
  ): void
}

/** What became of a launch: started in a terminal, refused (nothing started), or unknown (it may have). */
export type LaunchOutcome =
  | { kind: 'started'; handle: TerminalHandle; operationId: string | null }
  | { kind: 'refused'; message: string }
  | { kind: 'unknown'; operationId: string | null; message: string }

export type LaunchRequest = {
  agent: string
  /** The CLI's worktree id ("<repo>::<path>" or "folder:<id>"). */
  worktree: WorktreeId
  model: string
  effort: string | null
  prompt: string
  /** The operationId of an earlier launch whose answer was lost: Orca settles that one instead of starting another. */
  retryLaunch: string | null
}

export interface Fleet {
  /** A World no older than maxAgeMs (default 2 s); concurrent callers share one read. */
  view(options?: { maxAgeMs?: number }): Promise<World>
  /** The last World read, without reading. */
  peek(): World | null
  /** The next view() reads Orca again. */
  invalidate(): void
  /** Sends a marked text once (src/orca/deliver.ts). */
  deliver(delivery: Delivery): Promise<DeliveryOutcome>
  /** What became of a messageId, without sending: null when it was never attempted. */
  reconcile(messageId: string): Promise<DeliveryOutcome | null>
  /** Starts an agent CLI in a terminal (the launch hook runs for it). Never retried. */
  launch(request: LaunchRequest): Promise<LaunchOutcome>
  /** For reads the Fleet does not model (installed agents, account usage). */
  cli: OrcaCli
  /** The board's coordinator folder project, under the data folder; null without one. Not a managed project. */
  home: CoordinatorHome | null
  paseo: PaseoReads
}

export type SendDeps = Pick<DeliverDeps, 'dataDir' | 'mailSender' | 'sleep'>

const launched = z.object({ outcome: z.object({ kind: z.string(), handle: z.string().nullish() }), operationId: z.string().nullish() })

/** orca agent launch through this CLI: the worker's own, or the calling agent's shell, where Orca shows the launch as that agent's handoff. */
export async function launchAgent(cli: OrcaCli, request: LaunchRequest): Promise<LaunchOutcome> {
  const selector = request.worktree.startsWith('folder:') ? request.worktree : 'id:' + request.worktree
  const result = await cli.write('agent launch', [
    '--agent', request.agent, '--worktree', selector, '--surface', 'terminal', '--model', request.model,
    ...(request.effort ? ['--effort', request.effort] : []), '--prompt', request.prompt,
    ...(request.retryLaunch ? ['--retry-launch', request.retryLaunch] : [])
  ])
  if (result.kind === 'refused') return { kind: 'refused', message: result.message }
  if (result.kind === 'ambiguous') return { kind: 'unknown', operationId: result.retryRequest, message: result.message }
  const parsed = launched.safeParse(result.result)
  const handle = parsed.success ? parsed.data.outcome.handle : null
  if (!handle?.startsWith('term_')) return { kind: 'unknown', operationId: parsed.success ? parsed.data.operationId ?? null : null, message: 'no terminal in the launch result' }
  return { kind: 'started', handle: handle as TerminalHandle, operationId: parsed.data!.operationId ?? null }
}

const REPO_TTL_MS = 60_000
const parsePs = (result: unknown) => worktreePs.parse(result)
const parseRepos = (result: unknown) => repoList.parse(result)
const VIEW_MAX_AGE_MS = 2_000
/** agent read caps a read at 100 entries. */
const MAX_READ = 100

export function createFleet(cli: OrcaCli, now: () => number = Date.now, send?: SendDeps): Fleet {
  let current: { at: number; world: Promise<World> } | null = null
  let last: World | null = null
  const reads = new Map<SessionId, { updatedAt: number; limit: number; page: Promise<TimelinePage> }>()

  function view(options: { maxAgeMs?: number } = {}): Promise<World> {
    const maxAge = options.maxAgeMs ?? VIEW_MAX_AGE_MS
    // 0 means read now: a view begun in the same millisecond may predate the change the caller saw.
    if (current && maxAge > 0 && now() - current.at <= maxAge) return current.world
    const at = now()
    const world = Promise.all([
      cli.read('worktree ps', ['--limit', '500'], parsePs),
      cli.read('repo list', [], parseRepos, { ttlMs: REPO_TTL_MS })
    ]).then(([ps, repos]) => buildWorld(ps, repos, at))
    const entry = { at, world }
    current = entry
    world.then((value) => {
      last = value
      for (const id of reads.keys()) if (!value.sessions.has(id)) reads.delete(id)
    }, () => {
      if (current === entry) current = null
    })
    return world
  }

  async function timeline(id: string, limit: number): Promise<TimelinePage> {
    // The snapshot that asked has just read a World; reading another here would cost a ps per transcript.
    const world = last ?? (await view())
    const session = world.sessions.get(id as SessionId)
    const n = Math.min(limit, MAX_READ)
    // A transcript does not change while its session's updatedAt stays the same.
    const cached = reads.get(id as SessionId)
    if (session && cached && cached.updatedAt === session.updatedAt && cached.limit === n) return cached.page
    const senderOf = (handle: string) => [...world.sessions.values()].find((s) => s.handle === handle && s.id !== id)?.id
    const page = cli.read('agent read', ['orca_session_id:' + id, '--limit', String(n)], (result) => timelinePage(agentRead.parse(result), session, sentText, senderOf))
    if (session) reads.set(session.id, { updatedAt: session.updatedAt, limit: n, page })
    page.catch(() => {
      if (reads.get(id as SessionId)?.page === page) reads.delete(id as SessionId)
    })
    return page
  }

  const paseo: PaseoReads = {
    agents: {
      async list() {
        const world = await view()
        return all([...world.sessions.values()].map((session) => {
          const ws = world.workspaces.get(session.worktree)
          return { agent: paseoAgentView(session, ws), project: projectRef(ws) }
        }))
      },
      ref: (id) => ({
        timeline: { refetch: (options) => timeline(id, options.limit) },
        async refresh() {
          const world = await view({ maxAgeMs: 0 })
          const session = world.sessions.get(id as SessionId)
          if (!session) return null
          const ws = world.workspaces.get(session.worktree)
          return { agent: paseoAgentView(session, ws), project: projectRef(ws) }
        }
      })
    },
    workspaces: {
      async list(options) {
        const world = await view()
        const projectId = options?.filter?.projectId
        return all([...world.workspaces.values()]
          .filter((ws) => !projectId || ws.projectId === projectId)
          .map((ws) => paseoWorkspaceView(ws, world.projects.get(ws.projectId))))
      }
    },
    projects: {
      async list() {
        return { projects: [...(await view()).projects.values()].filter((p) => !home || !samePath(p.path, home.dir)).map(paseoProjectView) }
      }
    }
  }

  const sender = send ? createDeliver({ ...send, cli, view, now }) : null
  const home = send ? new CoordinatorHome(homeDir(send.dataDir), cli, send.sleep) : null
  const sentText = (messageId: string) => sender?.sentText(messageId)

  async function launch(request: LaunchRequest): Promise<LaunchOutcome> {
    const outcome = await launchAgent(cli, request)
    if (outcome.kind === 'started') current = null
    return outcome
  }

  return {
    view,
    launch,
    cli,
    home,
    peek: () => last,
    deliver(delivery) {
      if (!sender) return Promise.reject(new Error('this fleet has no data folder to send from'))
      return sender.deliver(delivery)
    },
    reconcile(messageId) {
      return sender ? sender.reconcile(messageId) : Promise.resolve(null)
    },
    invalidate() {
      current = null
    },
    paseo
  }
}
