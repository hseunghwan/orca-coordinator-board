// The sidebar's cards: the dashboard's decision rows (board-model) in Focus order, each reduced to what one
// card shows and how it is answered, so the panel draws the same first decision without the snapshot.
import type { FocusCard, FocusDeck } from "./contract";
import { boardModel, type BoardModel } from "./dashboard/board-model";
import { priorityLabel, type RankedDecision } from "./paseo/client/decision-priority";
import { decisionRowSummary } from "./paseo/client/decision-row";
import { decisionSummary } from "./paseo/client/decision-summary";
import type { Card, Snapshot } from "./paseo/client/model";
import type { Translate } from "./paseo/view-types";

// Orca's components take at most this much text in one value.
const MAX_TEXT = 16384;
const clip = (text: string) => text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + "…" : text;
const clipped = (text: string | null) => text === null ? null : clip(text);

type SessionPart = Pick<FocusCard, "session" | "headline" | "body" | "recommendation" | "recommendationReason" | "openSessionId" | "answer">;

function sessionPart(card: Card, t: Translate): SessionPart {
  const { session } = card;
  const decision = session.decision;
  const { headline, formal } = decisionSummary(card, t);
  const answer: FocusCard["answer"] = formal ? { kind: "permission" }
    : decision ? {
      kind: "reply", projectId: session.projectId, sessionId: session.id, version: decision.version,
      // DecisionActions offers the recommendation as the reply unless the session asks for an input first.
      suggested: decision.needsInput ? "" : decision.recommendation ?? "",
      options: decision.options ?? [],
    }
    : { kind: "session" };
  return {
    session: session.title, headline,
    body: !formal && decision?.needsInput && decision.needsInput !== headline ? decision.needsInput : null,
    recommendation: formal ? null : decision?.recommendation ?? null,
    recommendationReason: formal ? null : decision?.recommendationReason ?? null,
    openSessionId: session.id, answer,
  };
}

const joined = (lines: readonly string[]) => lines.join("\n\n") || null;

function rowPart(row: RankedDecision, model: BoardModel, snapshot: Snapshot, t: Translate): SessionPart {
  if (row.kind === "session") return sessionPart(row.card, t);
  if (row.kind === "pull") {
    const { pr } = row;
    return { session: null, headline: pr.title, body: `[${pr.repo} #${pr.number}](${pr.url})`, recommendation: null, recommendationReason: null, openSessionId: null, answer: { kind: "board" } };
  }
  const { item } = row;
  // The board embeds the session decision a record covers, and its reply goes to that session.
  const native = model.human.find(card => card.session.id === item.matchedSessionId);
  const own = { headline: item.title, body: joined(item.ask), recommendation: joined(item.recommend), recommendationReason: joined(item.why) };
  if (native) {
    const part = sessionPart(native, t);
    return { ...part, ...own, recommendation: own.recommendation ?? part.recommendation, recommendationReason: own.recommendation ? own.recommendationReason : part.recommendationReason };
  }
  // Orca has no peer hosts, so a record bound to another host's session gets no link.
  const linked = item.sessionHost ? undefined : snapshot.sessions.find(session => session.id === (item.matchedSessionId || item.sessionId));
  return { ...own, session: linked?.title ?? null, openSessionId: linked?.id ?? null, answer: { kind: "board" } };
}

export function focusCards(snapshot: Snapshot, t: Translate, now = Date.now()): FocusDeck {
  const model = boardModel(snapshot, [], t, now);
  const cards = model.ranked.map((row): FocusCard => {
    const summary = decisionRowSummary(row, t);
    const card = {
      key: row.key, tone: summary.tone, priority: priorityLabel(row, t, now),
      projects: [...new Set(summary.projectIds.map(model.projectName))].join(", "),
    };
    const part = rowPart(row, model, snapshot, t);
    return { ...card, ...part, headline: clip(part.headline), body: clipped(part.body), recommendation: clipped(part.recommendation), recommendationReason: clipped(part.recommendationReason) };
  });
  return { configured: model.configured, incomplete: model.incomplete, cards };
}
