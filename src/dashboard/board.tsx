/** @jsxImportSource react */
// Paseo's BoardView (client/board.tsx): header, project filters, notices, settings and the classic stack,
// and the decision entries every view places. Phase 1 is read-only, so no card holds a draft or a receipt.
import { useState, type ReactNode } from "react";
import { priorityLabel } from "../paseo/client/decision-priority";
import { decisionRowSummary } from "../paseo/client/decision-row";
import type { Card, Snapshot } from "../paseo/client/model";
import type { PullRequestItem } from "../paseo/shared/prs";
import type { BoardReadiness } from "../paseo/shared/readiness";
import type { TrackedDecision } from "../paseo/shared/tracked-decisions";
import type { BoardLayoutProps, DecisionEntry } from "./board-layout";
import { boardModel, toggleFilter, type ProjectId } from "./board-model";
import { DecisionCard, PullCard, RecordCard, type OpenSession } from "./cards";
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
  const now = Date.now();
  const model = snapshot ? boardModel(snapshot, chosenProjects, t, now) : null;
  const configured = model ? model.configured : readiness?.configured;
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const layoutMode = !settings && snapshot && configured ? view.mode : "classic";

  const renderDecision = (card: Card, embedded = false, priority?: string) =>
    <DecisionCard key={JSON.stringify([card.session.projectId, card.session.id, card.session.decision?.version])}
      card={card} hostLabel={hostLabel} priorityLabel={priority} open={onOpen} embedded={embedded} />;
  const renderRecord = (item: TrackedDecision, priority?: string) => {
    const native = model?.human.find(card => card.session.id === item.matchedSessionId);
    const linked = item.matchedSessionId || item.sessionId;
    const local = linked && !native && snapshot?.sessions.some(session => session.id === linked) ? linked : null;
    return <RecordCard key={item.key} item={item} priorityLabel={priority} linkedSession={local} open={onOpen}>
      {native && renderDecision(native, true)}
    </RecordCard>;
  };
  const renderPull = (pr: PullRequestItem, priority?: string) => <PullCard key={pr.url} pr={pr} priorityLabel={priority} />;

  const rankedKeys = model?.ranked.map(row => row.key) ?? [];
  const shownKeys = layoutMode === "classic" ? rankedKeys.slice(0, digestLimit) : rankedKeys;
  const remaining = rankedKeys.length - shownKeys.length;
  const rowsByKey = new Map(model?.ranked.map(row => [row.key, row]));
  const activeRows = new Map<string, ReactNode>();
  for (const key of shownKeys) {
    const row = rowsByKey.get(key)!;
    const label = priorityLabel(row, t, now);
    activeRows.set(key, row.kind === "pull" ? renderPull(row.pr, label)
      : row.kind === "record" ? renderRecord(row.item, label)
      : renderDecision(row.card, false, label));
  }

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

  if (layoutMode !== "classic" && model) {
    const entries: DecisionEntry[] = shownKeys.map(key => {
      const row = rowsByKey.get(key)!;
      return { key, row, summary: decisionRowSummary(row, t), label: priorityLabel(row, t, now), card: activeRows.get(key) ?? null, receipts: [] };
    });
    const props: BoardLayoutProps = {
      compact, entries, total: model.total, filteredTotal: model.filteredTotal, filtered: filters.length > 0, incomplete: model.incomplete,
      slots: { filters: filtersNode, notices: noticesNode, operations: operationsNode, history: null, progress: progressNode },
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
        {shownKeys.map(key => <article key={key} className="surface" style={{ ...column, gap: space[2], padding: compact ? space[3] : space[4], borderRadius: "var(--r-xl)" }}>
          {activeRows.get(key)}
        </article>)}
        {remaining > 0 && <div><Button label={t(`결정 ${remaining}건 더 보기`, `Show ${remaining} more decisions`)} onPress={() => setDigestLimit(model.total)} /></div>}
      </div>}
      {!settings && snapshot && !configured && !snapshot.projects.length && <p className="muted">{t("표시할 세션이 없습니다. 워크스페이스에서 세션을 시작하면 여기에 나타납니다.", "Start a session in a workspace to see it here.")}</p>}
      {progressNode}
    </div>
  </div>;
}
