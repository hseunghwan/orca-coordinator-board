import { expect, test } from "vitest";
import { boardModel } from "./dashboard/board-model";
import { focusCards } from "./focus-cards";
import type { Snapshot } from "./paseo/client/model";
import { focusQueue } from "./paseo/client/focus-queue";
import { trackedDecisionSchema } from "./paseo/shared/tracked-decisions";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const t = (_ko: string, en: string) => en;
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
type Session = Snapshot["sessions"][number];

function session(id: string, projectId: string, extra: Partial<Session>): Session {
  return { id, title: id, projectId, projectTitle: projectId === "app" ? "acme-app" : "acme-docs", workspaceTitle: "main", model: null, lane: "idle", detail: "", ...extra };
}

function snapshot(): Snapshot {
  return {
    projects: [
      { id: "app", title: "acme-app", path: "/w/app", selected: true },
      { id: "docs", title: "acme-docs", path: "/w/docs", selected: true },
    ],
    coordinator: null,
    notes: {},
    sessions: [
      session("answered-by-record", "app", { lane: "human", status: "idle", decisionRequestedAt: hoursAgo(2),
        decision: { question: "Ship it?", version: "v1", source: "conversation", recommendation: "Ship on Monday." } }),
      session("needs-permission", "app", { lane: "human", nativePending: true, decisionRequestedAt: hoursAgo(1), detail: "Run npm test?" }),
      session("docs-question", "docs", { lane: "human", status: "idle", decisionRequestedAt: hoursAgo(4), decision: {
        question: "Which **layout**?", version: "v7", source: "coordinator", needsInput: "Name the page width.",
        recommendation: "Two columns.", recommendationReason: "Matches the guide.",
        options: [{ label: "Two", reply: "Use two columns." }, { label: "One", reply: "Use one column." }],
      } }),
      session("busy", "app", { lane: "running" }),
    ],
    trackedDecisions: {
      status: "ok",
      items: [trackedDecisionSchema.parse({
        source: "coordinator", projectId: "app", id: "r1", title: "Pick a retry limit", urgency: "now", ask: ["Three or five?"],
        key: "r1", fingerprint: "a".repeat(64), matchedSessionId: "answered-by-record", matchedPull: null,
      })],
    },
    pullRequests: {
      projects: [{ projectId: "app", repo: "acme/app", mode: "auto", status: "ok" }],
      items: [{ repo: "acme/app", number: 7, title: "Move the docs", url: "https://github.com/acme/app/pull/7", projectIds: ["app"], lane: "review", reason: "ready", updatedAt: hoursAgo(3) }],
    },
  };
}

test("the cards follow the Focus queue the dashboard builds from the same snapshot", () => {
  const data = snapshot();
  const entries = boardModel(data, [], t, NOW).ranked.map(row => ({ key: row.key, row, receipts: [] }));
  const deck = focusCards(data, t, NOW);
  expect(deck.cards.map(card => card.key)).toEqual(focusQueue(entries, []));
  expect(deck.cards[0]).toMatchObject({ key: entries[0].key, tone: "danger", priority: "Needs a decision now", projects: "acme-app" });
  expect(deck).toMatchObject({ configured: true, incomplete: false });
});

test("a record that covers a session decision is answered in that session", () => {
  const [record] = focusCards(snapshot(), t, NOW).cards;
  expect(record).toMatchObject({
    headline: "Pick a retry limit", body: "Three or five?", session: "answered-by-record", openSessionId: "answered-by-record",
    recommendation: "Ship on Monday.",
    answer: { kind: "reply", projectId: "app", sessionId: "answered-by-record", version: "v1", suggested: "Ship on Monday.", options: [] },
  });
});

test("a pending permission is approved in its session, with nothing to send", () => {
  const card = focusCards(snapshot(), t, NOW).cards.find(card => card.openSessionId === "needs-permission")!;
  expect(card).toMatchObject({ tone: "warning", session: "needs-permission", headline: "Run npm test?", recommendation: null, answer: { kind: "permission" } });
  expect(card.priority).toBe("Awaiting permission · 1h");
});

test("a session question carries its input request, options and recommendation, and suggests no reply before the input", () => {
  const card = focusCards(snapshot(), t, NOW).cards.find(card => card.openSessionId === "docs-question")!;
  expect(card).toMatchObject({
    projects: "acme-docs", headline: "Which **layout**?", body: "Name the page width.",
    recommendation: "Two columns.", recommendationReason: "Matches the guide.",
    answer: { kind: "reply", version: "v7", suggested: "", options: [{ label: "Two", reply: "Use two columns." }, { label: "One", reply: "Use one column." }] },
  });
});

test("a pull request is answered on the board and links to GitHub", () => {
  const card = focusCards(snapshot(), t, NOW).cards.find(card => card.headline === "Move the docs")!;
  expect(card).toMatchObject({ tone: "success", session: null, openSessionId: null, body: "[acme/app #7](https://github.com/acme/app/pull/7)", answer: { kind: "board" } });
});

test("text longer than an Orca component takes is cut to fit", () => {
  const data = snapshot();
  data.trackedDecisions!.items[0].ask = ["x".repeat(16000), "y".repeat(16000)];
  const [record] = focusCards(data, t, NOW).cards;
  expect(record.body).toHaveLength(16384);
  expect(record.body!.endsWith("…")).toBe(true);
});

test("a board with nothing to decide has no cards", () => {
  const data = snapshot();
  data.sessions = [session("busy", "app", { lane: "running" })];
  data.trackedDecisions!.items = [];
  data.pullRequests!.items = [];
  expect(focusCards(data, t, NOW)).toEqual({ configured: true, incomplete: false, cards: [] });
  data.projects = data.projects.map(project => ({ ...project, selected: false }));
  expect(focusCards(data, t, NOW).configured).toBe(false);
});
