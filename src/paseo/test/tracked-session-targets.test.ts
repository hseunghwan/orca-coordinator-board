import { expect, test } from "vitest";
import { trackedSessionTargets } from "../client/tracked-session-targets";
import { trackedDecisionSchema, trackedRecipient } from "../shared/tracked-decisions";
import type { SessionRow } from "../shared/contract";

const record = (overrides: Record<string, unknown>) => trackedDecisionSchema.parse({
  source: "ledger", id: "check", key: "ledger-check", projectId: null, title: "Sign in again",
  fingerprint: "a".repeat(64), matchedSessionId: null, matchedPull: null, ...overrides,
});

test("a host-wide manual check links to its owner even without a source work session", () => {
  const item = record({where: "human", sourceCoordinatorId: "owner"});
  expect(trackedSessionTargets(item, "another")).toEqual({ownerId: "owner", sameSession: false});
  expect(trackedRecipient(item, "another", [])).toBeNull();
});

test("worker replies and owner navigation have independent targets", () => {
  const worker: SessionRow = {id: "worker", title: "Export", projectId: "p", projectTitle: "Studio", workspaceTitle: "Work", model: null, lane: "idle", detail: ""};
  const item = record({where: "session", projectId: "p", sessionId: "worker", sourceCoordinatorId: "owner"});
  expect(trackedSessionTargets(item, "another")).toEqual({ownerId: "owner", sameSession: false});
  expect(trackedRecipient(item, "another", [worker])).toBe("worker");
});

test("deduplicate only sessions on the same host and prefer the matched work session", () => {
  const item = record({where: "session", sessionId: "other", matchedSessionId: "owner", sourceCoordinatorId: "owner"});
  expect(trackedSessionTargets(item, null, "local").sameSession).toBe(true);
  expect(trackedSessionTargets({...item, sessionHost: "local"}, null, "local").sameSession).toBe(true);
  expect(trackedSessionTargets({...item, sessionHost: "peer"}, null, "local").sameSession).toBe(false);
});

test("a missing imported owner cannot fall back to the board coordinator", () => {
  expect(trackedSessionTargets(record({where: "human", sourceCoordinatorId: null}), "board").ownerId).toBeNull();
  expect(trackedSessionTargets(record({where: "human"}), "board").ownerId).toBe("board");
  expect(trackedSessionTargets(record({where: "session"}), "board").ownerId).toBeUndefined();
});
