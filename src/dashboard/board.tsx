/** @jsxImportSource react */
// Paseo's BoardView (client/board.tsx): header, project filters, notices, settings and the classic stack,
// and the decision entries every view places. A sent reply leaves an inline receipt in its row's place.
import { useMemo, useState, type ReactNode } from "react";
import { priorityLabel } from "../paseo/client/decision-priority";
import { sessionRowKey, withReceiptPositions, type CompletedAction, type InlineReceipt } from "../paseo/client/decision-receipts";
import { decisionRowSummary } from "../paseo/client/decision-row";
import { decisionSummary } from "../paseo/client/decision-summary";
import { historySessionLinks, type HistoryLinks } from "../paseo/client/history-sessions";
import type { Card, Snapshot } from "../paseo/client/model";
import { clarificationKey, clarificationRecipient, sessionClarificationCard, type ClarificationCard } from "../paseo/shared/clarifications";
import type { PullRequestItem } from "../paseo/shared/prs";
import type { BoardReadiness } from "../paseo/shared/readiness";
import type { TrackedDecision } from "../paseo/shared/tracked-decisions";
import type { BoardLayoutProps, DecisionEntry } from "./board-layout";
import { boardModel, toggleFilter, type ProjectId } from "./board-model";
import { PullCard, RecordCard, type OpenSession } from "./cards";
import { Clarification } from "./clarification";
import { DecisionActions, type DecisionReceipt } from "./decision-actions";
import { DecisionEditingRow, keepEditingPositions, useDecisionEditing } from "./decision-editing";
import { InlineDecisionReceipt } from "./inline-receipt";
import { ReplyHistory } from "./reply-history";
import { Project } from "./project-kanban";
import { SessionProgress } from "./session-progress";
import { Button, column, Disclosure, fontSize, row, space } from "./ui/controls";
import { BoardLanguageSetting, useBoardLanguage } from "./ui/language";
import { BoardViewSetting, BoardViewSwitch, useBoardViewMode } from "./ui/view-mode-setting";
import { InboxView } from "./view-inbox";
import { LaterView } from "./view-later";

export type BoardViewProps = {
  snapshot: Snapshot | null; readiness: BoardReadiness | null; hostLabel: string; compact: boolean;
  error: string | null; loading: boolean; updatedAt: Date | null; changing: boolean;
  onRefresh: () => void; onProject: (id: string, enabled: boolean) => void; onOpen: OpenSession;
};

export function BoardView({ snapshot, readiness, hostLabel, compact, error, loading, updatedAt, changing, onRefresh, onProject, onOpen }: BoardViewProps) {
  const { t, language } = useBoardLanguage();
  const view = useBoardViewMode();
  const [chosenProjects, setChosenProjects] = useState<ProjectId[]>([]);
  const [settings, setSettings] = useState(false);
  const [showError, setShowError] = useState(false);
  const [manage, setManage] = useState(false);
  const [digestLimit, setDigestLimit] = useState(5);
  const [inlineReceipts, setInlineReceipts] = useState<InlineReceipt[]>([]);
  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const [historyOpen, setHistoryOpen] = useState<boolean | null>(null);
  const now = Date.now();
  const completed = new Set(inlineReceipts.map(receipt => receipt.actionKey));
  const model = snapshot ? boardModel(snapshot, chosenProjects, t, now, completed) : null;
  const configured = model ? model.configured : readiness?.configured;
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const layoutMode = !settings && snapshot && configured ? view.mode : "classic";

  const rankedKeys = model?.ranked.map(row => row.key) ?? [];
  const { positions, onEditing } = useDecisionEditing(rankedKeys);
  const allKeys = keepEditingPositions(rankedKeys, positions);
  const shownKeys = layoutMode === "classic" ? allKeys.slice(0, digestLimit) : allKeys;
  const remaining = rankedKeys.length - shownKeys.length;
  const scopedReceipts = model ? inlineReceipts.filter(receipt => receipt.projectIds.some(id => model.byProject.has(id) && model.inFilter(id))) : [];
  const orderedKeys = withReceiptPositions(shownKeys, scopedReceipts);
  function remember(action: CompletedAction) {
    // The order is the one on screen when the person pressed send.
    setInlineReceipts(previous => previous.some(entry => entry.actionKey === action.actionKey && entry.rowKey === action.rowKey)
      ? previous : [...previous, { ...action, order: orderedKeys }]);
  }
  const matches = (receipt: DecisionReceipt, card: Card) => receipt.projectId === card.session.projectId && receipt.sessionId === card.session.id && receipt.version === card.session.decision?.version;

  // Phase 2 asks only the session a card came from; ledger and pull request questions go to a coordinator.
  function questionFor(card: ClarificationCard | null, title: string) {
    if (!snapshot) return null;
    const recipientId = card ? clarificationRecipient(card, snapshot) : null;
    const recipientTitle = snapshot.sessions.find(session => session.id === recipientId)?.title;
    return <Clarification key={card ? clarificationKey(card) : title} title={title} card={card} recipientId={recipientId}
      recipientTitle={recipientTitle} entries={snapshot.clarifications ?? []} onRefresh={onRefresh} />;
  }
  const renderDecision = (card: Card, embedded = false, rowKey?: string, priority?: string) =>
    <DecisionActions key={JSON.stringify([card.session.projectId, card.session.id, card.session.decision?.version])}
      clarification={!embedded && questionFor(sessionClarificationCard(card.session, card.note), card.session.title)}
      card={card} hostLabel={hostLabel} priorityLabel={priority} open={onOpen} embedded={embedded}
      coordinator={snapshot?.coordinator ?? null} coordinatorTitle={snapshot?.sessions.find(session => session.id === snapshot.coordinator)?.title}
      receipt={receipts.find(receipt => matches(receipt, card))}
      onSent={result => {
        if (rowKey && result.action === "reply") remember({
          rowKey, actionKey: sessionRowKey(card), projectIds: [result.projectId], status: "sent", recipientId: result.recipientId,
          title: decisionSummary(card, t).headline, detail: result.answer || result.recipient || undefined,
        });
        setReceipts(prior => [result, ...prior.filter(receipt => !(receipt.projectId === result.projectId && receipt.sessionId === result.sessionId))].slice(0, 20));
        onRefresh();
      }} />;
  const renderRecord = (item: TrackedDecision, rowKey?: string, priority?: string) => {
    const native = model?.human.find(card => card.session.id === item.matchedSessionId);
    const linked = item.matchedSessionId || item.sessionId;
    const local = linked && !native && snapshot?.sessions.some(session => session.id === linked) ? linked : null;
    return <RecordCard key={item.key} item={item} priorityLabel={priority} linkedSession={local} open={onOpen}>
      {native && (!rowKey || !completed.has(sessionRowKey(native))) && renderDecision(native, true, rowKey)}
    </RecordCard>;
  };
  const renderPull = (pr: PullRequestItem, priority?: string) => <PullCard key={pr.url} pr={pr} priorityLabel={priority} />;

  const rowsByKey = new Map(model?.ranked.map(row => [row.key, row]));
  const activeRows = new Map<string, ReactNode>();
  shownKeys.forEach((key, position) => {
    const row = rowsByKey.get(key)!;
    const label = priorityLabel(row, t, now);
    const content = row.kind === "pull" ? renderPull(row.pr, label)
      : row.kind === "record" ? renderRecord(row.item, key, label)
      : renderDecision(row.card, false, key, label);
    activeRows.set(key, <DecisionEditingRow rowKey={key} position={position} onEditing={onEditing}>{content}</DecisionEditingRow>);
  });
  const renderReceipt = (receipt: InlineReceipt) => <InlineDecisionReceipt key={receipt.actionKey} receipt={receipt} onOpen={onOpen}
    onDismiss={() => setInlineReceipts(prior => prior.map(entry => entry === receipt ? { ...entry, hidden: true } : entry))} />;
  const receiptsFor = (key: string) => scopedReceipts.filter(receipt => receipt.rowKey === key && !receipt.hidden);

  const pad = compact ? space[3] : space[6];
  const time = updatedAt && (language === "ko" ? `${updatedAt.toLocaleTimeString("ko-KR")} 갱신` : `Updated ${updatedAt.toLocaleTimeString("en-US")}`);
  const header = <div style={{ ...row, gap: space[2] }}>
    <div style={{ ...column, flex: 1, minWidth: 160, gap: space[0.5] }}>
      <h1 style={{ margin: 0, fontSize: fontSize.base, lineHeight: "20px", fontWeight: 300 }}>{settings ? t("코디네이터 보드 설정", "Coordinator board settings") : t("세션별 코디네이터 보드", "Session coordinator board")}</h1>
      {error ? <button type="button" className="link-muted danger" style={{ alignSelf: "flex-start", padding: 0, fontSize: fontSize.sm, color: "var(--destructive)" }}
        aria-expanded={showError} onClick={() => setShowError(open => !open)}>
        {snapshot ? t("갱신 실패 · 이전 결과 표시 · 오류 상세", "Refresh failed · Showing last result · Details") : t("조회 실패 · 오류 상세", "Could not load sessions · Details")}
      </button> : <p className="muted sm">{[hostLabel, time || t("세션 조회 중…", "Loading sessions…")].filter(Boolean).join(" · ")}</p>}
    </div>
    {!settings && !!snapshot && !!configured && <BoardViewSwitch view={view} />}
    {!settings && <Button variant="ghost" size="sm" label={loading ? t("조회 중…", "Refreshing…") : t("새로 고침", "Refresh")} onPress={onRefresh} disabled={loading} />}
    <Button variant="ghost" size="sm" label={settings ? t("보드로 돌아가기", "Back to board") : t("설정", "Settings")} onPress={() => {
      setSettings(!settings); setManage(false);
    }} />
  </div>;
  const errorDetail = !!error && showError && <p className="danger" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</p>;

  const filters = model?.filters ?? [];
  const filteredHistory = model ? (snapshot?.replyHistory ?? []).filter(entry => model.inFilter(entry.projectId)) : [];
  const showHistory = historyOpen ?? (model?.filteredTotal === 0 && !scopedReceipts.some(receipt => !receipt.hidden));
  const historyRepos = useMemo(() => new Map(snapshot?.pullRequests?.projects.flatMap(project =>
    project.repo && project.mode !== "off" ? [[project.projectId, project.repo] as const] : []) ?? []), [snapshot?.pullRequests?.projects]);
  const historyLinks: HistoryLinks = entry => historySessionLinks(entry, { sessions: snapshot?.sessions ?? [], peers: [], repos: historyRepos });
  const filtersNode = model && !settings && configured && model.byProject.size > 0 ? <div role="group" aria-label={t("프로젝트 필터", "Project filters")}
    style={{ ...row, gap: space[2] }}>
    <Button size="sm" label={t(`전체 ${model.total}`, `All ${model.total}`)} selected={!filters.length} onPress={() => setChosenProjects([])} />
    {[...model.byProject].map(([id, count]) => <Button key={JSON.stringify(id)} size="sm" toggle selected={filters.includes(id)}
      projectId={id ?? undefined} project={id === null ? undefined : model.projectName(id)} label={`${model.projectName(id)} · ${count}`}
      onPress={() => setChosenProjects(previous => toggleFilter(previous, id, model.byProject))} />)}
  </div> : null;
  const noticesNode = model ? <>
    {model.incomplete && <p role="status" className="warn">{t("일부 결정 기록을 읽지 못했습니다. 현재 건수에는 확인한 항목만 포함됩니다.", "Some decision records could not be loaded. The count includes the available items.")}</p>}
    {filters.length > 0 && !model.filteredTotal && model.total > 0 && !model.incomplete && <p className="muted">{t("선택한 프로젝트에 결정할 일이 없습니다.", "No decisions in the selected projects.")}</p>}
    {model.total === 0 && !model.incomplete && <p className="muted">{t("지금 결정할 일이 없습니다.", "No decisions are waiting for you.")}</p>}
  </> : null;
  const operationsNode = <div className="surface" style={{ ...column, gap: 10, padding: 14, borderRadius: "var(--r-lg)" }}>
    <span role="heading" aria-level={2} style={{ fontSize: 17, lineHeight: "24px", fontWeight: 600 }}>{t("코디네이터", "Coordinator")}</span>
    <p className="muted">{t("코디네이터에 요청하는 기능은 다음 단계에서 제공합니다.", "Requests to the coordinator are coming in a later phase.")}</p>
  </div>;
  const progressNode = model && snapshot && !settings && configured ? <SessionProgress cards={model.visibleProjects.flatMap(project => project.cards)}
    hostLabel={hostLabel} projectName={model.projectName} open={onOpen}>
    {!model.visibleProjects.length && !model.showHostWide && <p className="muted">{t("표시할 세션이 없습니다.", "No sessions to show.")}</p>}
    {model.showHostWide && <Project projectId="" title={t("공통", "Host-wide")} cards={[]} requests={[]} records={model.records.filter(item => item.projectId === null)}
      decisions={model.byProject.get(null) ?? 0} renderRecord={item => renderRecord(item)} renderPull={pr => renderPull(pr)} compact={compact} open={onOpen} sessionHostLabel={hostLabel} />}
    {model.visibleProjects.map(project => <Project key={project.id} projectId={project.id} title={project.title} cards={project.cards}
      records={model.records.filter(item => item.projectId === project.id)} requests={snapshot.pullRequests?.items.filter(pr => pr.projectIds.includes(project.id)) ?? []}
      decisions={model.byProject.get(project.id) ?? 0} renderRecord={item => renderRecord(item)} renderPull={pr => renderPull(pr)} compact={compact} open={onOpen} sessionHostLabel={hostLabel} />)}
  </SessionProgress> : null;

  const historyNode = model && snapshot && !settings && configured && filteredHistory.length > 0
    ? <ReplyHistory entries={filteredHistory} links={historyLinks} open={onOpen} expanded={showHistory} onToggle={() => setHistoryOpen(!showHistory)} />
    : null;

  if (layoutMode !== "classic" && model) {
    const entries: DecisionEntry[] = orderedKeys.map(key => {
      const row = rowsByKey.get(key) ?? null;
      return { key, row, summary: row && decisionRowSummary(row, t), label: row && priorityLabel(row, t, now), card: activeRows.get(key) ?? null, receipts: receiptsFor(key) };
    });
    const props: BoardLayoutProps = {
      compact, entries, total: model.total, filteredTotal: model.filteredTotal, filtered: filters.length > 0, incomplete: model.incomplete, renderReceipt,
      slots: { filters: filtersNode, notices: noticesNode, operations: operationsNode, history: historyNode, progress: progressNode },
      projects: { name: model.projectName },
    };
    const Layout = layoutMode === "inbox" ? InboxView : LaterView;
    return <div style={{ ...column, height: "100%", background: "var(--bg)" }}>
      <div style={{ ...column, gap: space[2], padding: `${space[3]}px ${pad}px`, borderBottom: "1px solid var(--border)" }}>
        {header}
        {errorDetail}
        {view.saveFailed && <p role="status" className="warn sm">{t("보기 설정을 이 기기에 저장하지 못했습니다.", "Could not save the view on this device.")}</p>}
      </div>
      <div style={{ ...column, flex: 1, minHeight: 0 }}><Layout {...props} /></div>
    </div>;
  }

  const projectPicker = snapshot && (pickingProjects || settings) ? <>
    <p className="muted">{t("선택한 프로젝트의 최근 대화를 읽어 내 결정을 찾습니다. 코디네이터를 지정하면 그 세션도 선택한 프로젝트의 발췌를 볼 수 있습니다.", "The board reads recent conversations in selected projects to find decisions. The assigned coordinator can also read excerpts from those projects.")}</p>
    <div style={{ ...row, gap: space[2] }}>
      {snapshot.projects.map(project => {
        const duplicateName = snapshot.projects.some(other => other.id !== project.id && other.title === project.title);
        const label = duplicateName ? `${project.title} · ${project.path || project.id}` : project.title;
        return <Button key={project.id} size="sm" toggle projectId={project.id} project={project.title} selected={project.selected} disabled={changing}
          label={project.selected ? `✓ ${label}` : label} accessibilityLabel={label} onPress={() => onProject(project.id, !project.selected)} />;
      })}
    </div>
  </> : null;

  return <div className="scroll" style={{ height: "100%", background: "var(--bg)" }}>
    <div style={{ ...column, gap: space[6], padding: pad }}>
      {header}
      {filtersNode}
      {errorDetail}
      {settings && <BoardViewSetting view={view} />}
      {settings && <BoardLanguageSetting />}
      {!!error && settings && <div><Button label={t("세션 다시 조회", "Retry session lookup")} disabled={loading} onPress={onRefresh} /></div>}
      {projectPicker && (pickingProjects
        ? <div style={{ ...column, gap: space[2] }}>
          <h2 style={{ margin: 0, fontSize: fontSize.base, fontWeight: 500 }}>{t("다이제스트에서 관리할 프로젝트 선택", "Select projects for your digest")}</h2>
          {projectPicker}
        </div>
        : <Disclosure title={t("보드에서 관리할 프로젝트 선택", "Choose projects to manage")} expanded={manage} onPress={() => setManage(!manage)}>
          {projectPicker}
        </Disclosure>)}
      {!settings && !snapshot && !error && !!readiness?.decisionTitles?.length && <div style={{ ...column, gap: space[1.5] }}>
        <h2 style={{ margin: 0, fontSize: fontSize.base, fontWeight: 500 }}>{t("내 결정", "My decisions")}</h2>
        {readiness.decisionTitles.map((title, index) => <p key={index} className="clamp2">{title}</p>)}
        <p className="muted">{t("세션과 PR 상태를 확인하고 있어요.", "Checking session and PR status…")}</p>
      </div>}
      {!settings && model && configured && <div style={{ ...column, gap: compact ? space[3] : space[4] }}>
        <h2 style={{ margin: 0, fontSize: fontSize.base, fontWeight: 500 }}>{filters.length ? t(`내 결정 · ${model.filteredTotal}건 / 전체 ${model.total}건`, `My decisions · ${model.filteredTotal} of ${model.total}`) : t(`내 결정 · ${model.total}건`, `My decisions · ${model.total}`)}</h2>
        {noticesNode}
        {orderedKeys.map(key => <article key={key} className="surface" style={{ ...column, gap: space[2], padding: compact ? space[3] : space[4], borderRadius: "var(--r-xl)" }}>
          {receiptsFor(key).map(renderReceipt)}
          {activeRows.get(key)}
        </article>)}
        {remaining > 0 && <div><Button label={t(`결정 ${remaining}건 더 보기`, `Show ${remaining} more decisions`)} onPress={() => setDigestLimit(model.total)} /></div>}
      </div>}
      {historyNode}
      {!settings && snapshot && !configured && !snapshot.projects.length && <p className="muted">{t("표시할 세션이 없습니다. 워크스페이스에서 세션을 시작하면 여기에 나타납니다.", "Start a session in a workspace to see it here.")}</p>}
      {progressNode}
    </div>
  </div>;
}
