// Adapted from paseo-coordinator-board server/decisions.ts @ 2e9d128: decorateDecision only, the read side. DecisionSender comes with sending.
import { createHash } from "node:crypto";
import type { Decision } from "../paseo/shared/decision-actions";
import type { Note, SessionRow } from "../paseo/shared/contract";
import { lastConversationQuestion, type Evidence } from "./conversation";
import type { Preferences } from "../paseo/server/preferences";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function decorateDecision(row: SessionRow, note: Note | undefined, prefs: Preferences, evidence?: Evidence) {
  const answer = prefs.answers[row.id];
  const noteQuestion = note?.kind === "question";
  const answeredNote = noteQuestion && answer?.noteRevision === note.revision;
  const dismissed = row.evidenceId && row.evidenceId === note?.evidenceId && note.origin === "person" && note.kind !== "question";
  let content: Omit<Decision, "version">;
  if (row.nativePending) {
    content = { source: "permission", question: row.detail };
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
