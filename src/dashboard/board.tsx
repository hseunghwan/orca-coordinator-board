/** @jsxImportSource react */
// Paseo's BoardView (client/board.tsx): header, project filters, notices, settings and the classic stack,
// and the decision entries every view places. A sent reply leaves an inline receipt in its row's place.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { priorityLabel } from "../paseo/client/decision-priority";
import { pullRowKey, recordRowKey, sessionRowKey, withReceiptPositions, type CompletedAction, type InlineReceipt } from "../paseo/client/decision-receipts";
import { decisionRowSummary } from "../paseo/client/decision-row";
import { decisionSummary } from "../paseo/client/decision-summary";
import { historySessionLinks, matchesProject, type HistoryLinks } from "../paseo/client/history-sessions";
import { latestMergeNotification } from "../paseo/client/merge-notification";
import type { Card, Snapshot } from "../paseo/client/model";
import { clarificationKey, clarificationRecipient, sessionClarificationCard, trackedClarificationCard, type ClarificationCard } from "../paseo/shared/clarifications";
import type { PullRequestItem } from "../paseo/shared/prs";
import type { BoardReadiness } from "../paseo/shared/readiness";
import { mentionsSecurityGate, trackedRecipient, usesSourceCoordinator, type TrackedDecision } from "../paseo/shared/tracked-decisions";
import { trackedSessionTargets } from "../paseo/client/tracked-session-targets";
import { matchesWorkspace } from "../paseo/shared/workspace-pull";
import type { BoardLayoutProps, DecisionEntry, OpenSession } from "./board-layout";
import { boardModel, toggleFilter, type ProjectId } from "./board-model";
import { Clarification } from "./clarification";
import { DecisionActions, type DecisionReceipt } from "./decision-actions";
import { DecisionEditingRow, keepEditingPositions, useDecisionEditing } from "./decision-editing";
import { InlineDecisionReceipt } from "./inline-receipt";
import { OperationsPanel } from "./operations";
import { ReplyHistory } from "./reply-history";
import { Project } from "./project-kanban";
import { MergeFeedback, PullRequestCard, PullRequestSettings, type MergeNotice, type WorkSessionLink } from "./pull-requests";
import { call, openSession } from "./rpc";
import { TrackedDecisionCard } from "./tracked-decisions";
import type { TrackedSessionLinks } from "./tracked-session-chips";
import { SessionProgress } from "./session-progress";
import { Button, column, Disclosure, fontSize, row, space } from "./ui/controls";
import { BoardLanguageSetting, useBoardLanguage } from "./ui/language";
import { BoardViewSetting, BoardViewSwitch, useBoardViewMode } from "./ui/view-mode-setting";
import { InboxView } from "./view-inbox";
import { FocusView } from "./view-focus";
import { MatrixView } from "./view-matrix";

export type BoardViewProps = {
  snapshot: Snapshot | null; readiness: BoardReadiness | null; hostLabel: string; compact: boolean;
  error: string | null; loading: boolean; updatedAt: Date | null; changing: boolean;
  onRefresh: () => void; onProject: (id: string, enabled: boolean) => void; onCoordinator: (sessionId: string | null) => void; onOpen: OpenSession;
};

export function BoardView({ snapshot, readiness, hostLabel, compact, error, loading, updatedAt, changing, onRefresh, onProject, onCoordinator, onOpen }: BoardViewProps) {
  const { t, language } = useBoardLanguage();
  const view = useBoardViewMode();
  const [chosenProjects, setChosenProjects] = useState<ProjectId[]>([]);
  const [settings, setSettings] = useState(false);
  const [showError, setShowError] = useState(false);
  const [manage, setManage] = useState(false);
  const [pickSession, setPickSession] = useState(false);
  const [digestLimit, setDigestLimit] = useState(5);
  const [inlineReceipts, setInlineReceipts] = useState<InlineReceipt[]>([]);
  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const [historyOpen, setHistoryOpen] = useState<boolean | null>(null);
  const now = Date.now();
  const completed = new Set(inlineReceipts.map(receipt => receipt.actionKey));
  const model = snapshot ? boardModel(snapshot, chosenProjects, t, now, completed) : null;
  const configured = model ? model.configured : readiness?.configured;
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const coordinatorId = snapshot ? snapshot.coordinator : readiness?.coordinator ?? null;
  const operationsReady = !!snapshot || !!(readiness?.configured && readiness.coordinator && !settings);
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

  const historyRepos = useMemo(() => new Map(snapshot?.pullRequests?.projects.flatMap(project =>
    project.repo && project.mode !== "off" ? [[project.projectId, project.repo] as const] : []) ?? []), [snapshot?.pullRequests?.projects]);
  const historyLinks: HistoryLinks = entry => historySessionLinks(entry, { sessions: snapshot?.sessions ?? [], peers: [], repos: historyRepos });
  const [mergeNotice, setMergeNotice] = useState<MergeNotice | null>(null);
  useEffect(() => {
    const stored = new Map(snapshot?.replyHistory?.flatMap(entry => entry.pullMerge?.status === "merged" && entry.pullMerge.notification
      ? [[JSON.stringify([entry.projectId, pullRowKey(entry.pullMerge)]), entry.pullMerge.notification] as const] : []));
    if (!stored.size) return;
    setInlineReceipts(previous => {
      const next = previous.map(receipt => {
        if (receipt.status !== "merged") return receipt;
        const notification = latestMergeNotification(receipt.notification, stored.get(JSON.stringify([receipt.mergeProjectId, receipt.actionKey])));
        return notification === receipt.notification ? receipt : { ...receipt, notification };
      });
      return next.some((receipt, index) => receipt !== previous[index]) ? next : previous;
    });
  }, [snapshot?.replyHistory, inlineReceipts.length]);

  function questionFor(card: ClarificationCard | null, title: string, prior?: TrackedDecision["qa"], onDraftChange?: (active: boolean) => void, ownerId?: string | null) {
    if (!snapshot) return null;
    const recipientId = card ? clarificationRecipient(card, snapshot) : null;
    const recipientTitle = ownerId && ownerId === recipientId ? t("운영 코디네이터", "Ledger owner") + " · " + ownerId
      : snapshot.sessions.find(session => session.id === recipientId)?.title;
    return <Clarification key={card ? clarificationKey(card) : title} title={title} card={card} recipientId={recipientId}
      recipientTitle={recipientTitle} entries={snapshot.clarifications ?? []} prior={prior} onRefresh={onRefresh} onDraftChange={onDraftChange} />;
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

  // Orca has no peer hosts, so a record bound to another host's session gets no link here.
  function linkedSession(item: TrackedDecision) {
    const id = item.matchedSessionId || item.sessionId;
    if (!id || item.sessionHost) return;
    const local = snapshot?.sessions.find(session => session.id === id && (matchesProject(session.projectId, item.projectId, historyRepos) || session.id === item.matchedSessionId));
    return local ? () => onOpen(local.id) : undefined;
  }
  function recordLinks(item: TrackedDecision, showSource = true): TrackedSessionLinks {
    if (!snapshot) return {};
    const { ownerId, sameSession } = trackedSessionTargets(item, snapshot.coordinator);
    const ownerKnown = ownerId === snapshot.coordinator || snapshot.sessions.some(session => session.id === ownerId);
    const owner = ownerId ? {
      id: ownerId,
      open: () => onOpen(ownerId),
      // A ledger can name a coordinator this board has not listed; asking Orca to open it is the check.
      verify: ownerKnown ? undefined : async () => (await call(openSession, { sessionId: ownerId })).opened,
    } : undefined;
    return { owner, source: showSource && !(owner && sameSession) ? linkedSession(item) : undefined };
  }
  const openCoordinator = coordinatorId ? () => onOpen(coordinatorId) : undefined;
  function renderPull(pr: PullRequestItem, projectId: string, decision = false, securityGate = false, embedded = false, rowKey?: string, scope: (string | null)[] = pr.projectIds, priority?: string) {
    const workSessions: WorkSessionLink[] = [];
    for (const session of snapshot?.sessions ?? []) {
      if (!model?.inFilter(session.projectId) || !pr.projectIds.includes(session.projectId) || !matchesWorkspace(pr, session.workspacePull)) continue;
      const state = session.status === "closed" ? t("대화 종료", "Closed") : session.lane === "running" ? t("진행 중", "Running") : session.status === "idle" ? t("대기", "Idle") : t("상태 확인 필요", "Check status");
      workSessions.push({ key: session.id, label: [session.title, hostLabel, state].join(" · "), open: () => onOpen(session.id) });
    }
    return <PullRequestCard key={JSON.stringify([pr.url, projectId])} pr={pr} projectId={projectId} priorityLabel={priority} workSessions={workSessions}
      clarification={decision && !embedded && questionFor({ kind: "pull", projectId, repo: pr.repo, number: pr.number, updatedAt: pr.updatedAt }, pr.repo + " #" + pr.number)}
      decision={decision} showDivider={!decision || embedded} securityGate={securityGate} openCoordinator={openCoordinator} onResult={notice => {
        const { status } = notice;
        const merged = status === "merged" || status === "already-merged";
        if (rowKey && merged) {
          remember({ rowKey, actionKey: pullRowKey(pr), projectIds: scope, status,
            title: pr.title, detail: notice.target, mergeProjectId: projectId, notification: notice.notification });
        }
        setMergeNotice(rowKey && merged ? null : notice);
        onRefresh();
      }} />;
  }
  const renderRecord = (item: TrackedDecision, rowKey?: string, priority?: string) => {
    if (!snapshot) return null;
    const native = model?.human.find(card => card.session.id === item.matchedSessionId);
    const pr = item.kind === "merge" && item.mergeTarget && snapshot.pullRequests?.items.find(pr =>
      pr.repo === item.mergeTarget?.repo && pr.number === item.mergeTarget.number &&
      (!item.projectId || pr.projectIds.includes(item.projectId)) && (pr.reason !== "ready" || item.matchedPull));
    const recipient = trackedRecipient(item, snapshot.coordinator, snapshot.sessions);
    const replyRecipient = native && !item.questions.length ? undefined : recipient;
    const mergeHandled = !!rowKey && !!item.mergeTarget && scopedReceipts.some(receipt => receipt.rowKey === rowKey && receipt.actionKey === pullRowKey(item.mergeTarget!));
    return <TrackedDecisionCard links={recordLinks(item, !native)} key={item.key} item={item} priorityLabel={priority}
      renderClarification={onDraftChange => questionFor(trackedClarificationCard(item, snapshot.sessions), item.title, item.qa, onDraftChange, usesSourceCoordinator(item) ? item.sourceCoordinatorId : undefined)}
      pull={mergeHandled ? <></>
        : pr && renderPull(pr, pr.projectIds.includes(item.projectId ?? "") ? item.projectId! : pr.projectIds[0], true, mentionsSecurityGate(item), true, rowKey, [item.projectId])}
      recipientId={replyRecipient} onResolved={(status, mode, answer) => {
        if (rowKey && mode && (status === "sent" || status === "closed" || status === "already-closed")) {
          remember({ rowKey, actionKey: recordRowKey(item), projectIds: [item.projectId],
            status: status === "closed" ? (mode === "save" ? "saved" : "reviewed") : status,
            recipientId: status === "sent" && mode === "send" ? replyRecipient ?? undefined : undefined,
            title: item.title, detail: answer || item.projectTitle || model?.projectName(item.projectId) });
        }
        onRefresh();
      }}>
      {native && (!rowKey || !completed.has(sessionRowKey(native))) && renderDecision(native, true, rowKey)}
    </TrackedDecisionCard>;
  };

  const rowsByKey = new Map(model?.ranked.map(row => [row.key, row]));
  const activeRows = new Map<string, ReactNode>();
  shownKeys.forEach((key, position) => {
    const row = rowsByKey.get(key)!;
    const label = priorityLabel(row, t, now);
    const content = row.kind === "pull" ? renderPull(row.pr, row.pr.projectIds.find(id => model!.inFilter(id)) ?? row.pr.projectIds[0], true, false, false, key, row.pr.projectIds, label)
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
      setSettings(!settings); setManage(false); setPickSession(false);
    }} />
  </div>;
  const errorDetail = !!error && showError && <p className="danger" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{error}</p>;

  const filters = model?.filters ?? [];
  const filteredHistory = model ? (snapshot?.replyHistory ?? []).filter(entry => model.inFilter(entry.projectId)) : [];
  const showHistory = historyOpen ?? (model?.filteredTotal === 0 && !scopedReceipts.some(receipt => !receipt.hidden));
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
    {mergeNotice && model.inFilter(mergeNotice.projectId) && snapshot?.projects.some(project => project.selected && project.id === mergeNotice.projectId) &&
      (mergeNotice.status === "merged" || mergeNotice.status === "already-merged" ||
        !snapshot.pullRequests?.items.some(pr => pr.lane === "review" && pr.repo + " #" + pr.number === mergeNotice.target)) && <MergeFeedback notice={mergeNotice} />}
  </> : null;
  const operationsNode = <OperationsPanel settings={operationsReady && settings} coordinator={operationsReady ? coordinatorId : null}
    configured={operationsReady && !!configured} projects={snapshot?.projects ?? []} refreshBoard={onRefresh} openCoordinator={onOpen} />;
  const progressNode = model && snapshot && !settings && configured ? <SessionProgress cards={model.visibleProjects.flatMap(project => project.cards)}
    hostLabel={hostLabel} projectName={model.projectName} open={onOpen}>
    {!model.visibleProjects.length && !model.showHostWide && <p className="muted">{t("표시할 세션이 없습니다.", "No sessions to show.")}</p>}
    {model.showHostWide && <Project projectId="" title={t("공통", "Host-wide")} cards={[]} requests={[]} records={model.records.filter(item => item.projectId === null)}
      history={(snapshot.replyHistory ?? []).filter(entry => entry.projectId === null)} historyLinks={historyLinks} recordLinks={item => recordLinks(item)}
      decisions={model.byProject.get(null) ?? 0} renderRecord={item => renderRecord(item)} renderPull={(pr, projectId) => renderPull(pr, projectId)} compact={compact} open={onOpen} sessionHostLabel={hostLabel} />}
    {model.visibleProjects.map(project => <Project key={project.id} projectId={project.id} title={project.title} cards={project.cards}
      records={model.records.filter(item => item.projectId === project.id)} requests={snapshot.pullRequests?.items.filter(pr => pr.projectIds.includes(project.id)) ?? []}
      history={(snapshot.replyHistory ?? []).filter(entry => entry.projectId === project.id)} historyLinks={historyLinks} recordLinks={item => recordLinks(item)}
      decisions={model.byProject.get(project.id) ?? 0} renderRecord={item => renderRecord(item)} renderPull={(pr, projectId) => renderPull(pr, projectId)} compact={compact} open={onOpen} sessionHostLabel={hostLabel} />)}
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
      projects: {
        list: model.visibleProjects, hostWide: model.showHostWide, name: model.projectName, records: model.records,
        pulls: snapshot?.pullRequests?.items ?? [], hostLabel, open: onOpen,
        renderRecord: item => renderRecord(item), renderPull: (pr, projectId) => renderPull(pr, projectId),
      },
    };
    const Layout = layoutMode === "focus" ? FocusView : layoutMode === "matrix" ? MatrixView : InboxView;
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
      {settings && snapshot?.pullRequests && !!configured && <PullRequestSettings view={snapshot.pullRequests}
        names={new Map(snapshot.projects.map(project => [project.id, project.title]))} refresh={onRefresh} />}
      {operationsNode}
      {settings && snapshot && <div style={{ ...column, gap: space[2], alignItems: "flex-start" }}>
        <Button label={pickSession ? t("기존 세션 목록 닫기", "Close session list") : t("기존 세션에서 코디네이터 지정", "Choose an existing coordinator session")}
          expanded={pickSession} onPress={() => setPickSession(!pickSession)} />
        {pickSession && <>
          {snapshot.coordinator && <Button disabled={changing} label={t("현재 코디네이터 지정 해제", "Clear current coordinator")} onPress={() => onCoordinator(null)} />}
          {snapshot.sessions.filter(session => session.id !== snapshot.coordinator).map(session => <Button key={session.id} disabled={changing}
            projectId={session.projectId} project={session.projectTitle} label={`${session.projectTitle} · ${session.title} · ${t("지정", "Assign")}`}
            onPress={() => onCoordinator(session.id)} />)}
          {!snapshot.sessions.length && <p className="muted">{t("관리할 프로젝트를 선택하면 지정할 수 있는 세션이 표시됩니다.", "Select a project to see its available sessions.")}</p>}
        </>}
      </div>}
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
