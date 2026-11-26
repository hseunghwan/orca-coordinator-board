/** @jsxImportSource react */
// Paseo's DecisionActions (client/decision-actions.tsx): the session decision card with its reply composer.
// Photos arrive in phase 6, so the composer has no attach control. The recommendation and coordination
// controls appear only once the board has a coordinator (phase 3).
import { useRef, useState, type ReactNode } from "react";
import { sessionReplyDraft } from "../paseo/client/decision-reply-state";
import { decisionSummary } from "../paseo/client/decision-summary";
import type { Card } from "../paseo/client/model";
import { sendDecision, type DecisionInput } from "../paseo/shared/decision-actions";
import { requestRecommendation } from "../paseo/shared/recommendation";
import type { OpenSession } from "./board-layout";
import { useDecisionInteraction } from "./decision-editing";
import { DecisionReplyInput } from "./decision-reply";
import { noRetry, retryKey } from "./request-key";
import { call } from "./rpc";
import { SendButton } from "./send-input";
import { Button, column, Disclose, ProjectText, row, SessionChip } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";
import { Markdown } from "./ui/markdown";

type Action = DecisionInput["action"];
type CoordinationDraft = { text: string; recipientId: string };
export type DecisionReceipt = { projectId: string; sessionId: string; version: string; source: string; project: string; recipient: string | null; recipientId: string; action: Action; answer?: string };
const wrap = { ...row, gap: 6 };
const korean = { reply: "답장", question: "질문", coordinate: "조율 요청" };
const english = { reply: "reply", question: "question", coordinate: "coordination request" };

export function ReceiptText({ receipt }: { receipt: DecisionReceipt }) {
  const { t } = useBoardLanguage();
  const name = receipt.recipient || t("코디네이터 세션", "coordinator session");
  const kind = receipt.action;
  return <p role="status" className="ok">
    {receipt.project} · {receipt.source} · {t(`${name}에 ${korean[kind]}을 보냈습니다.`, `Sent a ${english[kind]} to ${name}.`)}
  </p>;
}

export function DecisionActions({ card, hostLabel, coordinator, coordinatorTitle, open, onSent, receipt, clarification, priorityLabel, embedded = false }: {
  card: Card; hostLabel?: string; coordinator: string | null; coordinatorTitle?: string; open?: OpenSession;
  onSent: (result: DecisionReceipt) => void; receipt?: DecisionReceipt; clarification?: ReactNode; priorityLabel?: string; embedded?: boolean;
}) {
  const { t, language } = useBoardLanguage();
  const { session } = card;
  const decision = session.decision;
  const [showMethods, setShowMethods] = useState(false);
  const [reviewedReply, setReviewedReply] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [requestedFrom, setRequestedFrom] = useState<string | null>(null);
  const recommendationKey = useRef({ recipient: "", key: "" });
  const [selection, setSelection] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [coordination, setCoordination] = useState<CoordinationDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<[string, string] | null>(null);
  const pending = useRef(false);
  const retry = useRef(noRetry);
  const delivered = useRef("");
  const chosen = selection === null ? null : decision?.options?.[selection];
  const proposed = chosen?.reply || (decision?.needsInput ? undefined : decision?.recommendation);
  const reply = sessionReplyDraft(proposed, draft, reviewedReply, false);
  const sendReply = { disabled: busy || !reply.canSend, onPress: () => void submit("reply", reply.text, session.id) };
  const inputFocus = useDecisionInteraction(!!coordination || (draft !== null && draft !== (proposed ?? "")) ||
    selection !== null || !!reviewedReply || busy);
  const { headline, formal, evidence } = decisionSummary(card, t);
  const marker = [session.projectTitle, session.title, hostLabel && t(`실행 호스트 · ${hostLabel}`, `Host · ${hostLabel}`), session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`)].filter(Boolean).join(" · ");
  const named = (label: string) => ({ label, accessibilityLabel: `${session.title} · ${label}` });

  function selectReply(index: number | null) {
    setSelection(index); setDraft(null); setReviewedReply(null); setShowMethods(false); setError(null);
  }
  async function submit(action: Action, text: string, recipientId: string) {
    if (!decision || formal || !text.trim() || pending.current) return;
    if (recipientId !== (action === "coordinate" ? coordinator : session.id)) {
      setError(["받는 세션이 바뀌었습니다. 대상을 다시 선택해 주세요.", "The recipient changed. Choose the recipient again."]); return;
    }
    const input = { projectId: session.projectId, sessionId: session.id, version: decision.version, action, recipientId, text };
    const payload = JSON.stringify([input, []]);
    if (delivered.current === payload) { setError(["이 카드에서 같은 내용을 이미 보냈습니다.", "You already sent this message from this card."]); return; }
    retry.current = retryKey(retry.current, payload, "decision");
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await call(sendDecision, { ...input, requestKey: retry.current.key });
      if (!result.ok || result.recipientId !== recipientId) {
        setError(["영수증의 수신자를 확인할 수 없습니다. 원래 세션을 확인해 주세요.", "The receipt does not confirm the recipient. Check the original session."]); return;
      }
      delivered.current = payload; setCoordination(null);
      if (action === "reply") setDraft("");
      onSent({ projectId: session.projectId, sessionId: session.id, version: decision.version, recipientId: result.recipientId,
        project: session.projectTitle, source: session.title, recipient: action === "coordinate" ? coordinatorTitle || recipientId : session.title, action, answer: text.trim() || undefined });
    } catch {
      setError(["전송을 확인하지 못했습니다. 최신 카드와 받는 세션을 확인한 뒤 다시 시도해 주세요.",
        "Delivery was not confirmed. Check the latest card and recipient before retrying."]);
    } finally { pending.current = false; setBusy(false); }
  }
  async function requestAdvice() {
    if (!decision || formal || !coordinator || decision.recommendation || decision.needsInput || pending.current || requestedFrom === coordinator) return;
    if (recommendationKey.current.recipient !== coordinator) {
      recommendationKey.current = { recipient: coordinator, key: retryKey(noRetry, coordinator, "advice").key };
    }
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await call(requestRecommendation, { projectId: session.projectId, sessionId: session.id,
        version: decision.version, coordinator, language, requestKey: recommendationKey.current.key });
      if (!result.ok || result.recipientId !== coordinator) throw Error();
      setRequestedFrom(coordinator);
    } catch {
      setError(["추천 요청을 확인하지 못했습니다. 최신 카드와 코디네이터를 확인해 주세요.",
        "Could not confirm the recommendation request. Check the current card and coordinator."]);
    } finally { pending.current = false; setBusy(false); }
  }

  const targetChanged = !!coordination && coordination.recipientId !== coordinator;
  const sendCoordination = {
    disabled: busy || targetChanged || !coordination?.text.trim(),
    onPress: () => { if (coordination) void submit("coordinate", coordination.text, coordination.recipientId); },
  };
  const canCoordinate = !!coordinator && coordinator !== session.id;
  const canRestore = !!decision?.recommendation && !decision.needsInput && (selection !== null || draft !== null);
  const sourceExcerpts = evidence.filter(text => text !== headline);
  const hasEvidence = !!decision?.recommendationReason || sourceExcerpts.length > 0;
  const adviceSent = !!coordinator && requestedFrom === coordinator;
  const disclose = (label: string, expanded: boolean, onPress: () => void) =>
    <Disclose label={label} accessibilityLabel={named(label).accessibilityLabel} expanded={expanded} onPress={onPress} />;
  return <div style={{ ...column, gap: 7, ...(embedded && { paddingTop: 10, borderTop: "1px solid var(--border)" }) }}>
    <Markdown source={headline} heading />
    <div style={wrap}>
      <ProjectText projectId={session.projectId} projects={[session.projectTitle]} className="muted sm">{[marker, priorityLabel].filter(Boolean).join(" · ")}</ProjectText>
      {open && <SessionChip label={t("담당 세션", "Assigned session")} accessibilityLabel={named(t("담당 세션 열기", "Open assigned session")).accessibilityLabel} onPress={() => open(session.id)} />}
    </div>
    {formal || !decision ? formal && <p className="muted">
      {t("승인 요청은 담당 세션에서 확인해 주세요.", "Review the approval request in the assigned session.")}
    </p> : <>
      {!coordination && <>
        {!proposed && !!decision.needsInput && decision.needsInput !== headline && <Markdown source={decision.needsInput} />}
        {!!decision.options?.length && <div style={wrap}>{decision.options.map((option, index) =>
          <Button key={index} label={option.label} selected={selection === index}
            accessibilityLabel={named(t("선택", "Choose") + " · " + option.label).accessibilityLabel} disabled={busy}
            onPress={() => selectReply(index)} />)}</div>}
        <DecisionReplyInput {...inputFocus} send={sendReply} value={reply.text} onChangeText={setDraft}
          accessibilityLabel={named(t("답장 내용", "Reply text")).accessibilityLabel}
          placeholder={t("담당 세션에 보낼 답을 입력하세요", "Write a reply to the assigned session")}
          maxLength={24000} disabled={busy} reviewRequired={reply.needsReview} onReview={() => setReviewedReply(proposed ?? null)} />
        <div style={wrap}>
          <SendButton {...named(t("담당 세션에 답장 보내기", "Send reply to assigned session"))} send={sendReply} selected={!sendReply.disabled} />
          {clarification}
        </div>
        {((!proposed && !decision.needsInput && coordinator) || canRestore || canCoordinate) && <div style={wrap}>
          {!proposed && !decision.needsInput && coordinator && (adviceSent
            ? <p role="status" className="ok">{t("추천 요청됨 · 코디네이터 답변 대기", "Recommendation requested · Awaiting coordinator")}</p>
            : <Button {...named(t("코디네이터에 추천 요청", "Ask coordinator for a recommendation"))} disabled={busy} onPress={() => void requestAdvice()} />)}
          {(canRestore || canCoordinate) && disclose(showMethods ? t("다른 방법 접기", "Hide alternatives") : t("다른 방법", "Other actions"), showMethods, () => setShowMethods(v => !v))}
        </div>}
        {showMethods && <div style={wrap}>
          {canRestore && <Button {...named(t("추천 답장으로 돌아가기", "Restore suggested reply"))} disabled={busy} onPress={() => selectReply(null)} />}
          {canCoordinate && <Button {...named(t("코디네이터에 조율 요청", "Ask coordinator to coordinate"))} disabled={busy}
            onPress={() => { setError(null); setCoordination({ recipientId: coordinator, text: "" }); }} />}
        </div>}
      </>}
      {coordination && <div style={{ ...column, gap: 7 }}>
        <p className="muted">{t("받는 곳", "Recipient")} · {targetChanged ? coordination.recipientId : coordinatorTitle || coordinator}</p>
        {targetChanged && <p className="warn">{t("코디네이터가 교체되었습니다. 취소하고 새 수신자를 확인해 주세요.", "The coordinator changed. Cancel and check the new recipient.")}</p>}
        <DecisionReplyInput {...inputFocus} send={sendCoordination} accessibilityLabel={named(t("조율 요청 내용", "Coordination request text")).accessibilityLabel}
          placeholder={t("조율 요청 내용을 입력하세요", "Write your coordination request")} value={coordination.text}
          disabled={busy || targetChanged} maxLength={24000} onChangeText={text => setCoordination({ ...coordination, text })} />
        <div style={wrap}>
          <SendButton {...named(busy ? t("전송 중…", "Sending…") : t("코디네이터에 조율 요청 보내기", "Send request to coordinator"))} send={sendCoordination} />
          <Button {...named(t("취소", "Cancel"))} disabled={busy} onPress={() => { setCoordination(null); setError(null); }} />
        </div>
      </div>}
    </>}
    {(formal || !decision || coordination) && clarification && <div style={wrap}>{clarification}</div>}
    {hasEvidence && <div style={{ ...column, alignItems: "flex-start", gap: 4 }}>
      {disclose(showEvidence ? t("근거 접기", "Hide source") : t("근거 보기", "View source"), showEvidence, () => setShowEvidence(v => !v))}
      {showEvidence && decision?.recommendationReason && <div style={{ ...column, gap: 3 }}>
        <p className="muted sm">{t("추천 이유", "Reason for recommendation")}</p>
        <Markdown source={decision.recommendationReason} />
      </div>}
      {showEvidence && sourceExcerpts.map(text => <Markdown key={text} source={text} muted />)}
    </div>}
    {receipt && <ReceiptText receipt={receipt} />}
    {!!error && <p role="status" className="danger" style={{ overflowWrap: "anywhere" }}>{t(...error)}</p>}
  </div>;
}
