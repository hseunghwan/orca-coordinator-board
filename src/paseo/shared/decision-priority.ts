import { z } from "zod";
import { trackedKey, type TrackedDecisionInput } from "./tracked-decisions";

const rank = { overdue:0, now:0, permission:1, reply:1, blocker:1, today:2, week:3, scheduled:4, undated:5 };
export type PriorityReason = keyof typeof rank;
export type Priority = { key:string; reason:PriorityReason; waitingSince:number|null };
const calendarDate = z.iso.date();
const instant = z.iso.datetime({offset:true});

function timestamp(value: string | null | undefined, endOfDay = false) {
  if (!value) return NaN;
  if (value.length === 10 && calendarDate.safeParse(value).success) {
    // A date with no time covers the local calendar day.
    return Date.parse(value + (endOfDay ? "T23:59:59.999" : "T00:00:00"));
  }
  return instant.safeParse(value).success ? Date.parse(value) : NaN;
}

export function waitStart(value: string | null | undefined, now: number) {
  const at = timestamp(value);
  return at <= now ? at : null;
}

type RecordEvidence = TrackedDecisionInput & { matchedSessionId?: string | null };
export function recordReason(item:RecordEvidence, now:number):PriorityReason {
  const due = timestamp(item.dueAt, true);
  if (due <= now) return "overdue";
  if (item.urgency === "now") return "now";
  if (item.blocksWork) return "blocker";
  if (item.matchedSessionId) return "reply";

  const endOfToday = new Date(now);
  endOfToday.setHours(23,59,59,999);
  if (item.urgency === "today" || due <= endOfToday.getTime()) return "today";
  const endOfWeek = new Date(endOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()) % 7);
  if (item.urgency === "week" || due <= endOfWeek.getTime()) return "week";
  return Number.isFinite(due) ? "scheduled" : "undated";
}

export function comparePriority(a:Priority,b:Priority) {
  const byReason = rank[a.reason] - rank[b.reason];
  if (byReason) return byReason;
  if (a.waitingSince !== b.waitingSince) return (a.waitingSince ?? Infinity) - (b.waitingSince ?? Infinity);
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// The local first-paint preview can rank ledger records before session matches arrive.
export function sortTrackedByPriority<T extends RecordEvidence>(items:readonly T[],now=Date.now()):T[] {
  return items.map(item=>({ item, key:trackedKey(item), reason:recordReason(item,now), waitingSince:waitStart(item.since,now) }))
    .sort(comparePriority).map(row=>row.item);
}
