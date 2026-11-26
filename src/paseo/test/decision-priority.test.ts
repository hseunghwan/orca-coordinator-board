import { expect, test } from "vitest";
import { priorityLabel, rankDecisionRows } from "../client/decision-priority";
import type { Card } from "../client/model";
import { trackedDecisionSchema } from "../shared/tracked-decisions";
import type { TrackedDecision } from "../shared/tracked-decisions";
import type { PullRequestItem } from "../shared/prs";

const now = new Date(2026, 10, 18, 12).getTime(); // Wednesday, local time
const before = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
function record(id: string, fields: Partial<TrackedDecision> = {}): TrackedDecision {
  return trackedDecisionSchema.parse({ id, key:id, fingerprint:"0".repeat(64), source:"board", projectId:"a", title:id,
    matchedSessionId:null, matchedPull:null, ...fields });
}
function session(id: string, fields: Partial<Card["session"]> = {}): Card {
  return { lane:"human", note:undefined, session:{ id, title:id, model:null, projectId:"b", projectTitle:"B",
    workspaceTitle:"Branch", lane:"human", detail:"", ...fields } };
}
const pr: PullRequestItem = { repo:"o/r", number:1, title:"ready", url:"https://github.com/o/r/pull/1",
  projectIds:["p"], lane:"review", reason:"ready", updatedAt:before(240) };
const title = (row: ReturnType<typeof rankDecisionRows>[number]) => row.kind === "record" ? row.item.title : row.kind === "pull" ? row.pr.title : row.card.session.title;
const korean = (ko:string, en:string) => ko;
const english = (ko:string, en:string) => en;

test("mixes card types by urgency, actual blockers and age; permission never borrows last activity", () => {
  const records = [
    record("later", { urgency:"week", since:before(200) }), record("urgent", { urgency:"now", since:before(2) }),
    record("deploy", { kind:"merge",blocksWork:true,since:before(12) }),
    record("expired", { dueAt:before(1), since:before(5) }), record("today", { urgency:"today", where:"human" }),
  ];
  const sessions = [
    session("permission", {nativePending:true, activityAt:before(900)}),
    session("question", {status:"idle", decision:{source:"conversation",question:"Which?",version:"v1"}, decisionRequestedAt:before(20)}),
  ];
  const rows = rankDecisionRows({ records, sessions, prs:[pr] }, now);
  expect(rows.map(title)).toEqual(["expired","urgent","question","deploy","permission","today","later","ready"]);
  expect(priorityLabel(rows[2],korean,now)).toBe("답변 대기 20시간");
  expect(priorityLabel(rows[2],english,now)).toBe("Awaiting reply · 20h");
  expect(rows.at(-1)?.waitingSince).toBeNull();
  expect(rows[4].waitingSince).toBeNull();
});

test("linked live questions are blockers but a session link, notes, and merge readiness alone are insufficient", () => {
  const records = [
    record("manual", {where:"human",sessionId:"s",since:before(10)}),
    record("linked", {matchedSessionId:"verified",where:"session",since:before(1)}),
  ];
  const note = session("note", {status:"running"});
  note.note = {sessionId:"note",kind:"question",text:"Later?",origin:"person",revision:1};
  const rows = rankDecisionRows({ records, sessions:[note], prs:[pr] },now);
  expect(title(rows[0])).toBe("linked");
  expect(rows.find(row=>title(row)==="manual")?.reason).toBe("undated");
  expect(rows.find(row=>title(row)==="note")?.reason).toBe("undated");
});

test("explicit local date deadlines last through that day; unknown wait timestamps sort last with stable ties", () => {
  const records = [
    record("a", {since:"invalid"}), record("b", {since:before(-5)}),
    record("today", {dueAt:"2026-11-18"}), record("week", {dueAt:"2026-11-20"}), record("old", {dueAt:"2026-11-17"}),
    record("unknown", {since:before(3)}),
  ];
  const rank = (rows:TrackedDecision[])=>rankDecisionRows({records:rows,prs:[],sessions:[]},now);
  expect(rank(records).map(title)).toEqual(["old","today","week","unknown","a","b"]);
  expect(rank([...records].reverse()).map(title)).toEqual(rank(records).map(title));
  expect(rank(records)[2].reason).toBe("week");
});

test("invalid and ambiguous dates never become overdue; explicit instants respect their offset", () => {
  const records = [record("numeric",{dueAt:"4"}), record("impossible",{dueAt:"2026-02-31"}), record("offset",{dueAt:"2026-01-01T10:00:00+09:00"})];
  const rows=rankDecisionRows({records,prs:[],sessions:[]},Date.parse("2026-01-01T02:00:00Z"));
  expect(rows.map(row=>row.reason)).toEqual(["overdue","undated","undated"]);
});

test("permission, question, and note ages are scoped to the current request", () => {
  const sessions = [
    session("permission",{nativePending:true}),
    session("question",{status:"idle",decision:{source:"conversation",question:"Which?",version:"v"},decisionRequestedAt:before(4)}),
    session("note",{status:"idle",decision:{source:"agent-note",question:"Which?",version:"v"},decisionRequestedAt:before(4)}),
  ];
  for (const card of sessions) card.note={sessionId:card.session.id,kind:"question",origin:"agent",revision:1,text:"Which?",requestedAt:before(2)};
  const rows=rankDecisionRows({sessions,records:[],prs:[]},now);
  expect(rows.map(row=>[title(row),row.waitingSince])).toEqual([["question",Date.parse(before(4))],["note",Date.parse(before(2))],["permission",null]]);
});
