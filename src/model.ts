// The view types of the first board (sessions, decisions, pull requests by project). Only the old
// dashboard frame in src/dashboard/ and labels.ts still read them; they leave with that frame.

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

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
  agent: string
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
