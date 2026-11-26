import { expect, test } from "vitest";
import type { Snapshot } from "../paseo/client/model";
import { trackedDecisionSchema } from "../paseo/shared/tracked-decisions";
import { sessionRowKey } from "../paseo/client/decision-receipts";
import { boardModel, toggleFilter } from "./board-model";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const t = (ko: string) => ko;
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function session(id: string, projectId: string, extra: Partial<Snapshot["sessions"][number]>): Snapshot["sessions"][number] {
  return { id, title: id, projectId, projectTitle: projectId === "app" ? "acme-app" : "acme-docs", workspaceTitle: "main", model: null, lane: "idle", detail: "", ...extra };
}

const decision = (source: "conversation" | "coordinator") => ({ question: "Ship it?", version: "v1", source });

function snapshot(): Snapshot {
  return {
    projects: [
      { id: "app", title: "acme-app", path: "/w/app", selected: true },
      { id: "docs", title: "acme-docs", path: "/w/docs", selected: true },
    ],
    coordinator: null,
    notes: {},
    sessions: [
      session("answered-by-record", "app", { lane: "human", status: "idle", decision: decision("conversation"), decisionRequestedAt: hoursAgo(2) }),
      session("needs-permission", "app", { lane: "human", nativePending: true, decisionRequestedAt: hoursAgo(1) }),
      session("docs-question", "docs", { lane: "human", status: "running", decision: decision("coordinator") }),
      session("busy", "app", { lane: "running" }),
    ],
    trackedDecisions: {
      status: "ok",
      items: [trackedDecisionSchema.parse({
        source: "coordinator", projectId: "app", id: "r1", title: "Pick a retry limit", urgency: "now",
        key: "r1", fingerprint: "a".repeat(64), matchedSessionId: "answered-by-record", matchedPull: null,
      })],
    },
    pullRequests: {
      projects: [{ projectId: "app", repo: "acme/app", mode: "auto", status: "ok" }],
      items: [{ repo: "acme/app", number: 7, title: "Move the docs", url: "https://github.com/acme/app/pull/7", projectIds: ["app"], lane: "review", reason: "ready", updatedAt: hoursAgo(3) }],
    },
  };
}

test("a record hides the session it covers, and counts follow each project", () => {
  const model = boardModel(snapshot(), [], t, NOW);
  expect(model.total).toBe(4);
  expect([...model.byProject]).toEqual([["app", 3], ["docs", 1]]);
  expect(model.ranked.map(row => row.kind === "session" ? row.card.session.id : row.kind)).toEqual(["record", "needs-permission", "pull", "docs-question"]);
});

test("a project filter narrows decisions and projects but keeps the overall total", () => {
  const model = boardModel(snapshot(), ["docs"], t, NOW);
  expect(model.total).toBe(4);
  expect(model.filteredTotal).toBe(1);
  expect(model.visibleProjects.map(project => project.id)).toEqual(["docs"]);
  expect(model.ranked).toHaveLength(1);
});

test("a filter id whose project left the board is ignored and dropped on the next toggle", () => {
  const model = boardModel(snapshot(), ["gone"], t, NOW);
  expect(model.filters).toEqual([]);
  expect(model.filteredTotal).toBe(4);
  expect(toggleFilter(["gone", "app"], "docs", model.byProject)).toEqual(["app", "docs"]);
  expect(toggleFilter(["app"], "app", model.byProject)).toEqual([]);
});

test("host-wide items are named Host-wide and records outside listed projects still get a name", () => {
  const data = snapshot();
  data.trackedDecisions!.items.push(trackedDecisionSchema.parse({
    source: "coordinator", projectId: null, id: "r2", title: "Rotate the key", key: "r2", fingerprint: "b".repeat(64), matchedSessionId: null, matchedPull: null,
  }));
  const model = boardModel(data, [], t, NOW);
  expect(model.projectName(null)).toBe("공통");
  expect(model.showHostWide).toBe(true);
  expect(model.byProject.get(null)).toBe(1);
});

test("a decision handled on screen leaves the list and the counts before the next snapshot", () => {
  const data = snapshot();
  const handled = boardModel(data, [], t, NOW).human.find(card => card.session.id === "docs-question")!;
  const model = boardModel(data, [], t, NOW, new Set([sessionRowKey(handled)]));
  expect(model.total).toBe(3);
  expect(model.byProject.get("docs")).toBe(0);
  expect(model.ranked.map(row => row.key)).not.toContain(sessionRowKey(handled));
});

test("a partial decision ledger marks the board incomplete", () => {
  const data = snapshot();
  data.trackedDecisions!.status = "partial";
  expect(boardModel(data, [], t, NOW).incomplete).toBe(true);
});
