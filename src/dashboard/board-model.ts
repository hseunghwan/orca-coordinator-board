// What the board shows for one snapshot and project filter: Paseo's BoardView derivations
// (client/board.tsx) without the React state, so every view reads the same counts and order.
import { rankDecisionRows } from "../paseo/client/decision-priority";
import { pullRowKey, recordRowKey, sessionRowKey } from "../paseo/client/decision-receipts";
import { projectCards, projectFilterNames, type Card, type Snapshot } from "../paseo/client/model";
import type { PullRequestItem } from "../paseo/shared/prs";
import { pullKey, trackedCoverage, type TrackedDecision } from "../paseo/shared/tracked-decisions";
import type { Translate } from "../paseo/view-types";
import { boardViewModes, type BoardViewMode } from "../paseo/client/view-mode";
import type { WorkItemView, WorkPhase } from "../contract";

export type ProjectId = string | null;
export type ProjectGroup = { id: string; title: string; cards: Card[] };
export type PendingDecisions = { records: TrackedDecision[]; sessions: Card[]; prs: PullRequestItem[] };

const urgencies = ["now", "today", "week"];
const urgencyRank = (urgency: string | null | undefined) => urgencies.includes(urgency ?? "") ? urgencies.indexOf(urgency!) : 3;

export function sortRecords(items: readonly TrackedDecision[]) {
  return [...items].sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency) ||
    (a.where === "human" ? 0 : 1) - (b.where === "human" ? 0 : 1) || (a.since ?? "~").localeCompare(b.since ?? "~"));
}

const count = (list: PendingDecisions) => list.records.length + list.sessions.length + list.prs.length;

// completed holds the row keys of decisions handled on this screen, so a sent reply leaves the counts
// and the list at once instead of waiting for the next snapshot.
/** Tracked work by session id (board.work-items). */
export type WorkItems = ReadonlyMap<string, WorkItemView>;

/**
 * Where a tracked session's card goes: its work phase speaks before the lane, except that a decision waiting on
 * a person stays a decision (escalated work becomes one on the worker's card), and a person's own done stays done.
 * A report, a done candidate, stale or escalated work is something to check, not a done; only a confirmed item
 * shows as done.
 */
export function workLane(lane: Card["lane"], item: WorkItemView | undefined): Card["lane"] {
  if (!item || lane === "human" || lane === "done") return lane;
  if (item.phase === "done") return "done";
  if (item.phase === "reported" || item.phase === "verifying" || item.phase === "stale" || item.phase === "escalated") return "review";
  if (item.phase === "running" && item.candidate && lane !== "running") return "review";
  return lane;
}

const phaseText: Record<WorkPhase, readonly [string, string]> = {
  running: ["진행 중", "In progress"],
  "awaiting-input": ["입력 대기", "Waiting for input"],
  reported: ["완료 보고됨 · 확인 필요", "Reported done · Check it"],
  verifying: ["검증 중", "Verifying"],
  done: ["완료", "Done"],
  stale: ["방치됨", "Stale"],
  escalated: ["사람 결정 필요 · 검증이 반복해서 실패했습니다", "Needs your decision · Verify failed repeatedly"],
};

const candidateText: Record<NonNullable<WorkItemView["candidate"]>["reason"], readonly [string, string]> = {
  "turn-ended": ["완료 후보 · 턴이 끝났지만 완료 보고가 없습니다", "Done candidate · The turn ended without a done report"],
  "pr-merged": ["완료 후보 · PR이 병합됐지만 완료 보고가 없습니다", "Done candidate · The pull request merged without a done report"],
  "pr-closed": ["완료 후보 · PR이 병합되지 않고 닫혔습니다", "Done candidate · The pull request closed without merging"],
};
const staleText: Record<NonNullable<WorkItemView["staleReason"]>, readonly [string, string]> = {
  idle: ["방치됨 · 오래 멈춰 있습니다", "Stale · Idle too long"],
  "no-answer": ["방치됨 · 완료 확인에 답이 없습니다", "Stale · No answer to the done check"],
  gone: ["방치됨 · 세션이 사라졌습니다", "Stale · The session is gone"],
};

/** The card's status line for tracked work, or null when the lane's own line should show. */
export function workStatus(item: WorkItemView | undefined, lane: Card["lane"], t: Translate): string | null {
  if (!item || lane === "human") return null;
  if (item.phase === "running" && item.candidate && lane !== "running") {
    const [ko, en] = candidateText[item.candidate.reason];
    const asked = item.candidate.ask?.status === "sent" || item.candidate.ask?.status === "unconfirmed";
    return asked ? t(ko + " · 세션에 물었습니다", en + " · Asked the session") : t(ko, en);
  }
  if (item.phase === "stale" && item.staleReason) return t(...staleText[item.staleReason]);
  const [ko, en] = phaseText[item.phase];
  return t(ko, en);
}

export function boardModel(snapshot: Snapshot, chosen: readonly ProjectId[], t: Translate, now = Date.now(), completed: ReadonlySet<string> = new Set(), work: WorkItems = new Map()) {
  const { human, projects } = projectCards(snapshot);
  for (const project of projects) for (const card of project.cards) card.lane = workLane(card.lane, work.get(card.session.id));
  const pullRequests = snapshot.pullRequests;
  const readyPrs = pullRequests?.items.filter(pr => pr.lane === "review") ?? [];
  const records = sortRecords(snapshot.trackedDecisions?.items ?? []);
  const names = new Map(snapshot.projects.map(project => [project.id, project.title]));
  const displayed = new Map<string, ProjectGroup>(projects.map(project => [project.id, project]));
  for (const pr of pullRequests?.items ?? []) for (const id of pr.projectIds) {
    if (!displayed.has(id)) displayed.set(id, { id, title: names.get(id) ?? id, cards: [] });
  }
  function decisionsFor(inScope: (id: ProjectId) => boolean): PendingDecisions {
    const visibleRecords = records.filter(item => inScope(item.projectId) && !completed.has(recordRowKey(item)));
    const covered = trackedCoverage(visibleRecords);
    return {
      records: visibleRecords,
      sessions: human.filter(card => inScope(card.session.projectId) && !completed.has(sessionRowKey(card)) && !covered.sessionIds.has(card.session.id)),
      prs: readyPrs.filter(pr => pr.projectIds.some(inScope) && !completed.has(pullRowKey(pr)) && !covered.pullKeys.has(pullKey(pr.repo, pr.number))),
    };
  }
  const total = count(decisionsFor(() => true));
  const projectIds = new Set<ProjectId>(snapshot.projects.filter(project => project.selected).map(project => project.id));
  for (const item of records) {
    projectIds.add(item.projectId);
    if (item.projectId && !displayed.has(item.projectId)) {
      displayed.set(item.projectId, { id: item.projectId, title: names.get(item.projectId) ?? item.projectTitle ?? item.projectId, cards: [] });
    }
  }
  for (const entry of snapshot.replyHistory ?? []) {
    projectIds.add(entry.projectId);
    if (entry.projectId && !displayed.has(entry.projectId)) {
      displayed.set(entry.projectId, { id: entry.projectId, title: names.get(entry.projectId) ?? entry.projectId, cards: [] });
    }
  }
  const byProject = new Map<ProjectId, number>();
  for (const id of projectIds) byProject.set(id, count(decisionsFor(projectId => projectId === id)));

  const filters = chosen.filter(id => byProject.has(id));
  const inFilter = (id: ProjectId) => !filters.length || filters.includes(id);
  const filtered = decisionsFor(inFilter);
  const filterNames = projectFilterNames(snapshot.projects.filter(project => byProject.has(project.id)));
  const projectName = (id: ProjectId) => filterNames.get(id ?? "") ?? displayed.get(id ?? "")?.title ?? id ?? t("공통", "Host-wide");
  const status = snapshot.trackedDecisions?.status;
  return {
    human, records, total, byProject, filters, inFilter, projectName,
    filteredTotal: count(filtered),
    ranked: rankDecisionRows(filtered, now),
    visibleProjects: [...displayed.values()].filter(project => inFilter(project.id)),
    showHostWide: byProject.has(null) && inFilter(null),
    incomplete: status === "partial" || status === "unavailable" || status === "invalid",
    configured: snapshot.projects.some(project => project.selected),
  };
}
export type BoardModel = ReturnType<typeof boardModel>;

// Toggling a project drops filter ids whose project left the board first, as Paseo does.
export function toggleFilter(previous: readonly ProjectId[], id: ProjectId, listed: ReadonlyMap<ProjectId, number>): ProjectId[] {
  const active = previous.filter(value => listed.has(value));
  return active.includes(id) ? active.filter(value => value !== id) : [...active, id];
}

/** The board views Orca offers: Paseo's without the classic stack. A saved "classic" opens the inbox. */
export const shownViewModes = boardViewModes.filter((mode): mode is ShownViewMode => mode !== "classic");
export type ShownViewMode = Exclude<BoardViewMode, "classic">;
export const shownViewMode = (mode: BoardViewMode): ShownViewMode => mode === "classic" ? "inbox" : mode;
