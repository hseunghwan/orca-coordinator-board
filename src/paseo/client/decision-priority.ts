import type { PullRequestItem } from "../shared/prs";
import type { TrackedDecision } from "../shared/tracked-decisions";
import { comparePriority, recordReason, waitStart, type PriorityReason, type Priority } from "../shared/decision-priority";
import type { Card } from "./model";
import { pullRowKey, recordRowKey, sessionRowKey } from "./decision-receipts";

export type RankedDecision = Priority & (
  { kind:"pull"; pr:PullRequestItem } | { kind:"record"; item:TrackedDecision } | { kind:"session"; card:Card }
);

function sessionPriority(card: Card, now: number): Priority {
  const {session, note} = card;
  const key = sessionRowKey(card);
  const source = session.decision?.source;
  if (session.nativePending || source === "permission") {
    return { key, reason: "permission", waitingSince: waitStart(session.decisionRequestedAt, now) };
  }
  const needsReply = session.status === "idle" && (source === "conversation" || source === "coordinator" || source === "agent-note");
  const noteQuestion = source === "agent-note" || source === "person-note" || (!source && note?.kind === "question");
  const since = noteQuestion ? note?.requestedAt : session.decisionRequestedAt;
  return { key, reason: needsReply ? "reply" : "undated", waitingSince: waitStart(since, now) };
}

export function rankDecisionRows({prs, records, sessions}:{
  prs:readonly PullRequestItem[]; records:readonly TrackedDecision[]; sessions:readonly Card[];
}, now=Date.now()) {
  const rows:RankedDecision[] = [];
  for (const pr of prs) {
    // GitHub's updatedAt also changes for comments on a ready PR.
    rows.push({kind:"pull",pr,key:pullRowKey(pr),reason:"undated",waitingSince:null});
  }
  for (const item of records) {
    rows.push({kind:"record",item,key:recordRowKey(item),reason:recordReason(item,now),waitingSince:waitStart(item.since,now)});
  }
  for (const card of sessions) {
    rows.push({kind:"session", card, ...sessionPriority(card,now)});
  }
  return rows.sort(comparePriority);
}

type Translate = (ko:string,en:string)=>string;
const labels:Record<PriorityReason, [string,string]> = {
    overdue:["기한 지남","Overdue"], now:["지금 결정","Needs a decision now"], permission:["권한 승인 대기","Awaiting permission"],
    reply:["답변 대기","Awaiting reply"], blocker:["후속 작업 대기","Holding up work"], today:["오늘까지","Due today"],
    week:["이번 주","This week"], scheduled:["기한 있음","Scheduled"], undated:["기한 없음","No deadline"],
  };

function waitDuration(minutes: number): [string, string] {
  if (minutes < 1) return ["1분 미만", "<1m"];
  if (minutes < 60) return [minutes + "분", minutes + "m"];
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return [hours + "시간", hours + "h"];
  const days = Math.floor(hours / 24);
  return [days + "일", days + "d"];
}

export function priorityLabel(row: RankedDecision, t: Translate, now = Date.now()) {
  const [ko, en] = labels[row.reason];
  if (row.waitingSince === null) return t(ko, en);
  const [koAge, enAge] = waitDuration(Math.floor((now - row.waitingSince) / 60_000));
  if (row.reason === "permission" || row.reason === "reply" || row.reason === "blocker") {
    return t(ko + " " + koAge, en + " · " + enAge);
  }
  return t(ko + " · " + koAge + " 대기", en + " · waiting " + enAge);
}
