// Adapted from paseo-coordinator-board server/decisions.ts @ 2e9d128. Sending goes through fleet.deliver
// instead of agent.send: a refused send leaves nothing behind and drops its pending receipt, and a
// pending receipt is settled by fleet.reconcile, which never sends again. A coordinate action waits for
// an idle coordinator, as Orca cannot steer a running turn. Photos are saved as Paseo saves them and
// named by path in the message (./photo-files.ts), as Orca cannot attach them.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Fleet, PluginHandlerContext, SessionId } from "../orca";
import type { Decision, DecisionInput } from "../paseo/shared/decision-actions";
import type { Note, SessionRow } from "../paseo/shared/contract";
import type { NoteStore } from "../paseo/server/notes";
import { isManagedCoordinator, type Preferences, type PreferenceStore } from "../paseo/server/preferences";
import { classify, ConversationReader, lastConversationQuestion, type Evidence } from "./conversation";
import { restoreClarifiedDecision } from "./clarifications";
import { sessionReplyMessage } from "./decision-message";
import { canReceiveBoardInput, discoverSessions } from "./discovery";
import { isCurrentMembership, managedSessions } from "./session-links";
import { SessionPhotoStore } from "../paseo/server/session-photos";
import { describePhotos, photoReceiptId } from "../paseo/server/reply-photos";
import { photoFiles } from "./photo-files";

type Sdk = PluginHandlerContext["paseo"];
type Receipt = { ok: true; recipientId: string; messageId: string };
type Sending = Pick<Fleet, "deliver" | "reconcile">;
const changed = "결정 카드 또는 수신자가 바뀌었습니다. 보드를 새로 고쳐 주세요.";
const blocked = "이 세션의 현재 상태에서는 보낼 수 없습니다. 원래 세션에서 권한 요청과 작업 상태를 확인하세요.";
const uncertain = "전송 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하거나 수신 세션을 열어 주세요.";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * escalation: the board's question for work whose fix attempts ran out (src/server/work-items.ts escalationQuestion).
 * It is the board's own state, not a guess from the transcript, so it comes right after a permission request.
 */
export function decorateDecision(row: SessionRow, note: Note | undefined, prefs: Preferences, evidence?: Evidence, escalation?: string | null) {
  const answer = prefs.answers[row.id];
  const noteQuestion = note?.kind === "question";
  const answeredNote = noteQuestion && answer?.noteRevision === note.revision;
  const dismissed = row.evidenceId && row.evidenceId === note?.evidenceId && note.origin === "person" && note.kind !== "question";
  let content: Omit<Decision, "version">;
  if (row.nativePending) {
    content = { source: "permission", question: row.detail };
  } else if (escalation && row.status === "idle" && row.evidenceId) {
    content = { source: "coordinator", question: escalation };
  } else if (row.status === "idle" && row.evidenceId && !dismissed && row.lane === "human") {
    const judgment = prefs.judgments[row.id];
    const structured = judgment?.kind === "question" && judgment.evidenceId === row.evidenceId && judgment.projectId === row.projectId;
    content = structured
      ? { ...judgment.content, source: "coordinator", question: judgment.content?.question || judgment.text }
      : { source: "conversation", question: row.detail.replace(/^세션의 확인 요청 · /, "") };
  } else if (noteQuestion && !answeredNote && row.status === "idle" && row.evidenceId) {
    content = { source: note.origin === "agent" ? "agent-note" : "person-note", question: note.text };
  } else {
    if (answeredNote && !row.nativePending) row.decisionAnswered = true;
    return;
  }
  const version = hash([row.projectId, row.id, row.nativePending ? row.permissionVersion : row.evidenceId, note?.revision ?? 0, content]);
  if (content.source !== "permission" && answer?.version === version) {
    row.decisionAnswered = true;
    row.lane = "review";
    row.detail = "답장을 보냈습니다. 담당 세션의 결과를 기다립니다.";
  } else {
    row.decision = { ...content, version };
    if (content.source === "conversation" && evidence) {
      const excerpt = lastConversationQuestion(evidence, row.id === prefs.coordinator);
      if (excerpt?.question === content.question && excerpt.markdown !== content.question) {
        row.decision.questionMarkdown = excerpt.markdown;
      }
    }
  }
}

function requireScope(scope: Preferences, input: DecisionInput) {
  const recipient = input.action === "coordinate" ? scope.coordinator : input.sessionId;
  if (!scope.projects.includes(input.projectId) || !recipient || recipient !== input.recipientId) throw Error(changed);
}

function messageUuid(key: string) {
  const h = hash(["coordinator-board/decision", key]);
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

export class DecisionSender {
  private active = new Map<string, { fingerprint: string; result: Promise<Receipt> }>();
  private sendingCards = new Set<string>();
  private photoDirectory: string;
  private sessionPhotos: SessionPhotoStore;
  constructor(private store: PreferenceStore, private notes: NoteStore, private reader: ConversationReader, private fleet: Sending,
    private escalation: (sessionId: string) => string | null = () => null) {
    this.photoDirectory = join(store.directory, "session-photos");
    this.sessionPhotos = new SessionPhotoStore(this.photoDirectory);
  }

  send(paseo: Sdk, input: DecisionInput): Promise<Receipt> {
    const messageId = messageUuid(input.requestKey);
    const photos = describePhotos(input.images);
    const content = [input.projectId, input.sessionId, input.recipientId, input.version, input.action, input.text];
    // Keep text-only keys compatible with receipts written before photo support.
    const fingerprint = hash(photos.length ? [...content, photos] : content);
    const running = this.active.get(messageId);
    if (running) {
      if (running.fingerprint === fingerprint) return running.result;
      return Promise.reject(Error("같은 전송 키로 다른 답을 보낼 수 없습니다."));
    }
    if (this.sendingCards.has(input.sessionId)) return Promise.reject(Error("이 카드의 이전 전송을 확인하고 있습니다."));
    this.sendingCards.add(input.sessionId);
    const result = this.deliver(paseo, input, messageId, fingerprint).finally(() => {
      this.active.delete(messageId);
      this.sendingCards.delete(input.sessionId);
    });
    this.active.set(messageId, { fingerprint, result });
    return result;
  }

  private async deliver(paseo: Sdk, input: DecisionInput, messageId: string, fingerprint: string): Promise<Receipt> {
    const scope = this.store.read();
    requireScope(scope, input);
    messageId = photoReceiptId(messageId, !!input.images?.length, scope.decisionReceipts);
    const requestId = messageId;
    let earlier = scope.decisionReceipts[messageId];
    if (!earlier) {
      const previous = Object.entries(scope.decisionReceipts).find(([, saved]) =>
        saved.sessionId === input.sessionId && saved.version === input.version &&
        (saved.fingerprint === fingerprint || saved.status === "pending"));
      if (previous) {
        [messageId, earlier] = previous;
        if (earlier.fingerprint !== fingerprint) throw Error("이 카드의 이전 전송 결과를 수신 세션에서 먼저 확인해 주세요.");
      }
    }
    messageId = earlier?.messageId ?? messageId;
    const receipt: Receipt = { ok: true, recipientId: input.recipientId, messageId };
    const rows = await discoverSessions(paseo);
    const managed = managedSessions(rows, this.store.read());
    const row = managed.find(r => r.id === input.sessionId && r.projectId === input.projectId);
    const destination = managed.find(r => r.id === input.recipientId) ??
      (isManagedCoordinator(scope, input.recipientId) ? rows.find(r => r.id === input.recipientId) : undefined);
    if (!row || !destination) throw Error(changed);
    if (earlier) {
      if (earlier.fingerprint !== fingerprint) throw Error("같은 전송 키로 다른 답을 보낼 수 없습니다.");
      if (earlier.status === "sent") {
        if (requestId !== messageId && !scope.decisionReceipts[requestId]) {
          this.store.change(current => { current.decisionReceipts[requestId] = { ...current.decisionReceipts[messageId], messageId }; });
        }
        return receipt;
      }
      // A worker can restart after Orca took the message but before the receipt was saved.
      const outcome = await this.fleet.reconcile(messageId);
      const latestScope = this.store.read();
      requireScope(latestScope, input);
      if (!isCurrentMembership(row, latestScope) || (!isCurrentMembership(destination, latestScope) && !isManagedCoordinator(latestScope, destination.id))) throw Error(changed);
      if (outcome?.status === "delivered") {
        this.finish(input, messageId, requestId);
        return receipt;
      }
      if (outcome) throw Error("이전 전송 결과를 확인하지 못했습니다. 수신 세션에서 확인해 주세요.");
      // Never attempted, so nothing went out: the pending receipt is dropped and the card is sent as new.
      const stale = messageId;
      this.store.change(current => { delete current.decisionReceipts[stale]; });
    }

    if (row.nativePending || row.status !== "idle") throw Error(blocked);
    requireScope(this.store.read(), input);
    const evidence = await this.reader.read(paseo, row, true);
    if (!evidence) throw Error(changed);
    const latest = await Promise.all([...new Set([input.sessionId, input.recipientId])].map(async id => ({
      id, agent: (await paseo.agents.ref(id).refresh())?.agent,
    })));
    for (const { id, agent } of latest) {
      if (!agent || agent.id !== id || agent.internal || agent.archivedAt || !canReceiveBoardInput(agent, false)) throw Error(blocked);
      if (id === input.sessionId && row.activityAt !== agent.updatedAt) throw Error(changed);
    }
    const recipientAt = Date.parse(latest.find(l => l.id === input.recipientId)!.agent!.updatedAt);
    const note = this.notes.visible(new Set([row.id]))[row.id];
    let text = "";
    this.store.change(current => {
      requireScope(current, input);
      if (!isCurrentMembership(row, current) || (!isCurrentMembership(destination, current) && !isManagedCoordinator(current, destination.id))) throw Error(changed);
      const judgment = current.judgments[row.id];
      Object.assign(row, classify(evidence, row, judgment?.projectId === row.projectId ? judgment : undefined, row.id === current.coordinator), { evidenceId: evidence.id });
      decorateDecision(row, note, current, evidence, this.escalation(row.id));
      restoreClarifiedDecision(row, note, current, evidence);
      if (!row.decision || row.decision.source === "permission" || row.decision.version !== input.version) throw Error(changed);
      text = sessionReplyMessage(row, input);
      if (input.images?.length) this.sessionPhotos.save(input.recipientId, messageId, input.images);
      current.decisionReceipts[messageId] = {
        ...(input.images?.length ? {messageId} : {}),
        messageHash: hash(text),
        activity: { origin: { sessionId: row.id, cardId: row.id, revision: input.version, questions: [{ id: input.version }] },
          title: row.decision.question || row.title, at: new Date().toISOString(), projectId: input.projectId,
          ...(input.images?.length ? {imageCount:input.images.length} : {}),
          answer: input.text, recipientId: input.recipientId, coordinator: input.action === "coordinate" },
        fingerprint, sessionId: row.id, version: input.version, evidenceId: evidence.id, status: "pending", beforeAnswer: current.answers[row.id]?.version, ...(note?.kind === "question" ? { noteRevision: note.revision } : {}),
      };
    });
    let outcome;
    try {
      const photos = input.images?.length ? photoFiles(this.photoDirectory, input.recipientId, messageId, input.images) : [];
      outcome = await this.fleet.deliver({ messageId, to: input.recipientId as SessionId, text, subject: row.title,
        from: { kind: "person" }, whenWorking: "refuse", unchangedSince: recipientAt, photos });
    } catch {
      throw Error(uncertain);
    }
    if (outcome.status === "refused") {
      this.store.change(current => { delete current.decisionReceipts[messageId]; });
      throw Error(outcome.reason === "changed" || outcome.reason === "gone" ? changed : blocked);
    }
    if (outcome.status === "unconfirmed") throw Error(uncertain);
    this.finish(input, messageId);
    return receipt;
  }

  private finish(input: DecisionInput, messageId: string, requestId = messageId) {
    this.store.change(current => {
      const delivery = current.decisionReceipts[messageId];
      delivery.status = "sent";
      if (requestId !== messageId) current.decisionReceipts[requestId] = { ...delivery, messageId };
      if (input.action === "reply" && current.projects.includes(input.projectId) && current.answers[input.sessionId]?.version === delivery.beforeAnswer) {
        current.answers[input.sessionId] = { version: input.version, noteRevision: delivery.noteRevision };
      }
    });
  }
}
