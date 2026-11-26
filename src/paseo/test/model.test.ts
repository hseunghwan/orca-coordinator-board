import { expect, test } from "vitest";
import { decisionCount } from "../shared/decision-count";
import type { PullRequestItem } from "../shared/prs";
import { projectCards, projectFilterNames } from "../client/model";
import type { Note, SessionRow } from "../shared/contract";

test("the digest and projects share one classification; new work takes priority over past completion", () => {
  const base: SessionRow = {
    id: "", title: "검토", projectId: "alpha", projectTitle: "서점", workspaceTitle: "작업",
    model: null, lane: "idle", detail: "",
  };
  const statuses = ["human", "running", "review", "idle", "idle", "idle"] as const;
  const sessions = statuses.map((lane, index) => ({
    ...base, lane, id: String(index), projectId: index < 3 ? "alpha" : "beta",
  }));
  const notes = Object.fromEntries(sessions.slice(0, 5).map((session, i) => [session.id, {
    sessionId: session.id, kind: i === 4 ? "question" : "done", text: "예시 근거", revision: 1,
  } satisfies Note]));
  const { human, projects } = projectCards({ sessions, notes, projects: [], coordinator: null });
  expect(human.map(c => c.session.id)).toEqual(["0", "4"]);
  expect(projects.flatMap(p => p.cards).map(c => c.lane)).toEqual(["human", "running", "review", "done", "human", "idle"]);
  expect(projects.length).toBe(2);
});

test("a delivered reply takes the same question out of the digest while preserving live work and new prompts", () => {
  const sessions: SessionRow[] = (["idle", "running", "unknown", "human"] as const).map((lane, i) => ({
    id: String(i), title: "Review", projectId: "p", projectTitle: "P", workspaceTitle: "W",
    lane, detail: "", model: null, decisionAnswered: true, nativePending: i === 3,
  }));
  const notes = Object.fromEntries(sessions.map(s => [s.id, { sessionId: s.id, kind: "question", text: "original", revision: 1 } satisfies Note]));
  const { projects, human } = projectCards({ sessions, notes, projects: [], coordinator: null });
  expect(projects[0].cards.map(c => c.lane)).toEqual(["review", "running", "unknown", "human"]);
  expect(human.map(c => c.session.id)).toEqual(["3"]);
});

test("사이드바에서 네이티브 승인, 사용자 질문과 여러 프로젝트가 공유하는 준비된 PR을 한 번씩 집계한다", () => {
  const base: SessionRow = { id: "s", title: "title", projectId: "p", projectTitle: "project", workspaceTitle: "workspace", lane: "idle", detail: "", model: null };
  const sessions = [{ ...base, nativePending: true }, { ...base, id: "question" }, { ...base, id: "answered", lane: "human" as const, decisionAnswered: true }];
  const notes = { question: { sessionId: "question", kind: "question" as const, text: "review", revision: 1 } };
  const ready: PullRequestItem = { number: 1, repo: "example/shop", title: "one", url: "https://github.com/example/shop/pull/1",
    projectIds: ["one", "two"], lane: "review", reason: "ready", updatedAt: "2026-01-01" };
  const draft: PullRequestItem = { ...ready, number: 2, reason: "draft", lane: "progress" };
  expect(decisionCount({ sessions, notes, pullRequests: { projects: [], items: [ready, draft] } })).toBe(3);
  expect(decisionCount({ sessions, notes })).toBe(2);
  expect(decisionCount({ sessions: [], notes: {}, pullRequests: { projects: [], items: [ready] } })).toBe(1);
  expect(decisionCount({ sessions: [], notes: {} })).toBe(0);
});

test("project filters distinguish same-name checkouts and keep unrelated names short", () => {
  const labels = projectFilterNames([
    {id:"first",title:"Example",path:"/work/first/Example"},
    {id:"second",title:"Example",path:"C:\\work\\second\\Example"},
    {id:"third",title:"Other",path:"/work/Other"},
    {id:"fourth",title:"Shared",path:"/work/shared"},
    {id:"fifth",title:"Shared",path:"/work/shared"},
  ]);
  expect([...labels.values()]).toEqual(["Example · first/Example","Example · second/Example","Other","Shared · fourth","Shared · fifth"]);
});
