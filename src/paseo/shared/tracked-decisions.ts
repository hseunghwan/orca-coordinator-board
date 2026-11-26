import { defineRpc } from "../plugin-shim";
import { z } from "zod";
import { workImages } from "./work-images";
import { repositorySlug, type PullRequestView } from "./prs";
import type { SessionRow } from "./contract";

const id = z.string().min(1).max(256);
const projectId = z.string().min(1).max(4096);
const text = z.string().min(1).max(16000);
const optionalText = z.string().max(16000).nullish();
const lines = z.array(text).max(256).default([]);
const narrative = z.union([z.string().max(16000),z.array(text).max(128).transform(v=>v.join("\n"))]).nullish();
const target = z.object({repo:repositorySlug, number:z.number().int().positive()});
const reference = z.object({source:id,projectId:projectId.nullable(),id});
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const trackedDecisionInputSchema = reference.extend({
  title:text,
  kind:z.enum(["check","answer","merge","approve","cleanup","other"]).default("other"),
  ask:lines, recommend:lines, why:lines, risk:lines, steps:lines,
  questions:z.array(z.object({
    id:id.optional(), text, multi:z.boolean().default(false),
    options:z.array(z.object({key:id,text,recommended:z.boolean().default(false),does:narrative,pros:narrative,cons:narrative,note:optionalText})).max(128).default([]),
  })).max(128).default([]),
  qa:z.array(z.object({q:text, a:optionalText.default(null), askedAt:optionalText, answeredAt:optionalText})).max(512).default([]),
  replyHistory:z.array(z.object({text,at:optionalText})).max(512).default([]),
  sessionId:id.nullable().default(null), sessionHost:id.nullish(), mergeTarget:target.nullish(),
  sessionMatch:z.object({projectId,sessionId:id,question:text}).nullish(),
  since:optionalText, howToAnswer:optionalText, projectTitle:optionalText, urgency:optionalText,
  where:z.enum(["human","manager","session","unknown"]).nullish(), owner:optionalText, answerLead:optionalText,
  dueAt:z.string().max(64).nullish(), blocksWork:z.boolean().nullish(),
});
export type TrackedDecisionInput = z.output<typeof trackedDecisionInputSchema>;
export type RoutedTrackedDecision = TrackedDecisionInput & { sourceCoordinatorId?: string | null };
export const trackedDecisionSchema = trackedDecisionInputSchema.extend({
  queuedReply:z.object({messageId:z.string().uuid(),recipientId:id,answer:z.string().optional(),
    imageCount:z.number().int().nonnegative(), stopped:z.boolean()}).optional(),
  sourceCoordinatorId:id.nullable().optional(), key:z.string(), fingerprint, matchedSessionId:id.nullable(), matchedPull:target.nullable(),
});
export type TrackedDecision = z.output<typeof trackedDecisionSchema>;
export const trackedDecisionViewSchema = z.object({
  items:z.array(trackedDecisionSchema),status:z.enum(["ok","partial","absent","invalid","unavailable"]),
});
export type TrackedDecisionView = z.output<typeof trackedDecisionViewSchema>;
// Older ledgers may contain only the GitHub link in the request. An unambiguous
// link can identify the PR for reading, but never binds a merge action.
export function trackedPullTarget(item: TrackedDecisionInput) {
  if (item.kind !== "merge") return null;
  if (item.mergeTarget) return item.mergeTarget;
  const found = new Map<string, {repo:string; number:number}>();
  for (const line of item.ask) {
    for (const match of line.matchAll(/(?:^|[\s(<\[])(https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/([1-9]\d*))(?=$|[\s)>\]])/gi)) {
      const repo = repositorySlug.safeParse(match[2]);
      const number = Number(match[3]);
      if (repo.success && Number.isSafeInteger(number) && number <= 2147483647) {
        found.set(pullKey(repo.data, number), {repo:repo.data, number});
      }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

export function mentionsSecurityGate(item: TrackedDecisionInput) {
  return item.kind === "merge" && [item.title, ...item.ask, ...item.steps]
    .some(line => /보안\s*게이트|security[- ]gate/i.test(line));
}

export function trackedAnswerText(item: TrackedDecisionInput, replies: string[], freeReply: string) {
  const answers = item.questions.flatMap((question, index) => {
    const value = replies[index];
    return value ? [[question.id, question.text].filter(Boolean).join(" · ") + " — " + value] : [];
  });
  return [...answers, freeReply.trim()].filter(Boolean).join("\n");
}

export function suggestedTrackedReply(item: TrackedDecision) {
  return item.kind !== "merge" && !item.questions.length && !item.matchedSessionId ? item.howToAnswer?.trim() ?? "" : "";
}

export function usesSourceCoordinator(item:RoutedTrackedDecision) {
  return item.sourceCoordinatorId !== undefined && (item.where === "manager" || item.where === "human");
}

export function sourceCoordinatorRecipient(item:RoutedTrackedDecision, coordinator:string|null, sessions:readonly SessionRow[]) {
  const owner = item.sourceCoordinatorId;
  if (owner === undefined) return coordinator;
  return owner && (owner === coordinator || sessions.some(s => s.id === owner)) ? owner : null;
}

export function trackedRecipient(item:RoutedTrackedDecision, coordinator:string|null, sessions:readonly SessionRow[]) {
  if (item.where === "manager" || item.where === "human") return sourceCoordinatorRecipient(item,coordinator,sessions);
  if (item.where !== "session" || item.sessionHost || !item.sessionId) return null;
  const session = sessions.find(s => s.id === item.sessionId && s.projectId === item.projectId);
  return session ? session.id : null;
}

export const resolveTrackedDecision = defineRpc({
  name:"board.resolve-tracked-decision",
  input: reference.extend({fingerprint,answer:z.string().max(4000).optional(),recipientId:id.optional(),images:workImages.optional(),questionIndexes:z.array(z.number().int().min(0).max(127)).max(128).optional()}).strict().refine(v => !v.recipientId || !!v.answer?.trim() || !!v.images?.length),
  output:z.object({status:z.enum(["closed","already-closed","changed","out-of-scope","unavailable","sent","queued","busy","unconfirmed"])}),
});
export const cancelQueuedReply = defineRpc({
  name:"board.cancel-queued-reply",
  input:reference.extend({fingerprint,messageId:z.string().uuid()}).strict(),
  output:z.object({canceled:z.boolean()}),
});
export type TrackedResolution = z.output<typeof resolveTrackedDecision.input>;
export const trackedKey = (row:z.output<typeof reference>) => JSON.stringify([row.source,row.projectId,row.id]);
export const pullKey = (repo:string,number:number) => repo+"#"+number;

export function trackedMatches(item:RoutedTrackedDecision, sessions:SessionRow[], prs:PullRequestView) {
  const {sessionMatch,mergeTarget}=item;
  const session=!usesSourceCoordinator(item) && !item.sessionHost && sessionMatch && sessions.find(s=>s.id===sessionMatch.sessionId && s.projectId===sessionMatch.projectId &&
      s.lane==="human" && !s.nativePending && !s.decisionAnswered && s.decision?.source!=="permission" &&
      (s.decision?.question ?? s.detail)===sessionMatch.question &&
      (!item.sessionId || item.sessionId===s.id));
  const pr=mergeTarget && item.kind==="merge" && prs.items.find(p=>
    p.lane==="review" && p.reason==="ready" && p.repo===mergeTarget.repo && p.number===mergeTarget.number &&
    (!item.projectId || p.projectIds.includes(item.projectId)));
  return {matchedSessionId:session ? session.id : null,matchedPull:pr ? {repo:pr.repo,number:pr.number} : null};
}

// Call with the tracked cards visible under the current project filter.
// Every distinct tracked decision remains visible even when several refer to one session.
export function trackedCoverage(items:readonly TrackedDecision[]) {
  const sessionIds=new Set<string>();
  const pullKeys=new Set<string>();
  for(const item of items){
    if(item.matchedSessionId)sessionIds.add(item.matchedSessionId);
    if(item.matchedPull)pullKeys.add(pullKey(item.matchedPull.repo,item.matchedPull.number));
  }
  return {sessionIds,pullKeys};
}
