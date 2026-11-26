/** @jsxImportSource react */
// Paseo's ReplyHistory and ReplyCard (client/reply-history.tsx). Sessions are local because Orca has no
// peer hosts.
import { useEffect, useState } from "react";
import type { HistoryLinks, HistorySession } from "../paseo/client/history-sessions";
import { mergeNotificationLabel } from "../paseo/client/merge-notification";
import { pullUrl } from "../paseo/shared/prs";
import { readReplyPhoto, type ReplyEntry } from "../paseo/shared/reply-history";
import type { OpenSession } from "./board-layout";
import { call } from "./rpc";
import { Button, column, Disclosure, row, SessionChip, space } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";
import { Markdown } from "./ui/markdown";

type Props = { entry: ReplyEntry; links: HistoryLinks; open?: OpenSession };

function LocalPhoto({ entryKey, index }: { entryKey: string; index: number }) {
  const { t } = useBoardLanguage();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false); setUri(null);
    void call(readReplyPhoto, { key: entryKey, index }).then(({ image }) => {
      if (!current) return;
      if (image) setUri(`data:${image.mimeType};base64,${image.data}`);
      else setFailed(true);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [entryKey, index, attempt]);
  if (failed) return <div style={{ ...column, alignItems: "flex-start", gap: 4 }}>
    <p role="status" className="muted">{t("사진을 불러오지 못했습니다.", "Could not load the photo.")}</p>
    <Button size="sm" label={t("다시 불러오기", "Retry loading")} onPress={() => setAttempt(n => n + 1)} />
  </div>;
  if (!uri) return <p role="status" className="muted">{t("사진 불러오는 중…", "Loading photo…")}</p>;
  return <img src={uri} alt={t(`첨부 사진 ${index + 1}`, `Attached photo ${index + 1}`)} onError={() => setFailed(true)}
    style={{ width: "100%", height: 200, objectFit: "contain", borderRadius: "var(--r-sm)", background: "var(--muted)" }} />;
}

function SessionReference({ session, state, open }: Pick<Props, "open"> & { session: HistorySession; state?: string }) {
  const { t } = useBoardLanguage();
  const role = { source: t("원래 세션", "Source session"), received: t("받은 세션", "Recipient session"), target: t("전송 대상", "Intended recipient") }[session.role];
  const title = session.title || session.id;
  const label = [role, session.hostLabel ?? session.host, title, state].filter(Boolean).join(" · ");
  if (!session.available || session.host || !open) return <span className="muted sm">
    {label}{!session.available && " · " + t("연결 미확인", "Connection unverified")}</span>;
  return <SessionChip label={label} accessibilityLabel={t(role + " 열기 · " + title, "Open " + role + " · " + title)} onPress={() => open(session.id)} />;
}

export function ReplyCard({ entry, links, open }: Props) {
  const { t, language } = useBoardLanguage();
  const [full, setFull] = useState(false);
  const [showOrigin, setShowOrigin] = useState(false);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const origin = entry.origin;
  const long = [entry.answer, entry.response].some(text => text && (text.length > 160 || text.split("\n").length > 3));
  const merge = entry.pullMerge;
  const status = merge
    ? (merge.status === "merged" ? t("보드에서 병합함", "Merged from board") : t("이미 병합됨", "Already merged"))
    : {
      sent: t("전송됨", "Sent"), pending: t("전송 확인 중", "Delivery unconfirmed"),
      unsent: t("전송 중단 · 카드 또는 수신 상태 확인 필요", "Not sent · review the card or recipient"),
      recorded: t("보드에 기록함", "Saved on board"), closed: entry.reviewedBy ? t("코디네이터가 확인함", "Reviewed by coordinator") : t("기록 닫음", "Record closed"),
    }[entry.status];
  const states = { running: t("진행 중", "Running"), idle: t("대기 중", "Idle"), closed: t("대화 종료", "Closed"), error: t("오류", "Error"), unknown: t("미확인", "Unknown") };
  const date = new Date(entry.at).toLocaleString(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const sessions = links(entry);
  return <div style={{ ...column, gap: 5, padding: 9, borderRadius: "var(--r-md)", background: "var(--card)", border: "1px solid var(--border)" }}>
    {merge ? <>
      <p style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{entry.title}</p>
      <Markdown source={`[${merge.repo} #${merge.number}](${pullUrl(merge.repo, merge.number)})`} />
    </> : <Markdown source={entry.title} heading />}
    <p className="muted sm">{[status, mergeNotificationLabel(merge?.notification, t), date, merge?.mergeSha?.slice(0, 12)].filter(Boolean).join(" · ")}</p>
    {!!sessions.length && <div style={{ ...row, gap: 5 }}>{sessions.map(session =>
      <SessionReference key={JSON.stringify([session.role, session.host, session.id])} session={session} state={session.state && states[session.state]} open={open} />)}</div>}
    {!!entry.reviewReason && <Markdown source={entry.reviewReason} />}
    {!!entry.answer && <Markdown source={entry.answer} preview={long && !full} />}
    {!!entry.imageCount && <div style={{ ...column, gap: 4 }}>
      <p className="muted sm">{t(`첨부 사진 ${entry.imageCount}장`, `${entry.imageCount} attached photo${entry.imageCount === 1 ? "" : "s"}`)}</p>
      {entry.localPhotos && <>
        <div style={{ ...row, gap: 5 }}>{Array.from({ length: entry.imageCount }, (_, index) =>
          <Button key={index} size="sm" label={t(`사진 ${index + 1}`, `Photo ${index + 1}`)} expanded={photoIndex === index} selected={photoIndex === index}
            accessibilityLabel={entry.title + " · " + t(`사진 ${index + 1}`, `Photo ${index + 1}`)}
            onPress={() => setPhotoIndex(current => current === index ? null : index)} />)}</div>
        {photoIndex !== null && <LocalPhoto key={entry.key + "/" + photoIndex} entryKey={entry.key} index={photoIndex} />}
      </>}
    </div>}
    {entry.status === "sent" && (entry.response
      ? <div style={{ ...column, gap: 3 }}>
        <p className="muted sm">{t("세션의 후속 응답", "Session follow-up")}</p>
        <Markdown source={entry.response} preview={long && !full} />
      </div>
      : <p className="muted sm">{t("후속 응답 미확인", "No verified follow-up yet")}</p>)}
    {long && <div style={{ alignSelf: "flex-start" }}>
      <Button variant="ghost" size="sm" expanded={full} label={full ? t("접기", "Show less") : t("내용 펼치기", "Read more")} onPress={() => setFull(value => !value)} />
    </div>}
    {origin && <Disclosure expanded={showOrigin} title={t("답변 출처", "Reply source")} onPress={() => setShowOrigin(value => !value)}>
      <p className="muted sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{[
        t("원본 카드", "Source card") + " · " + origin.cardId,
        origin.questions.length ? t("질문", "Question") + " · " + origin.questions.map(q => q.id).join(", ") : "",
        origin.sessionId && t("원래 세션", "Source session") + " · " + [origin.sessionHost, origin.sessionId].filter(Boolean).join(" · "),
        t("기록 버전", "Revision") + " · " + origin.revision,
      ].filter(Boolean).join("\n")}</p>
    </Disclosure>}
  </div>;
}

export function ReplyHistory({ entries, links, open, expanded, onToggle }: Omit<Props, "entry"> & { entries: readonly ReplyEntry[]; expanded: boolean; onToggle: () => void }) {
  const { t } = useBoardLanguage();
  const [limit, setLimit] = useState(1);
  if (!entries.length) return null;
  return <Disclosure expanded={expanded} onPress={onToggle} title={t(`최근 결정 기록 · ${entries.length}건`, `Recent decision activity · ${entries.length}`)}>
    {entries.slice(0, limit).map(entry => <ReplyCard key={entry.key} entry={entry} links={links} open={open} />)}
    {entries.length > limit && <div style={{ alignSelf: "flex-start", paddingTop: space[1] }}>
      <Button variant="ghost" size="sm" label={t("이전 기록 더 보기", "Show earlier activity")} onPress={() => setLimit(n => n + 10)} />
    </div>}
  </Disclosure>;
}
