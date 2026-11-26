// Adapted from paseo-coordinator-board server/tracked-review.ts @ 2e9d128: review_board_records is the
// coordinator-board review command; the body is Paseo's.
import { z } from "zod";
import { trackedPullTarget, usesSourceCoordinator, type TrackedDecision } from "../paseo/shared/tracked-decisions";
import { managedRowsForCoordinator, tool } from "./coordinator";
import { isCurrentMembership } from "./session-links";
import type { ConversationReader, Evidence } from "./conversation";
import type { PreferenceStore } from "../paseo/server/preferences";
import type { ProjectPullRequests } from "./prs";
import type { TrackedDecisionStore } from "./tracked-decisions";

function needsPerson(item: TrackedDecision) {
  return item.where === "human" || item.questions.length > 0 || item.qa.some(q => !q.a?.trim());
}

export function mergeOnly(item: TrackedDecision) {
  if (item.kind !== "merge" || !item.projectId || needsPerson(item) || item.ask.length !== 1) return false;
  // Legacy cards can put unrelated requests in their prose. Recognize only a standalone merge question.
  const target = trackedPullTarget(item);
  if (!target) return false;
  const ask = item.ask[0].replace(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/gi, (_url, repo, number) =>
    repo.toLowerCase() === target.repo.toLowerCase() && Number(number) === target.number ? "PR" : "CONFLICT").trim();
  if ([...ask.matchAll(/([\w.-]+)?#(\d+)/g)].some(([, repo, number]) =>
    Number(number) !== target.number || (repo && repo.toLowerCase() !== target.repo.split("/").at(-1)?.toLowerCase()))) return false;
  return /^(?:PR|#\d+|[\w.-]+#\d+)(?:을|를)?\s*(?:(?:지금|보안 게이트 통과 뒤)\s+)?병합(?:할까요|해도 될까요|할까)[?？]?$|^(?:shall|should|can) (?:I|we) merge (?:this |the )?(?:PR|#\d+)[?？]?$/i.test(ask) &&
    !/\s\+\s|그리고|언제|and (?:when|whether)/i.test(item.title);
}

function coordinatorCheck(item: TrackedDecision) {
  return !needsPerson(item) && ["manager","session"].includes(item.where ?? "") && ["check","answer","other"].includes(item.kind);
}

export function matchesReviewEvidence(item: TrackedDecision, evidence: Evidence | null, evidenceId: string, quote: string) {
  const last = evidence?.turns.at(-1);
  if (!coordinatorCheck(item) || !last || evidence?.id !== evidenceId || evidence.laterInput || last.role !== "assistant" || last.truncated) return false;
  if (item.since && (!last.at || !(Date.parse(last.at) >= Date.parse(item.since)))) return false;
  // Retire only an affirmative completion report. A quoted earlier result in a later request is ambiguous.
  const finalParagraph = last.text.trim().split(/\n\s*\n/).at(-1);
  if (finalParagraph !== quote || /[?？]|아직|보류|미완|재확인|재검증|필요|않|실패|\b(?:not|never|failed|pending|unless|if|but|until|recheck|incomplete)\b/i.test(quote)) return false;
  const confirmed = /(?:완료|검증|확인|통과)(?:했(?:습니다|어요)|됐(?:습니다|어요)|되었습니다|함|됨)[.!]?$|\b(?:completed|verified|passed|confirmed|done)[.!]?$/i.test(quote);
  return confirmed && (quote.includes(item.title) || (item.id.length >= 8 && quote.includes(item.id)));
}

export function trackedReviewTool(prefs: PreferenceStore, tracked: TrackedDecisionStore, prs: ProjectPullRequests, reader: ConversationReader, invalidate: () => void) {
  return tool("coordinator", z.strictObject({review: z.strictObject({
      key:z.string().min(1).max(6000), fingerprint:z.string().regex(/^[a-f0-9]{64}$/),
      evidenceId:z.string().min(1).max(64), quote:z.string().trim().min(8).max(1600),
    }).optional()}),
    async ({review}, {paseo, agent}) => {
      const sessions = await managedRowsForCoordinator(paseo, prefs, agent.id);
      const scope = () => {
        const current = prefs.read();
        if (current.coordinator !== agent.id || !current.projects.length) throw Error("Coordinator scope changed");
        return new Set(current.projects);
      };
      const records = tracked.read(scope(), sessions, {items:[], projects:[]});
      const items = records.items.filter(item => !usesSourceCoordinator(item) || item.sourceCoordinatorId === agent.id);
      const close = (item: TrackedDecision, reason: string) => {
        const {status} = tracked.resolve({source:item.source, projectId:item.projectId, id:item.id, fingerprint:item.fingerprint}, scope,
          {coordinatorId:agent.id, reason});
        if (status === "closed") invalidate();
        return status;
      };
      if (review) {
        const item = items.find(record => record.key === review.key && record.fingerprint === review.fingerprint);
        const source = item && !item.sessionHost && sessions.find(s => s.id === item.sessionId && s.projectId === item.projectId);
        if (!source || !item || source.nativePending || source.status !== "idle") return {text:"No current completion evidence."};
        const evidence = await reader.read(paseo, source, true);
        const again = await managedRowsForCoordinator(paseo,prefs,agent.id);
        const current = again.find(s => s.id === source.id && s.projectId === source.projectId && !s.nativePending && s.status === "idle");
        if (!current || current.activityAt !== source.activityAt || !isCurrentMembership(current,prefs.read())) return {text:"Source session changed."};
        const clarifications = prefs.read().clarifications;
        if (evidence?.lastInputIds?.some(id => clarifications[id])) return {text:"A clarification is not completion evidence."};
        if (!matchesReviewEvidence(item,evidence ?? null,review.evidenceId,review.quote)) return {text:"The completion evidence has changed or does not identify this record."};
        return {text:close(item, review.quote)};
      }
      const closed:string[] = [];
      for (const item of items.filter(mergeOnly)) {
        const target = trackedPullTarget(item);
        if (!target || await prs.lifecycle(paseo,{...target,projectId:item.projectId!}) !== "MERGED") continue;
        if (close(item,"GitHub · " + target.repo + " #" + target.number + " · MERGED") === "closed") closed.push(item.key);
      }
      const reviewable = items.filter(item => coordinatorCheck(item) && !item.sessionHost && sessions.some(s=>s.id===item.sessionId && s.projectId===item.projectId));
      return {text:JSON.stringify({closed,reviewable:reviewable.map(({key,fingerprint,title,sessionId})=>({key,fingerprint,title,sessionId}))})};
    });
}
