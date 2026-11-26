/** @jsxImportSource react */
// Paseo's TrackedDecisionCard (client/tracked-decisions.tsx): a ledger record with its questions, reply,
// queued reply, evidence and result.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { cancelQueuedReply, mentionsSecurityGate, resolveTrackedDecision, suggestedTrackedReply, trackedAnswerText, trackedPullTarget, usesSourceCoordinator, type TrackedDecision } from "../paseo/shared/tracked-decisions";
import { useDecisionInteraction } from "./decision-editing";
import { DecisionReplyInput } from "./decision-reply";
import { PhotoComposer, usePhotoDraft } from "./photo-composer";
import { TrackedPullStatus } from "./pull-requests";
import { call } from "./rpc";
import { SendButton } from "./send-input";
import { TrackedSessionChips, type TrackedSessionLinks } from "./tracked-session-chips";
import { Button, column, Disclose, ProjectText, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";
import { Markdown } from "./ui/markdown";

export type Resolution = z.output<typeof resolveTrackedDecision.output>["status"];
export type ResolutionMode = "send" | "save" | "review";
type Props = {
  item: TrackedDecision; priorityLabel?: string; recipientId?: string | null; links: TrackedSessionLinks; children?: ReactNode; pull?: ReactNode;
  renderClarification?: (onDraftChange: (active: boolean) => void) => ReactNode;
  onResolved: (result: Resolution, mode?: ResolutionMode, answer?: string) => Promise<void> | void;
};
const kinds = {
  check: ["확인", "Check"], answer: ["질문", "Question"], merge: ["병합 검토", "Merge review"],
  approve: ["승인 검토", "Approval review"], cleanup: ["정리", "Follow-up"], other: ["결정", "Decision"],
} as const;
const messages = {
  sent: ["답을 전송하고 기록을 닫았습니다.", "Reply sent and record closed."],
  queued: ["자동 전송 대기 중", "Queued for automatic delivery"],
  busy: ["받는 세션이 작업 중이거나 권한 확인을 기다립니다. 대기 상태가 되면 보낼 수 있습니다.", "The recipient is busy or waiting for permission. Send when it is idle."],
  unconfirmed: ["전송 결과를 아직 확인할 수 없습니다. 같은 답으로 다시 누르면 수신 내역을 확인합니다.", "Delivery is unconfirmed. Retry the same answer to check the recipient’s history."],
  closed: ["결정 기록을 닫았습니다.", "Decision record closed."],
  "already-closed": ["이미 닫힌 결정 기록입니다.", "This decision record was already closed."],
  changed: ["기록 내용이 바뀌었습니다. 새로 고친 내용을 확인해 주세요.", "The record changed. Review its latest details."],
  "out-of-scope": ["현재 보드의 관리 대상에서 제외된 기록입니다.", "This record is outside the board’s current scope."],
  unavailable: ["기록 상태를 확인할 수 없습니다. 보드를 새로 고쳐 주세요.", "Could not confirm the record’s status. Refresh the board."],
} as const;
const wrap = { ...row, gap: 6 };

function Lines({ title, lines }: { title: string; lines: readonly string[] }) {
  if (!lines.length) return null;
  return <div style={{ ...column, gap: 3 }}>
    <p className="muted sm" style={{ fontWeight: 600 }}>{title}</p>
    {lines.map((line, index) => <Markdown key={index} source={line} />)}
  </div>;
}

export function TrackedDecisionCard(props: Props) {
  return <DecisionRecord key={JSON.stringify([props.item.key, props.item.fingerprint])} {...props} />;
}

function DecisionRecord({ item, links, recipientId, onResolved, children, pull, renderClarification, priorityLabel }: Props) {
  const { t } = useBoardLanguage();
  const queue = item.queuedReply;
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmedOwner, setConfirmedOwner] = useState(item.sourceCoordinatorId);
  const [skipped, setSkipped] = useState<Record<number, boolean>>({});
  const [editedReply, setEditedReply] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<number, string | undefined>>({});
  const [selected, setSelected] = useState<Record<number, number[]>>({});
  const [result, setResult] = useState<Resolution | null>(null);
  useEffect(() => {
    if (queue && result === "queued") setResult(null);
  }, [queue, result]);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasQuestionDraft, setHasQuestionDraft] = useState(false);
  const attachments = usePhotoDraft();
  const pending = useRef(false);
  const [kindKo, kindEn] = kinds[item.kind];
  const isMerge = item.kind === "merge";
  const target = trackedPullTarget(item);
  const headline = isMerge ? undefined : item.ask[0];
  const securityGate = mentionsSecurityGate(item);
  const articleChoice = item.questions.length === 1 && /(?:글|블로그|blog|article)/i.test(item.questions[0].text);
  const followupTitle = articleChoice ? t("글 작성 선택", "Article writing choice") : t("후속 질문", "Follow-up questions");
  const source = item.projectTitle || item.projectId;
  const where = item.where === "human" ? t("직접 처리", "Your action")
    : item.where === "session" ? t("담당 세션", "Assigned session")
    : item.where === "manager" ? t("코디네이터", "Coordinator") : null;
  const named = (label: string) => ({ label, accessibilityLabel: item.title + " · " + label });
  const recordActions = !item.matchedSessionId || !!item.questions.length;
  const isClosed = result === "sent" || result === "closed" || result === "already-closed";
  const needsRefresh = result === "changed" || result === "out-of-scope" || result === "unavailable";
  const suggested = suggestedTrackedReply(item);
  const template = /<[^>]+>/.test(suggested);
  const freeReply = editedReply ?? (template ? "" : suggested);
  const questionText = item.questions.map((question, index) => typed[index] ?? question.options
    .filter((_, choice) => selected[index]?.includes(choice))
    .map(option => option.key + " · " + option.text).join(", "));
  const replies = questionText.map((value, index) => {
    if (skipped[index]) return "";
    const positions = attachments.photos.flatMap((photo, position) => photo.questionIndex === index ? [position + 1] : []);
    return [value.trim(), positions.length ? t("첨부 사진 ", "Attached photos ") + positions.join(", ") : ""].filter(Boolean).join(" · ");
  });
  const outstanding = replies.some((value, index) => !value && !skipped[index]);
  const answer = trackedAnswerText(item, replies, freeReply);
  const followupOnly = isMerge && item.questions.length > 0;
  const owned = usesSourceCoordinator(item);
  const changedOwner = owned && item.sourceCoordinatorId !== confirmedOwner;
  const sendLabel = owned
    ? followupOnly ? t("운영 코디네이터에 후속 답장 보내기", "Send follow-up reply to ledger owner") : t("운영 코디네이터에 답장 보내기", "Send reply to ledger owner")
    : item.where === "session"
    ? followupOnly ? t("담당 세션에 후속 답장 보내기", "Send follow-up reply to assigned session") : t("담당 세션에 답장 보내기", "Send reply to assigned session")
    : followupOnly ? t("코디네이터에 후속 답장 보내기", "Send follow-up reply to coordinator") : t("코디네이터에 답장 보내기", "Send reply to coordinator");
  const hasPhotos = attachments.photos.length > 0;
  const hasAnswer = !!answer || hasPhotos;
  const tooLong = answer.length > 4000;
  const humanCheck = item.kind === "check" && item.where === "human" && !item.questions.length && !item.matchedSessionId;
  // A suggestion is visible before the person edits. Checking a record sends no reply.
  const hasDraft = hasQuestionDraft || hasPhotos || !!editedReply?.trim() || questionText.some(value => !!value.trim());
  const answerDisabled = busy || attachments.blocked || !hasAnswer || outstanding || tooLong;
  const sendReply = { disabled: !recipientId || !recordActions || answerDisabled || changedOwner, onPress: () => void acknowledge("send") };
  const inputFocus = useDecisionInteraction(!queue && !isClosed && !needsRefresh &&
    (hasDraft || editedReply !== null || Object.values(typed).some(value => value !== undefined) ||
      attachments.blocked || busy || confirming || Object.values(skipped).some(Boolean)));
  const checkLabel = t("확인했어요", "I checked this");

  function choose(index: number, choice: number, multi: boolean) {
    setConfirming(false); setSkipped(previous => ({ ...previous, [index]: false }));
    setTyped(previous => ({ ...previous, [index]: undefined }));
    setSelected(previous => {
      const group = previous[index] ?? [];
      const next = multi ? group.includes(choice) ? group.filter(value => value !== choice) : [...group, choice] : [choice];
      return { ...previous, [index]: next };
    });
  }
  function skip(index: number) {
    setConfirming(false); setSkipped(previous => ({ ...previous, [index]: !previous[index] }));
    setSelected(previous => ({ ...previous, [index]: [] }));
    setTyped(previous => ({ ...previous, [index]: undefined }));
  }
  async function refreshRecord() {
    if (pending.current || !result) return;
    pending.current = true; setBusy(true);
    try { await onResolved(result); setRefreshFailed(false); setResult(null); }
    catch { setRefreshFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  async function cancelWaiting() {
    if (!queue || pending.current) return;
    pending.current = true; setBusy(true);
    try {
      const { canceled } = await call(cancelQueuedReply, { source: item.source, id: item.id, projectId: item.projectId, fingerprint: item.fingerprint, messageId: queue.messageId });
      setResult(canceled ? null : "changed");
      await onResolved(canceled ? "queued" : "changed");
    } catch { setRefreshFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  async function acknowledge(mode: ResolutionMode) {
    const send = mode === "send";
    if (send && (!recipientId || changedOwner)) return;
    const text = mode === "review" ? "" : answer;
    if (queue || pending.current || attachments.blocksSubmit() || isClosed || needsRefresh || outstanding || (mode !== "review" && tooLong)) return;
    if (mode === "review" ? hasDraft || attachments.latest.current.length > 0 || item.matchedSessionId : !text && !hasPhotos) return;
    pending.current = true; setBusy(true);
    let status: Resolution;
    try {
      const images = attachments.latest.current.map(photo => photo.image);
      const response = await call(resolveTrackedDecision, { source: item.source, projectId: item.projectId, id: item.id, fingerprint: item.fingerprint,
        ...(text ? { answer: text } : {}), ...(images.length ? { images } : {}),
        ...(item.questions.length ? { questionIndexes: replies.flatMap((reply, index) => reply ? [index] : []) } : {}),
        ...(send && recipientId ? { recipientId } : {}) });
      status = response.status;
      if (status === "sent" || status === "closed" || status === "already-closed") attachments.clear();
    } catch { status = send ? "unconfirmed" : "unavailable"; }
    setResult(status); setConfirming(false);
    try { await onResolved(status, mode, text.trim() || undefined); } catch { setRefreshFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }

  return <div style={{ ...column, gap: 7 }}>
    <div style={wrap}>
      <ProjectText projectId={item.projectId ?? undefined} projects={item.projectId && source ? [source] : []} className="muted sm">
        {[source || t("보드 공통", "Board-wide"), t(kindKo, kindEn), where, item.owner, priorityLabel].filter(Boolean).join(" · ")}
      </ProjectText>
      <TrackedSessionChips title={item.title} links={links} />
    </div>
    <Markdown source={isMerge ? t("PR 병합", "PR merge") : item.title} heading />
    {!!headline && headline !== item.title && <Markdown source={headline} />}
    {isMerge && (pull || (target
      ? <TrackedPullStatus repo={target.repo} number={target.number} projectId={item.projectId} securityGate={securityGate} />
      : <p className="muted">{t("PR 링크와 병합 상태 미확인", "Pull request link and merge status unavailable")}</p>))}
    {children}
    {!isMerge && <Lines title={t("추천", "Recommendation")} lines={item.recommend.filter(line => line !== headline && line !== item.howToAnswer)} />}
    {queue && <div className="thread">
      <p role="status" className={queue.stopped ? "warn" : undefined} style={{ fontWeight: 600 }}>
        {queue.stopped ? t("자동 전송 중단 · 카드와 수신 세션을 확인해 주세요.", "Delivery paused. Check the card and its recipient.")
          : t("전송 대기 · 세션이 준비되면 자동으로 보냅니다.", "Queued · sends automatically when the session is ready.")}
      </p>
      {!!queue.answer && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{queue.answer}</p>}
      {!!queue.imageCount && <p className="muted">{t("첨부 사진 " + queue.imageCount + "장", "Attached photos · " + queue.imageCount)}</p>}
      <div style={wrap}><Button size="sm" {...named(t("전송 대기 취소", "Cancel queued reply"))} disabled={busy} onPress={() => void cancelWaiting()} /></div>
    </div>}
    {!queue && !isClosed && !needsRefresh && <div style={{ ...column, gap: 8 }}>
      {isMerge && !!item.questions.length && <span role="heading" aria-level={4} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, fontSize: 16, fontWeight: 600 }}>{followupTitle}</span>}
      {item.questions.map((question, index) => <div key={index} role="group" aria-label={question.text} style={{ ...column, gap: 6 }}>
        <Markdown source={question.text} heading />
        {!!question.options.length && <p className="muted sm">{question.multi ? t("여러 개 선택", "Choose any that apply") : t("하나 선택", "Choose one")}</p>}
        <div role={question.multi ? undefined : "radiogroup"} style={{ ...column, gap: 6 }}>
          {question.options.map((option, choice) => {
            const checked = selected[index]?.includes(choice) ?? false;
            const title = option.key + " · " + option.text;
            return <button key={choice} type="button" className="option" role={question.multi ? "checkbox" : "radio"} aria-checked={checked}
              aria-label={item.title + " · " + question.text + " · " + title} disabled={busy} onClick={() => choose(index, choice, question.multi)}>
              <span style={{ fontWeight: checked ? 700 : 500 }}>{checked ? "✓ " : ""}{title}{option.recommended ? " · " + t("추천", "Recommended") : ""}</span>
              {expanded && !!option.note && <span className="muted">{option.note}</span>}
              {expanded && ([[t("고르면", "Outcome"), option.does], [t("장점", "Benefits"), option.pros], [t("대가", "Trade-offs"), option.cons]] as const)
                .map(([label, text]) => text ? <span key={label} className="muted sm">{label} · {text}</span> : null)}
            </button>;
          })}
        </div>
        {!skipped[index] && <PhotoComposer draft={attachments} disabled={busy} questionIndex={index}>
          <DecisionReplyInput {...inputFocus} send={sendReply} value={questionText[index]} disabled={busy} maxLength={4000}
            accessibilityLabel={item.title + " · " + question.text + " · " + t("답장 내용", "Reply text")}
            onChangeText={text => { setConfirming(false); setTyped(previous => ({ ...previous, [index]: text })); setSelected(previous => ({ ...previous, [index]: [] })); }}
            placeholder={question.options.length ? t("선택하거나 직접 답을 입력하세요", "Choose an option or write your reply") : t("내 답을 입력하세요", "Write your reply")} />
        </PhotoComposer>}
        <div style={wrap}><Button size="sm" label={skipped[index] ? t("건너뛰기 취소", "Undo skip") : t("이 질문 건너뛰기", "Skip this question")}
          accessibilityLabel={item.title + " · " + question.text + " · " + t("건너뛰기", "Skip")} selected={!!skipped[index]}
          disabled={busy || attachments.reading || attachments.errors.has(index) || attachments.photos.some(photo => photo.questionIndex === index)}
          onPress={() => skip(index)} /></div>
      </div>)}
      {!item.questions.length && !item.matchedSessionId && <>
        <PhotoComposer draft={attachments} disabled={busy}>
          <DecisionReplyInput {...inputFocus} send={sendReply} accessibilityLabel={item.title + " · " + t("답장 내용", "Reply text")}
            value={freeReply} disabled={busy} maxLength={4000} onChangeText={value => { setEditedReply(value); setConfirming(false); }}
            placeholder={t("내 답을 입력하세요", "Write your reply")} />
        </PhotoComposer>
        {template && editedReply === null && <div style={wrap}><Button size="sm" disabled={busy} label={t("답장 양식 불러오기", "Load reply template")}
          onPress={() => { setEditedReply(suggested); setConfirming(false); }} /></div>}
      </>}
      {tooLong && <p className="warn">{t("답을 4,000자 이내로 줄여 주세요.", "Shorten the answer to 4,000 characters.")}</p>}
      <div style={{ ...column, gap: 6 }}>
        {owned && !links.owner && item.sourceCoordinatorId && <p className="muted sm" style={{ overflowWrap: "anywhere" }}>
          {t("원장 소유 세션", "Ledger owner session")} · {item.sourceCoordinatorId}
        </p>}
        {!recipientId && !item.matchedSessionId && <p className="muted sm">
          {owned ? t("이 호스트에서 원장의 운영 코디네이터를 확인할 수 없습니다. 답은 보드에 저장할 수 있습니다.", "The ledger owner could not be verified on this host. You can save your answer on the board.")
            : t("전송할 세션이 확인되지 않아 답을 보드에 기록합니다.", "No verified recipient. You can save your answer on the board.")}
        </p>}
        {changedOwner && recipientId && <div style={wrap}><Button label={t("변경된 운영 코디네이터 확인", "Confirm new ledger owner")}
          onPress={() => setConfirmedOwner(item.sourceCoordinatorId)} /></div>}
        {outstanding && <p className="muted">{t("각 질문에 답하거나 건너뛰기를 선택하세요.", "Answer or explicitly skip each question.")}</p>}
        <div style={wrap}>
          {recipientId && recordActions && <SendButton {...named(sendLabel)} send={sendReply} selected={!sendReply.disabled} />}
          {recordActions && (!recipientId || hasAnswer) && <Button {...named(t("보드에만 저장", "Save on board only"))}
            selected={!recipientId && !answerDisabled} disabled={answerDisabled} onPress={() => void acknowledge("save")} />}
          {humanCheck && !hasDraft && <label className="check">
            <input type="checkbox" aria-label={named(checkLabel).accessibilityLabel} checked={false}
              disabled={busy} onChange={() => void acknowledge("review")} />{checkLabel}
          </label>}
          {renderClarification?.(setHasQuestionDraft)}
        </div>
      </div>
    </div>}
    <div style={{ alignSelf: "flex-start" }}>
      <Disclose label={expanded ? t("근거·이력 접기", "Hide evidence and history") : t("근거·이력 보기", "Evidence and history")}
        accessibilityLabel={named(expanded ? t("결정 상세 접기", "Hide decision details") : t("결정 상세 보기", "View decision details")).accessibilityLabel}
        expanded={expanded} onPress={() => setExpanded(value => !value)} />
    </div>
    {expanded && <div className="thread" style={{ gap: 8 }}>
      {links.owner && item.sourceCoordinatorId && <p className="muted sm" style={{ overflowWrap: "anywhere" }}>
        {t("운영 코디네이터 세션 ID", "Operating coordinator session ID")} · {item.sourceCoordinatorId}
      </p>}
      {!!item.since && <p className="muted sm">{t("기록 시각", "Recorded at")} · {item.since}</p>}
      {isMerge && <>
        <Lines title={t("기록 당시 제목", "Original record title")} lines={[item.title]} />
        <Lines title={t("기록 당시 추천", "Original recommendation")} lines={item.recommend} />
        {item.howToAnswer && <Lines title={t("기록 당시 답장 예시", "Original example reply")} lines={[item.howToAnswer]} />}
      </>}
      <Lines title={isMerge ? t("기록 당시 요청", "Original request") : t("요청한 일", "Requested action")} lines={item.ask.filter(line => line !== headline)} />
      <Lines title={t("진행 단계", "Steps")} lines={item.steps} />
      <Lines title={t("근거", "Evidence")} lines={item.why} />
      <Lines title={t("위험", "Risks")} lines={item.risk} />
      {!renderClarification && !!item.qa.length && <div style={{ ...column, gap: 5 }}>
        <p className="muted sm">{t("이전 문답", "Question history")}</p>
        {item.qa.map((entry, i) => <div key={i} style={{ ...column, gap: 3 }}>
          <p>{[t("질문", "Question"), entry.askedAt, entry.q].filter(Boolean).join(" · ")}</p>
          <p className="muted">{entry.a ? [t("답", "Answer"), entry.answeredAt, entry.a].filter(Boolean).join(" · ") : t("답변 대기", "Awaiting reply")}</p>
        </div>)}
      </div>}
      <Lines title={t("이전 답변", "Previous replies")} lines={item.replyHistory.map(entry => [entry.at, entry.text].filter(Boolean).join(" · "))} />
      {!queue && !isClosed && !needsRefresh && !humanCheck && !item.matchedSessionId && !hasDraft && !outstanding && <div style={wrap}>
        {confirming && <p className="muted">{t("답변 전송 없이 이 보드 기록을 닫습니다.", "Close this board record without sending a reply.")}</p>}
        <Button size="sm" {...named(confirming ? t("기록 닫기 확정", "Confirm closing record") : t("기록 닫기", "Close record"))}
          disabled={busy} onPress={() => confirming ? void acknowledge("review") : setConfirming(true)} />
        {confirming && <Button size="sm" {...named(t("취소", "Cancel"))} disabled={busy} onPress={() => setConfirming(false)} />}
      </div>}
    </div>}
    {result && !(result === "queued" && queue) && <p role="status" className={isClosed ? "ok" : "warn"}>{t(messages[result][0], messages[result][1])}</p>}
    {needsRefresh && <div style={wrap}><Button {...named(t("결정 기록 새로 고침", "Refresh decision record"))}
      disabled={busy} onPress={() => void refreshRecord()} /></div>}
    {refreshFailed && <p role="status" className="warn">{t("최신 목록을 다시 불러오지 못했습니다. 보드를 새로 고쳐 주세요.", "Could not reload the list. Refresh the board.")}</p>}
  </div>;
}
