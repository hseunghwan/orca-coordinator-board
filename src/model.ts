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
  /** What `agent.resume` takes; Orca leaves it out for some panes. */
  sessionId?: string | null
  task?: { title: string } | null
}
/** One row of Orca's Agent Session History (`agent.listSessions`). */
export type RawHistorySession = {
  sessionId: string
  agent: string
  title: string
  workspaceId: string | null
  updatedAt: number
  running: boolean
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
/** A session no Orca pane runs now; the person can answer it by resuming it in a new terminal. */
export type ClosedSession = {
  key: string
  sessionId: string
  agent: ResumeAgent
  title: string
  workspaceId: string
  workspaceName: string
  branch: string | null
  updatedAt: number
}
export type ProjectLane = {
  projectId: string
  name: string
  sessions: SessionRow[]
  /** Recently closed sessions, newest first; empty when Orca's history cannot be read. */
  closed: ClosedSession[]
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
export type ReplyStatus = 'sent' | 'empty' | 'too-long' | 'gone' | 'permission' | 'busy' | 'changed' | 'failed' | 'open'
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
export const CLOSED_PER_PROJECT = 3
export const CLOSED_MAX_AGE = 7 * 24 * 60 * 60 * 1000

/** The agents `agent.resume` accepts (Orca host API 1.9). */
export const RESUME_AGENTS = [
  'claude', 'codebuddy', 'codex', 'qoder', 'qoder-cn', 'qwen-code', 'gemini', 'antigravity', 'opencode', 'opencode2', 'pi',
  'mimo-code', 'droid', 'grok', 'devin', 'omp', 'prime-agent', 'copilot', 'cursor', 'kimi', 'muse', 'zcode', 'dsh', 'jcode', 'kiro', 'hermes'
] as const
export type ResumeAgent = (typeof RESUME_AGENTS)[number]
export const isResumeAgent = (agent: string): agent is ResumeAgent => (RESUME_AGENTS as readonly string[]).includes(agent)

/**
 * Closed sessions of one project's workspaces that may be resumed. A session must never run in two
 * places, so this leaves out sessions Orca runs now (`running`, or a live pane with that id) and
 * every session of a workspace that has a live pane whose session id Orca does not give: that pane
 * could be any of them, a chat tab included.
 */
export function closedSessions(input: {
  history: readonly RawHistorySession[]
  workspaces: readonly RawWorkspace[]
  agents: ReadonlyMap<string, readonly RawAgent[]>
  now: number
  limit?: number
}): ClosedSession[] {
  const byId = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]))
  const live = new Set<string>()
  const unsure = new Set<string>()
  for (const workspace of input.workspaces) {
    const agents = input.agents.get(workspace.id)
    // Agents not read: nothing is known about what runs there.
    if (!agents) { unsure.add(workspace.id); continue }
    for (const agent of agents) {
      if (agent.sessionId) live.add(agent.sessionId)
      else unsure.add(workspace.id)
    }
  }
  const out: ClosedSession[] = []
  const seen = new Set<string>()
  for (const row of [...input.history].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const workspace = row.workspaceId ? byId.get(row.workspaceId) : undefined
    if (!workspace || unsure.has(workspace.id) || row.running || live.has(row.sessionId) || seen.has(row.sessionId)) continue
    if (!isResumeAgent(row.agent) || !/^[A-Za-z0-9._:-]{1,256}$/.test(row.sessionId)) continue
    if (input.now - row.updatedAt > CLOSED_MAX_AGE) continue
    seen.add(row.sessionId)
    out.push({
      key: 'closed:' + row.sessionId,
      sessionId: row.sessionId,
      agent: row.agent,
      title: cleanLine(row.title || row.agent, 200),
      workspaceId: workspace.id,
      workspaceName: cleanLine(workspace.name, 200),
      branch: workspace.branch,
      updatedAt: row.updatedAt
    })
    if (out.length >= (input.limit ?? CLOSED_PER_PROJECT)) break
  }
  return out
}

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
      } else if (session.state === 'waiting' && !dismissed.has(session.key)) {
        // A finished ('done') session shows only under session progress: nothing asks the person yet.
        // A session without a terminal (a chat tab) still gets a card, answered in its own tab.
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
  /** Orca's Agent Session History; leave it out when it was not read. */
  history?: readonly RawHistorySession[]
  now: number
  truncated: boolean
}

export function buildBoard(input: BoardInput): BoardView {
  const chosen = input.projects
    .filter((project) => input.selected.includes(project.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const projects = chosen.map((project): ProjectLane => {
    const own = input.workspaces.filter((workspace) => workspace.projectId === project.id)
    const closed = input.history ? closedSessions({ history: input.history, workspaces: own, agents: input.agents, now: input.now }) : []
    const sessions = own
      .flatMap((workspace) => sessionRows(workspace, input.agents.get(workspace.id) ?? []))
      .sort((a, b) => b.since - a.since)
    const pulls = input.pulls.get(project.id) ?? { repo: null, status: 'unmapped', items: [] }
    return { projectId: project.id, name: cleanLine(project.name, 200), sessions, closed, repo: pulls.repo, pullStatus: pulls.status, pulls: pulls.items }
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

/**
 * Why a closed session must not be resumed for this reply now, or null when it may be. Called with
 * the workspace's live agents and its history row read again just before the resume.
 */
export function resumeGuard(input: {
  text: string
  sessionId: string
  agent: string
  row: RawHistorySession | undefined
  live: readonly RawAgent[] | undefined
}): ReplyStatus | null {
  if (!input.text.trim()) return 'empty'
  if (input.text.length > MAX_REPLY) return 'too-long'
  if (!input.row || input.row.agent !== input.agent || !isResumeAgent(input.agent)) return 'gone'
  // Open again since the card was drawn, or a pane Orca cannot name: answer it there instead.
  if (input.row.running || !input.live) return 'open'
  if (input.live.some((agent) => agent.sessionId === input.sessionId || !agent.sessionId)) return 'open'
  return null
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
