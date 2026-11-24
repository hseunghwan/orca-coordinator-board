// Board logic with no Orca imports: the worker builds the view with it and tests run it directly.

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

export type RawProject = { id: string; name: string; hostId: string | null; path: string; hidden?: boolean }
export type RawWorkspace = {
  id: string
  name: string
  projectId?: string | null
  branch: string | null
  status?: { terminalCount: number }
}
export type RawAgent = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: AgentState
  stateStartedAt: number
  task?: { title: string } | null
}

export type PullReason =
  | 'ready' | 'draft' | 'conflict' | 'checks-failed' | 'checks-pending'
  | 'changes-requested' | 'blocked' | 'unknown' | 'auto-merge'
export type PullItem = { repo: string; number: number; title: string; url: string; reason: PullReason; updatedAt: string }
export type PullStatus = 'ok' | 'truncated' | 'unmapped' | 'unavailable' | 'remote'
export type ProjectPulls = { repo: string | null; status: PullStatus; items: PullItem[] }

export type SessionRow = {
  key: string
  terminalId: string | null
  workspaceId: string
  workspaceName: string
  branch: string | null
  agent: string | null
  title: string
  state: AgentState
  since: number
}
export type ProjectLane = {
  projectId: string
  name: string
  sessions: SessionRow[]
  repo: string | null
  pullStatus: PullStatus
  pulls: PullItem[]
}
export type DecisionKind = 'permission' | 'reply' | 'review'
export type Decision = {
  key: string
  kind: DecisionKind
  projectName: string
  since: number
  session?: SessionRow
  tail?: string[]
  pull?: PullItem
}
export type ReplyStatus = 'sent' | 'empty' | 'too-long' | 'gone' | 'permission' | 'busy' | 'changed' | 'failed'
export type ReplyResult = { status: ReplyStatus; at: number }
export type ReplyRecord = { projectName: string; workspaceName: string; title: string; text: string; status: ReplyStatus; at: number }
export type ProjectChoice = { id: string; name: string; path: string; remote: boolean }
export type BoardView = {
  at: number
  selected: string[]
  projects: ProjectLane[]
  decisions: Decision[]
  replies: ReplyRecord[]
  truncated: boolean
}

export const MAX_REPLY = 8000

// Terminal output and agent titles reach the panel only after escape sequences, control
// characters and bidirectional overrides are gone.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g

export function cleanLine(text: string, max = 512): string {
  return text.replace(ANSI, '').replace(/\t/g, '  ').replace(/[\r\n]/g, ' ').replace(CONTROL, ' ').slice(0, max)
}

export function cleanTail(lines: readonly string[], keep = 30): string[] {
  const out = lines.map((line) => cleanLine(line, 400).trimEnd())
  while (out.length && !out[out.length - 1]) out.pop()
  return out.slice(-keep)
}

export function sessionRows(workspace: RawWorkspace, agents: readonly RawAgent[]): SessionRow[] {
  return agents.map((agent) => ({
    // A new state gets a new key, so a dismissed card returns when the session asks again.
    key: `${agent.terminalId ?? workspace.id + ':' + (agent.title ?? '')}@${agent.stateStartedAt}`,
    terminalId: agent.terminalId,
    workspaceId: workspace.id,
    workspaceName: cleanLine(workspace.name, 200),
    branch: workspace.branch,
    agent: agent.agent,
    title: cleanLine(agent.task?.title || agent.title || agent.agent || 'agent', 200),
    state: agent.state,
    since: agent.stateStartedAt
  }))
}

export const pullKey = (pull: PullItem): string => `pr:${pull.repo}#${pull.number}@${pull.updatedAt}`

const RANK: Record<DecisionKind, number> = { permission: 0, reply: 1, review: 2 }

export function decisionsFor(lanes: readonly ProjectLane[], dismissed: ReadonlySet<string>): Decision[] {
  const out: Decision[] = []
  const seenPulls = new Set<string>()
  for (const lane of lanes) {
    for (const session of lane.sessions) {
      // A permission prompt is never dismissed here: only the session itself can clear it.
      if (session.state === 'blocked') {
        out.push({ key: session.key, kind: 'permission', projectName: lane.name, since: session.since, session })
      } else if (session.state === 'waiting' && session.terminalId && !dismissed.has(session.key)) {
        // A finished ('done') session shows only under session progress: nothing asks the person yet.
        out.push({ key: session.key, kind: 'reply', projectName: lane.name, since: session.since, session })
      }
    }
    for (const pull of lane.pulls) {
      const key = pullKey(pull)
      // A pull request shared by several projects counts once.
      if (pull.reason !== 'ready' || seenPulls.has(key) || dismissed.has(key)) continue
      seenPulls.add(key)
      out.push({ key, kind: 'review', projectName: lane.name, since: Date.parse(pull.updatedAt) || 0, pull })
    }
  }
  // Permission first, then sessions waiting for a reply, then reviews; the oldest wait first.
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export type BoardInput = {
  projects: readonly RawProject[]
  selected: readonly string[]
  workspaces: readonly RawWorkspace[]
  agents: ReadonlyMap<string, readonly RawAgent[]>
  pulls: ReadonlyMap<string, ProjectPulls>
  dismissed: ReadonlySet<string>
  replies: readonly ReplyRecord[]
  now: number
  truncated: boolean
}

export function buildBoard(input: BoardInput): BoardView {
  const chosen = input.projects
    .filter((project) => input.selected.includes(project.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const projects = chosen.map((project): ProjectLane => {
    const sessions = input.workspaces
      .filter((workspace) => workspace.projectId === project.id)
      .flatMap((workspace) => sessionRows(workspace, input.agents.get(workspace.id) ?? []))
      .sort((a, b) => b.since - a.since)
    const pulls = input.pulls.get(project.id) ?? { repo: null, status: 'unmapped', items: [] }
    return { projectId: project.id, name: cleanLine(project.name, 200), sessions, repo: pulls.repo, pullStatus: pulls.status, pulls: pulls.items }
  })
  return {
    at: input.now,
    selected: chosen.map((project) => project.id),
    projects,
    decisions: decisionsFor(projects, input.dismissed),
    replies: [...input.replies],
    truncated: input.truncated
  }
}

/** Why a reply must not be typed into the session now, or null when it may be. */
export function replyGuard(agent: RawAgent | undefined, text: string, expectedSince: number): ReplyStatus | null {
  if (!text.trim()) return 'empty'
  if (text.length > MAX_REPLY) return 'too-long'
  if (!agent || !agent.terminalId) return 'gone'
  // Orca clears a pending permission prompt when the session receives input.
  if (agent.state === 'blocked') return 'permission'
  if (agent.state === 'working') return 'busy'
  // The person read an earlier question; the session has moved on since.
  if (agent.stateStartedAt !== expectedSince) return 'changed'
  return null
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Appends to a bounded list, keeping the newest. */
export function remember<V>(list: readonly V[], value: V, cap: number): V[] {
  return [...list, value].slice(-cap)
}

export function without<V>(map: Readonly<Record<string, V>>, key: string): Record<string, V> {
  const next = { ...map }
  delete next[key]
  return next
}
