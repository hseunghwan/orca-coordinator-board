/** @jsxImportSource react */
// Paseo's Clarification (client/clarification.tsx): ask a question before deciding, and the thread of
// earlier questions. Photos arrive in phase 6, so a question is text only.
import { useEffect, useRef, useState } from "react";
import { askClarification, clarificationKey, type ClarificationCard, type ClarificationEntry } from "../paseo/shared/clarifications";
import type { TrackedDecision } from "../paseo/shared/tracked-decisions";
import { useDecisionInteraction } from "./decision-editing";
import { noRetry, retryKey } from "./request-key";
import { call } from "./rpc";
import { SendButton, SendTextInput } from "./send-input";
import { Button, column } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";
import { Markdown } from "./ui/markdown";

type Props = {
  card: ClarificationCard | null; title: string; recipientId: string | null; recipientTitle?: string;
  entries: readonly ClarificationEntry[]; prior?: TrackedDecision["qa"]; onRefresh: () => void; onDraftChange?: (active: boolean) => void;
};

export function Clarification({ card, title, recipientId, recipientTitle, entries, prior = [], onRefresh, onDraftChange }: Props) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  const [draftTarget, setDraftTarget] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [sent, setSent] = useState<ClarificationEntry[]>([]);
  const [visibleCount, setVisibleCount] = useState(3);
  const sending = useRef(false);
  const retry = useRef(noRetry);
  const label = (ko: string, en: string) => title + " · " + t(ko, en);
  const key = card ? clarificationKey(card) : "";
  const saved = entries.filter(entry => entry.cardKey === key);
  const history = [...saved, ...sent.filter(entry => !saved.some(row => row.messageId === entry.messageId))].sort((a, b) => a.at.localeCompare(b.at));
  const hidden = Math.max(0, prior.length + history.length - visibleCount);
  const hasDraft = !!text.trim();
  const editing = hasDraft || busy;
  const focus = useDecisionInteraction(expanded || editing);
  useEffect(() => { onDraftChange?.(editing); }, [editing, onDraftChange]);
  // The thread stays on the card, while each new question binds the card revision and recipient it was written for.
  const target = JSON.stringify([card, recipientId]);
  const changed = draftTarget !== target;
  const sendQuestion = { disabled: busy || changed || !hasDraft, onPress: () => void submit() };
  function toggle() {
    if (sending.current) return;
    if (!expanded && !hasDraft) setDraftTarget(target);
    setExpanded(!expanded);
  }
  async function submit() {
    if (!card || !recipientId || changed || sending.current) return;
    const question = text.trim();
    if (!question) return;
    retry.current = retryKey(retry.current, JSON.stringify([target, question, []]), "ask");
    sending.current = true; setBusy(true); setError(false);
    try {
      const result = await call(askClarification, { card, recipientId, question, requestKey: retry.current.key });
      if (!result.ok || result.recipientId !== recipientId) throw Error("unconfirmed");
      setSent(previous => [...previous, { cardKey: key, messageId: result.messageId, recipientId, question, at: new Date().toISOString(), status: "sent" }]);
      retry.current = noRetry; setText(""); setExpanded(false);
    } catch { setError(true); }
    finally { sending.current = false; setBusy(false); onRefresh(); }
  }
  return <>
    <Button label={t("질문하기", "Ask a question")} accessibilityLabel={label("질문하기", "Ask a question")}
      expanded={expanded} disabled={busy} onPress={toggle} />
    {expanded && <div style={{ ...column, width: "100%", gap: 6 }}>
      {!card || !recipientId ? <p className="muted">{t("질문을 보낼 세션을 확인할 수 없습니다.", "No verified session is available for this question.")}</p> : <>
        <p className="muted sm">{t("질문 받을 세션", "Question recipient")} · {recipientTitle || recipientId}</p>
        {changed && <div><Button label={t("바뀐 질문과 수신자 확인", "Confirm updated question and recipient")}
          onPress={() => { setDraftTarget(target); setError(false); }} /></div>}
        <SendTextInput send={sendQuestion} maxLength={4000} disabled={busy || changed} {...focus}
          aria-label={label("질문 내용", "Question text")} value={text} onChange={event => setText(event.target.value)}
          placeholder={t("결정하기 전에 궁금한 점을 적어 주세요", "What would you like to ask before deciding?")} style={{ minHeight: 48 }} />
        {error && <p role="status" className="warn">{t("질문 전송을 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요.", "Question delivery is unconfirmed. Retry with the same question.")}</p>}
        <div><SendButton label={t("질문 보내기", "Send question")} accessibilityLabel={label("질문 보내기", "Send question")} send={sendQuestion} selected /></div>
      </>}
    </div>}
    {(history.length > 0 || prior.length > 0) && <div className="thread">
      <span role="heading" aria-level={4} style={{ fontWeight: 600 }}>{t("문답", "Questions and answers")}</span>
      {hidden > 0 && <div><Button size="sm" label={t(`이전 문답 더 보기 · ${hidden}건`, `Show earlier questions · ${hidden}`)} onPress={() => setVisibleCount(count => count + 5)} /></div>}
      {prior.slice(hidden).map((entry, index) => <div key={index + hidden} style={{ ...column, gap: 2 }}>
        <Markdown source={"Q. " + entry.q} />
        {entry.a ? <Markdown source={"A. " + entry.a} /> : <p className="muted">{t("답변 대기", "Awaiting reply")}</p>}
      </div>)}
      {history.slice(Math.max(0, hidden - prior.length)).map(entry => <div key={entry.messageId} style={{ ...column, gap: 2 }}>
        {!!entry.question && <Markdown source={"Q. " + entry.question} />}
        {!!entry.imageCount && <p className="muted sm">{t(`질문에 첨부한 사진 ${entry.imageCount}장`, `${entry.imageCount} photo(s) attached to question`)}</p>}
        {entry.response ? <Markdown source={"A. " + entry.response} />
          : <p role="status" className="muted">{entry.status === "pending" ? t("전송 확인 중", "Confirming delivery") : t("답변 대기", "Awaiting reply")}</p>}
      </div>)}
    </div>}
  </>;
}
