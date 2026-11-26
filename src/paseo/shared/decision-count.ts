import type { Note, SessionRow } from "./contract";
import { trackedCoverage, pullKey, type TrackedDecisionView } from "./tracked-decisions";
import type { PullRequestView } from "./prs";

export function displayLane(session: SessionRow, note: Note | undefined): SessionRow["lane"] | "done" {
  if (session.nativePending) return "human";
  if (session.evidenceId && session.evidenceId === note?.evidenceId && note.origin === "person") {
    if (note.kind === "done") return "done";
    if (note.kind === "review") return "review";
    if (note.kind === "clear" && session.lane === "human") return "idle";
  }
  if (session.decisionAnswered) {
    return session.lane === "running" || session.lane === "unknown" ? session.lane : "review";
  }
  if (session.lane === "human" || note?.kind === "question") return "human";
  if (session.lane === "running") return "running";
  if (session.lane === "review" || note?.kind === "review" || (note?.kind === "done" && note.origin === "agent")) return "review";
  if (note?.kind === "done") return "done";
  return session.lane;
}

export function decisionCount(view: {sessions: SessionRow[]; notes: Record<string, Note>; pullRequests?: PullRequestView; trackedDecisions?: TrackedDecisionView}) {
  const sessions = view.sessions.filter(row => displayLane(row, view.notes[row.id]) === "human");
  const records = view.trackedDecisions?.items ?? [];
  const covered = trackedCoverage(records);
  return records.length + sessions.filter(s => !covered.sessionIds.has(s.id)).length +
    (view.pullRequests?.items.filter(pr => pr.lane === "review" && !covered.pullKeys.has(pullKey(pr.repo, pr.number))).length ?? 0);
}
