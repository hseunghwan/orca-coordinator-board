// What the board shows for one snapshot and project filter: Paseo's BoardView derivations
// (client/board.tsx) without the React state, so every view reads the same counts and order.
import { rankDecisionRows } from "../paseo/client/decision-priority";
import { projectCards, projectFilterNames, type Card, type Snapshot } from "../paseo/client/model";
import type { PullRequestItem } from "../paseo/shared/prs";
import { pullKey, trackedCoverage, type TrackedDecision } from "../paseo/shared/tracked-decisions";
import type { Translate } from "../paseo/view-types";

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

export function boardModel(snapshot: Snapshot, chosen: readonly ProjectId[], t: Translate, now = Date.now()) {
  const { human, projects } = projectCards(snapshot);
  const pullRequests = snapshot.pullRequests;
  const readyPrs = pullRequests?.items.filter(pr => pr.lane === "review") ?? [];
  const records = sortRecords(snapshot.trackedDecisions?.items ?? []);
  const names = new Map(snapshot.projects.map(project => [project.id, project.title]));
  const displayed = new Map<string, ProjectGroup>(projects.map(project => [project.id, project]));
  for (const pr of pullRequests?.items ?? []) for (const id of pr.projectIds) {
    if (!displayed.has(id)) displayed.set(id, { id, title: names.get(id) ?? id, cards: [] });
  }
  function decisionsFor(inScope: (id: ProjectId) => boolean): PendingDecisions {
    const visibleRecords = records.filter(item => inScope(item.projectId));
    const covered = trackedCoverage(visibleRecords);
    return {
      records: visibleRecords,
      sessions: human.filter(card => inScope(card.session.projectId) && !covered.sessionIds.has(card.session.id)),
      prs: readyPrs.filter(pr => pr.projectIds.some(inScope) && !covered.pullKeys.has(pullKey(pr.repo, pr.number))),
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
