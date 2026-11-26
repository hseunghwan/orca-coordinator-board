/** @jsxImportSource react */
// Paseo's project matrix (client/view-matrix.tsx): decisions run across the top, and below them one table
// keeps every project's columns in the same place. Orca has no peer hosts, so the host column counts this
// device only and the "running on other hosts" block never appears.
import { useState, type CSSProperties, type ReactNode } from "react";
import { decisionGroupLabel } from "../paseo/client/decision-row";
import {
  cellPreview, entryDisplay, hostSummary, isNarrow, isSelectedCell, liveCells, matrixColumnLabel, matrixColumns, matrixMark, matrixPermission,
  matrixRows, matrixSummary, matrixTitle, mountedColumns, rememberCell, ribbonEntries, toggleCell,
  type CellRef, type LaneItem, type MatrixColumn, type MatrixMark, type MatrixRow,
} from "../paseo/client/matrix";
import type { Translate } from "../paseo/view-types";
import type { BoardLayoutProps, DecisionEntry, ProjectBundle } from "./board-layout";
import { CardView } from "./project-kanban";
import { useWidth } from "./use-width";
import { Button, column, fontSize, ProjectText, row, RunningMark, SectionLabel, space, StatusBadge, StatusDot } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export function MatrixView(props: BoardLayoutProps) {
  const { compact, entries, renderReceipt, slots, projects } = props;
  const { t } = useBoardLanguage();
  const [box, width] = useWidth();
  const [operations, setOperations] = useState({ open: false, mounted: false });
  const [progress, setProgress] = useState({ open: false, mounted: false });
  const [cell, setCell] = useState<CellRef | null>(null);
  const [opened, setOpened] = useState<CellRef[]>([]);
  const narrow = isNarrow(compact, width);
  const rows = matrixRows({ ...projects, peers: [] }, t("공통", "Host-wide"));
  const mounted = liveCells(opened, rows);
  const onCell = (next: CellRef) => {
    setCell(current => toggleCell(current, next));
    setOpened(current => rememberCell(current, next, rows));
  };
  return <div ref={box} className="scroll" style={{ flex: 1 }}>
    <div style={{ ...column, gap: space[4], padding: narrow ? space[3] : space[6] }}>
      {slots.filters}
      {slots.notices}
      <div style={{ ...row, gap: space[2] }}>
        <Button variant="secondary" size="sm" expanded={operations.open}
          label={operations.open ? t("코디네이터 요청 닫기", "Close coordinator request") : t("코디네이터에 요청", "Ask the coordinator")}
          onPress={() => setOperations(state => ({ open: !state.open, mounted: true }))} />
      </div>
      {/* Stays mounted once opened so a half-written request survives closing the panel. */}
      {operations.mounted && <Hideable hidden={!operations.open}>{slots.operations}</Hideable>}
      <DecisionRibbon entries={entries} renderReceipt={renderReceipt} name={projects.name} />
      {narrow
        ? <NarrowMatrix rows={rows} projects={projects} cell={cell} mounted={mounted} onCell={onCell} />
        : <WideMatrix rows={rows} projects={projects} cell={cell} mounted={mounted} wide={width >= 900} onCell={onCell} />}
      {slots.history}
      <div style={{ ...column, gap: space[3] }}>
        <div style={row}>
          <Button variant="ghost" size="sm" expanded={progress.open}
            label={progress.open ? t("세션 진행 접기", "Hide session progress") : t("세션 진행 전체 보기", "Show all session progress")}
            onPress={() => setProgress(state => ({ open: !state.open, mounted: true }))} />
        </div>
        {progress.mounted && <Hideable hidden={!progress.open}>{slots.progress}</Hideable>}
      </div>
    </div>
  </div>;
}

// Keeps children mounted (a draft inside survives) while taking them off screen and out of screen readers.
function Hideable({ hidden, style, children }: { hidden: boolean; style?: CSSProperties; children: ReactNode }) {
  return <div aria-hidden={hidden || undefined} style={{ ...column, ...style, ...(hidden ? { display: "none" } : null) }}>{children}</div>;
}

function DecisionRibbon({ entries, renderReceipt, name }: {
  entries: readonly DecisionEntry[]; renderReceipt: BoardLayoutProps["renderReceipt"]; name: ProjectBundle["name"];
}) {
  const { t } = useBoardLanguage();
  const [selected, setSelected] = useState<string | null>(null);
  const active = ribbonEntries(entries);
  return <div style={{ ...column, gap: space[2] }}>
    <SectionLabel count={active.length}>{t("내 결정", "My decisions")}</SectionLabel>
    {active.length > 0
      ? <div className="scroll" style={{ ...row, flexWrap: "nowrap", alignItems: "stretch", gap: space[2], paddingBottom: space[1] }}>
        {active.map(entry => {
          const summary = entry.summary!;
          const chosen = entry.key === selected;
          const label = entry.label ?? decisionGroupLabel(summary.group, t);
          const project = summary.projectIds.map(name).join(", ");
          return <button key={entry.key} type="button" className="ribbon-card" aria-expanded={chosen}
            aria-label={[label, summary.title, project].join(" · ")} onClick={() => setSelected(chosen ? null : entry.key)}>
            <StatusBadge tone={summary.tone} label={label} />
            <span className="clamp2" style={{ fontSize: fontSize.base }}>{summary.title}</span>
            <ProjectText projects={summary.projectIds.filter(id => id !== null).map(name)} lines={1} className="muted sm">
              {summary.permission ? `${project} · ${t("세션에서 승인", "Approve in session")}` : project}
            </ProjectText>
          </button>;
        })}
      </div>
      : <p className="muted sm">{t("없음", "None")}</p>}
    {/* Every card stays mounted, shown or not, so a reply draft outlives a change of selection. */}
    {entries.map(entry => {
      const shown = entryDisplay(entry, selected);
      return <Hideable key={entry.key} hidden={!shown.card && !shown.receipts} style={{ gap: space[2] }}>
        {shown.receipts && entry.receipts.map(renderReceipt)}
        {shown.card && entry.summary?.permission && <p className="muted sm">
          {t("권한 요청은 세션에서 승인합니다. 보드는 이 세션에 메시지를 보내지 않습니다.", "Approve permission requests in the session. The board does not message this session.")}
        </p>}
        <Hideable hidden={!shown.card}>
          <article className="surface" style={{ ...column, gap: space[2], padding: space[4], borderRadius: "var(--r-xl)" }}>{entry.card}</article>
        </Hideable>
      </Hideable>;
    })}
  </div>;
}

function Mark({ mark }: { mark: MatrixMark }) {
  return mark === "running" ? <RunningMark /> : <StatusDot tone={mark} />;
}

function itemLabel(item: LaneItem, t: Translate) {
  const title = matrixTitle(item);
  return matrixPermission(item) ? `${title} · ${t("세션에서 승인", "Approve in session")}` : title;
}

function CellItems({ items, limit }: { items: readonly LaneItem[]; limit: number }) {
  const { t } = useBoardLanguage();
  if (!items.length) return <span className="muted sm">{t("없음", "None")}</span>;
  const { shown, more } = cellPreview(items, limit);
  return <>
    {shown.map(item => {
      const mark = matrixMark(item);
      return <span key={item.key} style={{ ...row, flexWrap: "nowrap", gap: space[1.5], width: "100%" }}>
        <Mark mark={mark} />
        <span className={mark === "idle" ? "muted sm ellipsis" : "sm ellipsis"} style={{ flex: 1 }}>{itemLabel(item, t)}</span>
      </span>;
    })}
    {more > 0 && <span className="muted sm">+{more}</span>}
  </>;
}

function CellButton({ row: line, column: lane, cell, onCell, limit, style }: {
  row: MatrixRow; column: MatrixColumn; cell: CellRef | null; onCell: (next: CellRef) => void; limit: number; style?: CSSProperties;
}) {
  const { t } = useBoardLanguage();
  const items = line.cells[lane];
  const selected = isSelectedCell(cell, line.key, lane);
  return <button type="button" className="cell-button" aria-label={`${line.title} · ${matrixColumnLabel(lane, t)} ${items.length}`}
    aria-expanded={selected} disabled={!items.length} onClick={() => onCell({ row: line.key, column: lane })} style={style}>
    <CellItems items={items} limit={limit} />
  </button>;
}

function ItemCard({ item, projectId, projects }: { item: LaneItem; projectId: string | null; projects: ProjectBundle }) {
  if (item.kind === "record") return <>{projects.renderRecord(item.item)}</>;
  if (item.kind === "pull") return <>{projects.renderPull(item.pr, projectId ?? "")}</>;
  return <CardView card={item.card} open={projects.open} sessionHostLabel={projects.hostLabel} />;
}

function CellDrawer({ row: line, column: lane, projects, wide }: { row: MatrixRow; column: MatrixColumn; projects: ProjectBundle; wide: boolean }) {
  const { t } = useBoardLanguage();
  const items = line.cells[lane];
  return <div className="table-head" style={{ ...column, gap: space[3], padding: space[4] }}>
    <SectionLabel count={items.length}>{`${line.title} · ${matrixColumnLabel(lane, t)}`}</SectionLabel>
    <div style={{ display: "flex", flexDirection: wide ? "row" : "column", flexWrap: "wrap", gap: space[3] }}>
      {items.map(item => <div key={item.key} style={wide ? { flex: "1 1 320px", minWidth: 0 } : undefined}>
        <ItemCard item={item} projectId={line.id} projects={projects} />
      </div>)}
    </div>
  </div>;
}

const projectColumn = 180;
const hostColumn = 96;

function HeaderMark({ column: lane }: { column: MatrixColumn }) {
  return <StatusDot tone={lane === "human" ? "warning" : lane === "done" ? "success" : lane === "idle" ? "idle" : "muted"} />;
}

function WideMatrix({ rows, projects, cell, mounted, onCell, wide }: {
  rows: readonly MatrixRow[]; projects: ProjectBundle; cell: CellRef | null; mounted: readonly CellRef[]; onCell: (next: CellRef) => void; wide: boolean;
}) {
  const { t } = useBoardLanguage();
  const headCell: CSSProperties = { ...row, flexWrap: "nowrap", gap: space[1.5], padding: `${space[2]}px ${space[3]}px` };
  const head = "sm ellipsis muted";
  return <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
    <div role="row" className="table-head" style={{ display: "flex" }}>
      <div style={{ ...headCell, width: projectColumn, flex: "none" }}><span className={head} style={{ fontWeight: 500 }}>{t("프로젝트", "Project")}</span></div>
      {matrixColumns.map(lane => <div key={lane} style={{ ...headCell, flex: 1, minWidth: 0 }}>
        <HeaderMark column={lane} /><span className={head} style={{ fontWeight: 500 }}>{matrixColumnLabel(lane, t)}</span>
      </div>)}
      <div style={{ ...headCell, width: hostColumn, flex: "none" }}><span className={head} style={{ fontWeight: 500 }}>{t("호스트", "Host")}</span></div>
    </div>
    {!rows.length && <div style={{ padding: space[3], borderTop: "1px solid var(--border)" }}>
      <p className="muted sm">{t("표시할 프로젝트가 없습니다.", "No projects to show.")}</p>
    </div>}
    {rows.map(line => <div key={line.key} style={{ borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex" }}>
        <div style={{ width: projectColumn, flex: "none", padding: space[3], minWidth: 0 }}>
          <ProjectText projectId={line.id ?? undefined} projects={line.id === null ? [] : [line.title]} className={line.id === null ? "muted clamp2" : "clamp2"}>
            <span role="heading" aria-level={3}>{line.title}</span>
          </ProjectText>
        </div>
        {matrixColumns.map(lane => <CellButton key={lane} row={line} column={lane} cell={cell} onCell={onCell} limit={3} style={{ flex: 1 }} />)}
        <div style={{ width: hostColumn, flex: "none", padding: space[3] }}>
          <span className="muted sm">{hostSummary(line.hosts)}</span>
        </div>
      </div>
      {/* A cell opened once keeps its cards mounted, hidden while closed, so a reply draft survives. */}
      {mountedColumns(mounted, line.key).map(lane => <Hideable key={lane} hidden={!isSelectedCell(cell, line.key, lane)}>
        <CellDrawer row={line} column={lane} projects={projects} wide={wide} />
      </Hideable>)}
    </div>)}
  </div>;
}

function NarrowMatrix({ rows, projects, cell, mounted, onCell }: {
  rows: readonly MatrixRow[]; projects: ProjectBundle; cell: CellRef | null; mounted: readonly CellRef[]; onCell: (next: CellRef) => void;
}) {
  const { t } = useBoardLanguage();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpen(current => {
    const next = new Set(current);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  if (!rows.length) return <p className="muted sm">{t("표시할 프로젝트가 없습니다.", "No projects to show.")}</p>;
  return <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
    {rows.map((line, index) => {
      const expanded = open.has(line.key);
      const summary = matrixSummary(line.cells, t);
      const filled = matrixColumns.filter(lane => line.cells[lane].length);
      const kept = mountedColumns(mounted, line.key);
      return <div key={line.key} style={index ? { borderTop: "1px solid var(--border)" } : undefined}>
        <button type="button" className="cell-button" aria-expanded={expanded} aria-label={`${line.title} · ${summary}`} onClick={() => toggle(line.key)}
          style={{ ...row, flexWrap: "nowrap", width: "100%", gap: space[2], background: "transparent" }}>
          <span style={{ ...column, flex: 1, minWidth: 0, gap: space[0.5] }}>
            <ProjectText projectId={line.id ?? undefined} projects={line.id === null ? [] : [line.title]} lines={1} className={line.id === null ? "muted" : undefined}>{line.title}</ProjectText>
            <span className="muted sm ellipsis">{summary}</span>
          </span>
          <span aria-hidden="true" className="muted">{expanded ? "▴" : "▾"}</span>
        </button>
        {(expanded || kept.length > 0) && <Hideable hidden={!expanded} style={{ gap: space[3], padding: `0 ${space[3]}px ${space[3]}px` }}>
          {line.hosts.length > 0 && <p className="muted sm">{t("호스트", "Host")} · {hostSummary(line.hosts)}</p>}
          {!filled.length && <p className="muted sm">{t("없음", "None")}</p>}
          {filled.map(lane => <div key={lane} style={{ ...column, gap: space[1] }}>
            <SectionLabel count={line.cells[lane].length}>{matrixColumnLabel(lane, t)}</SectionLabel>
            <CellButton row={line} column={lane} cell={cell} onCell={onCell} limit={Infinity} style={{ borderRadius: "var(--r-lg)" }} />
            {kept.includes(lane) && <Hideable hidden={!isSelectedCell(cell, line.key, lane)} style={{ gap: space[3] }}>
              {line.cells[lane].map(item => <ItemCard key={item.key} item={item} projectId={line.id} projects={projects} />)}
            </Hideable>}
          </div>)}
        </Hideable>}
      </div>;
    })}
  </div>;
}
