// Adapted from paseo-coordinator-board server/clarifications.ts @ 2e9d128. Sending goes through fleet.deliver
// and a pending question is settled by fleet.reconcile, never sent again. A coordinator or ledger owner is
// asked only while idle, as Orca cannot steer a running turn. Photos come in a later phase.
import { createHash } from "node:crypto";
import type { Fleet, PluginHandlerContext, SessionId } from "../orca";
import {
  clarificationKey,
  clarificationTarget,
  sourceQuestion,
  type ClarificationCard,
  type ClarificationEntry,
  type ClarificationInput,
  type ClarificationView,
} from "../paseo/shared/clarifications";
import { isManagedCoordinator, type PreferenceStore, type Preferences } from "../paseo/server/preferences";
import type { SessionRow, Note } from "../paseo/shared/contract";
import type { Evidence } from "./conversation";
import { isCurrentMembership, managedSessions } from "./session-links";
import { canReceiveBoardInput, discoverSessions, permissionVersion } from "./discovery";

type Sdk = PluginHandlerContext["paseo"];
type Stored = Preferences["clarifications"][string];
type Target = NonNullable<ReturnType<typeof clarificationTarget>>;
type View = ClarificationView & { notes: Record<string, Note> };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const changed = "원래 질문이나 담당 세션이 바뀌었습니다. 카드를 새로 고쳐 주세요.";
const uncertain = "추가 질문의 전송 여부를 확인하지 못했습니다. 같은 내용으로 다시 확인해 주세요.";
const noPhotos = "사진 첨부는 아직 보낼 수 없습니다. 글로만 질문해 주세요.";

function requestId(key: string) {
  const hex = hash("coordinator-board/clarification/" + key);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}
function body(input: ClarificationInput, target: Target) {
  return (
    "[Coordinator Board · 추가 질문]\n" +
    JSON.stringify({
      card: input.card,
      sourceSessionId: target.sourceSessionId,
      sourceHost: target.sourceHost,
      recipientSessionId: input.recipientId,
      title: target.title,
      originalQuestion: target.question,
    }) +
    "\n\n이 결정에 대한 추가 질문입니다. 아래 질문에 설명으로 답해 주세요. 결정·승인·병합·작업 실행은 별도입니다.\n\n" +
    input.question
  );
}

function inScope(scope: Preferences, card: ClarificationCard) {
  return card.projectId === null ? scope.projects.length > 0 : scope.projects.includes(card.projectId);
}

// The original answer buttons still refer to the original revision. Keep them
// only while this exact clarification is the latest input in its source session.
export function restoreClarifiedDecision(
  row: SessionRow,
  note: Note | undefined,
  prefs: Preferences,
  evidence?: Evidence,
) {
  if (
    row.nativePending ||
    row.status === "closed" ||
    row.status === "error" ||
    row.decisionAnswered ||
    !evidence ||
    evidence.laterInput
  )
    return;
  for (const id of evidence.lastInputIds ?? []) {
    const record = prefs.clarifications?.[id];
    const original = record && sourceQuestion(record.card);
    if (
      !record?.savedDecision ||
      !original ||
      original.projectId !== row.projectId ||
      original.sessionId !== row.id ||
      original.version !== record.savedDecision.version ||
      record.recipientId !== row.id ||
      prefs.answers[row.id]?.version === original.version ||
      (note?.revision ?? 0) !== record.noteRevision
    )
      continue;
    // Digest judgments classify the explanation turn. Its original decision stays
    // open until an answer, a new input, or a note revision supersedes it.
    row.decision = record.savedDecision;
    row.decisionRequestedAt = record.sourceRequestedAt;
    if (record.sourceEvidenceId) row.evidenceId = record.sourceEvidenceId;
    row.lane = "human";
    row.detail = record.savedDecision.question;
    return;
  }
}

export function clarificationHistory(
  store: PreferenceStore,
  rows: Map<string, SessionRow>,
  evidence: Map<string, Evidence>,
): ClarificationEntry[] {
  const scope = store.read();
  const result: ClarificationEntry[] = [];
  const updates = new Map<string, string | undefined>();
  for (const entry of Object.values(scope.clarifications)) {
    if (!inScope(scope, entry.card) || !rows.has(entry.recipientId)) continue;
    const message = evidence.get(entry.recipientId)?.clarificationMessages?.get(entry.messageId);
    const accepted = message?.bodyHash === entry.bodyHash;
    const response = (accepted ? message.response : undefined) ?? entry.response;
    if (accepted && (entry.response !== response || entry.status !== "sent")) updates.set(entry.messageId, response);
    result.push({
      cardKey: entry.cardKey,
      messageId: entry.messageId,
      recipientId: entry.recipientId,
      at: entry.at,
      question: entry.question,
      imageCount: entry.imageCount,
      status: accepted ? "sent" : entry.status,
      response,
    });
  }
  if (updates.size)
    store.change((current) => {
      for (const [id, response] of updates) {
        const record = current.clarifications[id];
        if (record) {
          record.response = response;
          record.status = "sent";
        }
      }
    });
  return result.sort((a, b) => a.at.localeCompare(b.at));
}

export class ClarificationSender {
  private active = new Map<
    string,
    { key: string; fingerprint: string; result: Promise<{ ok: true; messageId: string; recipientId: string }> }
  >();
  constructor(
    private store: PreferenceStore,
    private fleet: Pick<Fleet, "deliver" | "reconcile">,
    private getView: (sdk: Sdk, card: ClarificationCard) => Promise<View>,
    private isCurrentRecord: (card: ClarificationCard, view: View) => boolean = () => true,
  ) {}

  send(sdk: Sdk, input: ClarificationInput) {
    if (input.images?.length) throw Error(noPhotos);
    const id = requestId(input.requestKey);
    const key = clarificationKey(input.card);
    const identity = [key, input.recipientId, input.question, []];
    if (input.card.kind === "tracked" && input.card.sessionQuestion) {
      const { projectId, sessionId, version } = input.card.sessionQuestion;
      identity.push(JSON.stringify([projectId, sessionId, version]));
    }
    const fingerprint = hash(JSON.stringify(identity));
    const running = this.active.get(id);
    if (running) {
      if (running.fingerprint !== fingerprint) throw Error("같은 요청 키로 다른 질문을 보낼 수 없습니다.");
      return running.result;
    }
    if ([...this.active.values()].some((r) => r.key === key))
      throw Error("이 카드의 추가 질문을 전송하고 있습니다.");
    const result = this.deliver(sdk, input, id, fingerprint).finally(() => this.active.delete(id));
    this.active.set(id, { key, fingerprint, result });
    return result;
  }

  private async deliver(sdk: Sdk, input: ClarificationInput, id: string, fingerprint: string) {
    const key = clarificationKey(input.card);
    let scope = this.store.read();
    if (!inScope(scope, input.card)) throw Error(changed);
    const previous = scope.clarifications[id];
    const handle = sdk.agents.ref(input.recipientId);
    const receipt = { ok: true as const, messageId: id, recipientId: input.recipientId };
    let settled = false;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error("같은 요청 키로 다른 질문을 보낼 수 없습니다.");
      if (previous.status === "sent") return receipt;
      const all = await discoverSessions(sdk);
      const scopeNow = this.store.read();
      if (!inScope(scopeNow, input.card) || !managedSessions(all, scopeNow).some((r) => r.id === input.recipientId))
        throw Error(changed);
      const outcome = await this.fleet.reconcile(id);
      if (outcome && outcome.status !== "delivered") throw Error(uncertain);
      if (!inScope(this.store.read(), input.card)) throw Error(changed);
      if (outcome) settled = true;
      else {
        // Never attempted, so nothing went out: ask again as new.
        this.store.change((current) => { delete current.clarifications[id]; });
        scope = this.store.read();
      }
    }
    if (!settled) {
      if (Object.values(scope.clarifications).some((r) => r.cardKey === key && r.status === "pending"))
        throw Error(uncertain);
      // Refresh the destination first so that the final card read verifies ownership,
      // permissions and revision after the asynchronous transport lookup.
      const destination = (await handle.refresh())?.agent;
      if (
        !destination ||
        destination.id !== input.recipientId ||
        destination.archivedAt ||
        destination.internal || destination.status==="closed" || destination.status==="error"
      )
        throw Error("질문을 받을 수 있는 대기 중인 세션을 확인해 주세요.");
      const view = await this.getView(sdk, input.card);
      const target = clarificationTarget(input.card, view);
      if (!target || target.recipientId !== input.recipientId) throw Error(changed);
      const original = sourceQuestion(input.card);
      const source = target.sourceHost ? undefined : view.sessions.find((s) =>
        s.id === target.sourceSessionId && s.projectId === (original?.projectId ?? input.card.projectId)
      );
      const recipient = view.sessions.find((s) => s.id === input.recipientId);
      const ids = new Set([input.recipientId, ...(original ? [original.sessionId] : [])]);
      let recipientAt = Number.NaN;
      for (const sessionId of ids) {
        const live = (await sdk.agents.ref(sessionId).refresh())?.agent;
        if (!live || live.id !== sessionId || live.archivedAt || live.internal) throw Error(changed);
        if (sessionId === input.recipientId && !canReceiveBoardInput(live, false)) throw Error(changed);
        if (
          sessionId === original?.sessionId &&
          (source?.nativePending ? permissionVersion(live) !== source.permissionVersion : live.updatedAt !== source?.activityAt)
        )
          throw Error(changed);
        if (sessionId === input.recipientId) recipientAt = Date.parse(live.updatedAt);
      }
      if (target.sourceCoordinatorId === input.recipientId) {
        const rows = await discoverSessions(sdk);
        const scopeNow = this.store.read();
        const visible = managedSessions(rows, scopeNow).some(r => r.id === input.recipientId);
        const operating = scopeNow.coordinator === input.recipientId && isManagedCoordinator(scopeNow, input.recipientId) &&
          rows.some(r => r.id === input.recipientId);
        if (!visible && !operating) throw Error(changed);
      }
      if (!this.isCurrentRecord(input.card, view)) throw Error(changed);
      const text = body(input, target);
      const preserve = original && source?.decision && source.decision.version === original.version &&
        source.decision.source !== "permission" && source.id === input.recipientId;
      const entry: Stored = {
        card: input.card,
        cardKey: key,
        sourceSessionId: target.sourceSessionId,
        recipientId: input.recipientId,
        messageId: id,
        fingerprint,
        bodyHash: hash(text),
        at: new Date().toISOString(),
        question: input.question,
        status: "pending",
        ...(preserve ? {
          savedDecision: source.decision,
          sourceEvidenceId: source.evidenceId,
          sourceRequestedAt: source.decisionRequestedAt,
          noteRevision: view.notes[source.id]?.revision ?? 0,
        } : {}),
      };
      this.store.change((current) => {
        if (
          !inScope(current, input.card) ||
          current.coordinator !== view.coordinator ||
          (original && (current.answers[original.sessionId]?.version === original.version ||
            JSON.stringify(current.judgments[original.sessionId]) !== JSON.stringify(scope.judgments[original.sessionId]))) ||
          (source && !isCurrentMembership(source, current)) ||
          !(
            (recipient && isCurrentMembership(recipient, current)) ||
            isManagedCoordinator(current, input.recipientId)
          )
        )
          throw Error(changed);
        current.clarifications[id] = entry;
      });
      let outcome;
      try {
        outcome = await this.fleet.deliver({ messageId: id, to: input.recipientId as SessionId, text, subject: target.title,
          from: { kind: "person" }, whenWorking: "refuse", unchangedSince: recipientAt });
      } catch {
        throw Error(uncertain);
      }
      if (outcome.status === "refused") {
        this.store.change((current) => { delete current.clarifications[id]; });
        throw Error(changed);
      }
      if (outcome.status === "unconfirmed") throw Error(uncertain);
    }
    this.store.change((current) => {
      current.clarifications[id].status = "sent";
    });
    return receipt;
  }
}
