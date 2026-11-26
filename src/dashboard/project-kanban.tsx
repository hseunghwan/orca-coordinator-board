/** @jsxImportSource react */
// Paseo's per-project kanban (client/project-kanban.tsx).
import { useContext, useMemo, useState, type ReactNode } from "react";
import { COLUMN_GAP, columnWidth } from "../paseo/client/lane-width";
import { classifyProject } from "../paseo/client/matrix";
import { factStatus, laneLabel, noteLabel, sessionDetail, type Card, type Lane } from "../paseo/client/model";
import { plainDecisionTitle } from "../paseo/client/decision-summary";
import type { HistoryLinks } from "../paseo/client/history-sessions";
import type { PullRequestItem } from "../paseo/shared/prs";
import type { ReplyEntry } from "../paseo/shared/reply-history";
import type { TrackedDecision } from "../paseo/shared/tracked-decisions";
import type { OpenSession } from "./board-layout";
import { EditNote } from "./note-editor";
import { ReplyCard } from "./reply-history";
import { TrackedSessionChips, type TrackedSessionLinks } from "./tracked-session-chips";
import { useWidth } from "./use-width";
import { Button, column, ProjectText, row, RunningMark, SessionChip } from "./ui/controls";
import { ChevronDown, ChevronUp } from "./ui/icons";
import { useBoardLanguage } from "./ui/language";
import { Markdown } from "./ui/markdown";

type ColumnKind = Lane | "history";

function accent(lane: ColumnKind) {
  if (lane === "human") return "var(--question)";
  if (lane === "running") return "var(--working)";
  if (lane === "done") return "var(--success)";
  return "var(--muted-fg)";
}

export function CardView({ card, open, sessionHostLabel }: { card: Card; open: OpenSession; sessionHostLabel: string }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useBoardLanguage();
  const edit = useContext(EditNote);
  const { session, note } = card;
  const fact = session.boardFact;
  const question = session.decision?.question;
  const displayedQuestion = session.decision?.source === "permission" && question ? sessionDetail(question, t)
    : session.decision?.questionMarkdown ?? question;
  const detailIsQuestion = !!question && (question === session.detail || session.detail.endsWith(" · " + question));
  const runtime = [session.provider, session.model === session.provider ? null : session.model].filter(Boolean).join(" / ");
  const noteTitle = note && note.kind !== "clear" ? [note.origin === "agent" ? t("세션 보고", "Session report") : null, noteLabel(note.kind, t)].filter(Boolean).join(" · ") : null;
  return <div style={{ ...column, padding: 10, borderRadius: "var(--r-md)", border: "1px solid var(--border)", background: "var(--bg)", gap: 6 }}>
    <button type="button" className="press" style={{ ...column, gap: 3 }} aria-expanded={expanded}
      aria-label={t(`${session.title} · ${expanded ? "상세 접기" : "상세 보기"}`, `${session.title} · ${expanded ? "Hide details" : "View details"}`)}
      onClick={() => setExpanded(value => !value)}>
      <span style={{ ...row, flexWrap: "nowrap", gap: 4, width: "100%" }}>
        {card.lane === "running" && <RunningMark />}
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{session.title}</span>
        <span className="muted" style={{ display: "inline-flex" }}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </span>
      <span className="muted sm ellipsis" style={{ width: "100%" }}>
        {card.lane === "human" ? t("내 답을 기다리는 중", "Waiting for my decision")
          : session.detail ? sessionDetail(session.detail, t) : laneLabel(card.lane, t)}
      </span>
      {!!sessionHostLabel && <span className="muted sm">{t("실행 호스트", "Host")} · {sessionHostLabel}</span>}
    </button>
    <SessionChip label={t("세션", "Session")} accessibilityLabel={t(`세션 열기 · ${session.title}`, `Open session · ${session.title}`)} onPress={() => open(session.id)} />
    {fact && <p className="muted sm">{fact.current ? "" : t("이전 · ", "Previous · ")}{factStatus(fact, t)}</p>}
    {expanded && <>
      {fact && <div style={{ ...column, gap: 3 }}>
        <p>{fact.answer}</p>
        <p className="muted sm">{t("확인 근거", "Source")} · {fact.source}</p>
      </div>}
      <p className="muted sm">{[session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`), session.workspaceTitle, runtime].filter(Boolean).join(" · ")}</p>
      {!!session.detail && !detailIsQuestion && <Markdown source={sessionDetail(session.detail, t)} muted />}
      {!!displayedQuestion && note?.text !== question && <Markdown source={displayedQuestion} />}
      {noteTitle && note && <div style={{ ...column, gap: 3 }}>
        <p className="muted sm">{noteTitle}</p>
        <Markdown source={note.text} />
      </div>}
      {edit && <div><Button size="sm" label={noteTitle ? t("기록 편집", "Edit note") : t("기록 추가", "Add note")}
        accessibilityLabel={t(`기록 편집 · ${session.title}`, `Edit note · ${session.title}`)} onPress={() => edit(session.id)} /></div>}
    </>}
  </div>;
}

type Entry = { key: string; content: ReactNode };

function RecordPreview({ item, render, links }: { item: TrackedDecision; render: (item: TrackedDecision) => ReactNode; links: TrackedSessionLinks }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useBoardLanguage();
  const title = useMemo(() => plainDecisionTitle(item.title), [item.title]);
  return <div style={{ ...column, gap: 4 }}>
    <Button label={expanded ? t("결정 카드 접기", "Hide decision card") : title}
      accessibilityLabel={t(`결정 카드 · ${title}`, `Decision card · ${title}`)} expanded={expanded} onPress={() => setExpanded(v => !v)} />
    {!expanded && (links.owner || links.source) && <div style={{ ...row, gap: 6 }}>
      <TrackedSessionChips title={title} links={links} />
    </div>}
    {expanded && render(item)}
  </div>;
}

function Column({ lane, entries }: { lane: ColumnKind; entries: Entry[] }) {
  const { t } = useBoardLanguage();
  const [limit, setLimit] = useState(4);
  return <div className="surface" style={{ ...column, padding: 8, borderRadius: "var(--r-md)", gap: 7 }}>
    <div style={{ ...row, flexWrap: "nowrap", gap: 6 }}>
      <span style={{ width: 7, height: 7, borderRadius: 9999, flex: "none", background: accent(lane) }} />
      <span role="heading" aria-level={4} style={{ flex: 1, fontWeight: 500 }}>{lane === "history" ? t("결정 후속", "Decision follow-up") : laneLabel(lane, t)}</span>
      <span className="muted">{entries.length}</span>
    </div>
    {entries.slice(0, limit).map(entry => <div key={entry.key}>{entry.content}</div>)}
    {entries.length > limit && <Button label={t(`결정·작업 ${entries.length - limit}개 더 보기`, `Show ${entries.length - limit} more items`)} onPress={() => setLimit(n => n + 10)} />}
  </div>;
}

const order: ColumnKind[] = ["running", "review", "human", "history", "idle", "done", "unknown"];

export function Project({ projectId, title, decisions, cards, records, history = [], historyLinks, requests, renderRecord, renderPull, recordLinks, compact, open, sessionHostLabel }: {
  projectId: string; title: string; decisions: number; cards: Card[]; records: TrackedDecision[]; history?: ReplyEntry[]; historyLinks: HistoryLinks; requests: PullRequestItem[];
  renderRecord: (item: TrackedDecision) => ReactNode; renderPull: (pr: PullRequestItem, projectId: string) => ReactNode; recordLinks: (item: TrackedDecision) => TrackedSessionLinks;
  compact: boolean; open: OpenSession; sessionHostLabel: string;
}) {
  const { t } = useBoardLanguage();
  const [ref, width] = useWidth();
  const groups: Record<ColumnKind, Entry[]> = {
    history: history.map(entry => ({ key: entry.key, content: <ReplyCard entry={entry} links={historyLinks} open={open} /> })),
    running: [], review: [], human: [], idle: [], done: [], unknown: [],
  };
  for (const entry of classifyProject({ records, cards, pulls: requests })) {
    const content = entry.kind === "record" ? <RecordPreview item={entry.item} render={renderRecord} links={recordLinks(entry.item)} />
      : entry.kind === "session" ? <CardView card={entry.card} open={open} sessionHostLabel={sessionHostLabel} />
      : renderPull(entry.pr, projectId);
    groups[entry.lane].push({ key: entry.key, content });
  }
  const lanes = order.filter(lane => groups[lane].length);
  const stacked = width ? width < 490 : compact;
  const running = cards.filter(card => card.lane === "running").length;
  const columns = lanes.map(lane => <div key={lane} style={stacked ? { width: "100%" } : { width: columnWidth(width, lanes.length), flex: "none" }}>
    <Column lane={lane} entries={groups[lane]} />
  </div>);
  return <div ref={ref} style={{ ...column, gap: 8, minWidth: 0 }}>
    <ProjectText projectId={projectId} projects={projectId ? [title] : []} style={{ fontSize: 18, lineHeight: "24px", fontWeight: 600 }}>
      <span role="heading" aria-level={3}>{title}</span>
    </ProjectText>
    <p className="muted" style={{ fontSize: 13 }}>
      {t(`세션 ${cards.length}개 · 진행 중인 세션 ${running}개 · 내 결정 ${decisions}건`, `Sessions ${cards.length} · Running sessions ${running} · My decisions ${decisions}`)}
    </p>
    {stacked ? <div style={{ ...column, gap: COLUMN_GAP }}>{columns}</div>
      : <div className="scroll" style={{ display: "flex", gap: COLUMN_GAP, paddingBottom: 5, alignItems: "flex-start" }}>{columns}</div>}
  </div>;
}
