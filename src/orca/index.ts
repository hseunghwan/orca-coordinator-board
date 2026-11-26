// The board's one door to Orca. Ported Paseo server code receives `paseo` from here: the read
// methods it calls, answered from one World per snapshot instead of the Paseo SDK.
import type { z } from 'zod'
import type { PluginRpcContract } from '../paseo/plugin-shim'
import { agentRead, timelinePage, type TimelinePage } from './conversation'
import type { OrcaCli } from './cli'
import {
  buildWorld, paseoAgentView, paseoProjectView, paseoWorkspaceView, repoList, worktreePs,
  type PaseoAgentView, type PaseoProjectView, type PaseoWorkspaceView, type SessionId, type World
} from './view'

export * from './view'
export type { TimelinePage } from './conversation'

type Page<T> = { entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null; prevCursor: string | null } }
const all = <T>(entries: T[]): Page<T> => ({ entries, pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } })

export type PaseoProjectRef = { projectKey: string; projectName: string; workspaceName: string | null }

/** The Paseo SDK methods ported code reads. Options are accepted and ignored: one World answers them all. */
export interface PaseoReads {
  agents: {
    list(options?: unknown): Promise<Page<{ agent: PaseoAgentView; project: PaseoProjectRef }>>
    ref(id: string): { timeline: { refetch(options: { direction: 'tail'; projection: 'projected'; limit: number }): Promise<TimelinePage> } }
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

export interface Fleet {
  /** A World no older than maxAgeMs (default 2 s); concurrent callers share one read. */
  view(options?: { maxAgeMs?: number }): Promise<World>
  /** The last World read, without reading. */
  peek(): World | null
  /** The next view() reads Orca again. */
  invalidate(): void
  paseo: PaseoReads
}

const REPO_TTL_MS = 60_000
const VIEW_MAX_AGE_MS = 2_000
/** agent read caps a read at 100 entries. */
const MAX_READ = 100

export function createFleet(cli: OrcaCli, now: () => number = Date.now): Fleet {
  let current: { at: number; world: Promise<World> } | null = null
  let last: World | null = null
  const reads = new Map<SessionId, { updatedAt: number; limit: number; page: Promise<TimelinePage> }>()

  function view(options: { maxAgeMs?: number } = {}): Promise<World> {
    const maxAge = options.maxAgeMs ?? VIEW_MAX_AGE_MS
    if (current && now() - current.at <= maxAge) return current.world
    const at = now()
    const world = Promise.all([
      cli.read('worktree ps', ['--limit', '500'], (result) => worktreePs.parse(result)),
      cli.read('repo list', [], (result) => repoList.parse(result), { ttlMs: REPO_TTL_MS })
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
    const world = await view()
    const session = world.sessions.get(id as SessionId)
    const n = Math.min(limit, MAX_READ)
    // A transcript does not change while its session's updatedAt stays the same.
    const cached = reads.get(id as SessionId)
    if (session && cached && cached.updatedAt === session.updatedAt && cached.limit === n) return cached.page
    const page = cli.read('agent read', ['orca_session_id:' + id, '--limit', String(n)], (result) => timelinePage(agentRead.parse(result), session))
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
          return {
            agent: paseoAgentView(session, ws),
            project: { projectKey: ws?.projectId ?? 'unassigned', projectName: ws?.projectName ?? '', workspaceName: ws?.title ?? null }
          }
        }))
      },
      ref: (id) => ({ timeline: { refetch: (options) => timeline(id, options.limit) } })
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
        return { projects: [...(await view()).projects.values()].map(paseoProjectView) }
      }
    }
  }

  return {
    view,
    peek: () => last,
    invalidate() {
      current = null
    },
    paseo
  }
}
