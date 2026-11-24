// The plugin's worker: reads projects, workspaces and agents from Orca, pull requests through
// git and gh, and types the person's replies into session terminals.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { commandEnv, GH_FIELDS, GH_PROJECTION, githubRepository, parseOpenPulls, SCAN_LIMIT } from './github'
import {
  buildBoard, cleanTail, remember, replyGuard, strings,
  type BoardView, type ProjectPulls, type PullItem, type RawAgent, type RawProject, type ReplyRecord, type ReplyStatus
} from './model'

export type GithubDeps = {
  originOf(path: string): Promise<string | null>
  openPulls(repo: string): Promise<{ status: 'ok' | 'truncated'; items: PullItem[] }>
  now(): number
}

const SELECTED = 'selectedProjects'
const DISMISSED = 'dismissed'
const REPLIES = 'replies'
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
    if (!isAbsolute(path)) return null
    try {
      // A nested non-Git folder would otherwise inherit a parent repository from git -C.
      const marker = await stat(join(path, '.git'))
      if (!marker.isFile() && !marker.isDirectory()) return null
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

export function activateWith(orca: OrcaWorkerApi, github: GithubDeps): void {
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

  async function readBoard(refresh: boolean): Promise<BoardView> {
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
    const pulls = new Map(await mapLimited(chosen, 3, async (project) => [project.id, await pullsFor(project, refresh)] as const))
    const board = buildBoard({
      projects, selected, workspaces, agents, pulls,
      dismissed: new Set(strings(dismissedRaw)),
      replies: replyRecords(repliesRaw).slice(-20).reverse(),
      now: github.now(),
      truncated
    })
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

  orca.panels.handle('board.read', (input) => readBoard(input?.refresh === true))

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
    return { selected }
  })

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
          const sent = await orca.host.call('terminal.sendText', { terminalId: input.terminalId, text: text.trimEnd(), enter: true })
          status = sent.accepted ? 'sent' : 'failed'
        } catch {
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
    return { status, at }
  })

  orca.panels.handle('board.focus', async (input) => {
    if (typeof input?.terminalId !== 'string') return { focused: false }
    try { return await orca.host.call('terminal.focus', { terminalId: input.terminalId }) } catch { return { focused: false } }
  })

  orca.panels.handle('board.dismiss', async (input) => {
    if (typeof input?.key === 'string' && input.key.length <= 1024) {
      await orca.storage.set(DISMISSED, remember(strings(await orca.storage.get(DISMISSED)).filter((key) => key !== input.key), input.key, 300))
      orca.panels.post('board.changed', { at: github.now() })
    }
    return { ok: true as const }
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, hostGithub)
}
