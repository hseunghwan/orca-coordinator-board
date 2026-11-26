/** @jsxImportSource react */
// Paseo's focus queue (client/view-focus.tsx): one decision at a time in a centred column, with the rest of
// the queue kept mounted behind it and a strip of running work along the bottom.
import { useEffect, useRef, useState } from "react";
import { decisionGroupLabel } from "../paseo/client/decision-row";
import {
  deferFocus, focusKeyAction, focusNeedsEmptyNotice, focusProgress, focusRail, isProcessed, railCell, resolveFocus, stepFocus,
  type FocusKeyAction, type RailCell,
} from "../paseo/client/focus-queue";
import { focusActivity, runningMarks } from "../paseo/client/focus-status";
import type { Tone } from "../paseo/client/tone";
import type { Translate } from "../paseo/view-types";
import type { BoardLayoutProps, DecisionEntry } from "./board-layout";
import { useWidth } from "./use-width";
import { Button, column, fontSize, ProjectText, row, RunningMark, SectionLabel, space, StatusBadge, StatusDot } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export function FocusView(props: BoardLayoutProps) {
  const { compact, entries, renderReceipt, slots, projects } = props;
  const { t } = useBoardLanguage();
  const [box, width] = useWidth();
  const narrow = compact || (width > 0 && width < 600);
  const pad = narrow ? space[3] : space[6];

  // "Later" lasts for this visit only, so it lives in component state and is never saved.
  const [deferred, setDeferred] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const lastQueue = useRef<string[]>([]);
  const rail = focusRail(entries, deferred);
  const queue = rail.filter(entry => entry.row !== null).map(entry => entry.key);
  const current = resolveFocus(chosen, lastQueue.current, queue);
  useEffect(() => {
    lastQueue.current = queue;
    if (current !== chosen) setChosen(current);
  });

  const [operationsOpen, setOperationsOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);

  const index = current === null ? -1 : queue.indexOf(current);
  const act = (action: FocusKeyAction) => {
    if (action === "next") setChosen(stepFocus(queue, current, 1));
    else if (action === "previous") setChosen(stepFocus(queue, current, -1));
    else if (queue.length > 1) {
      const result = deferFocus(entries, deferred, current);
      setDeferred(result.deferred);
      setChosen(result.current);
    }
  };
  const latest = useRef(act);
  latest.current = act;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = focusKeyAction({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey,
        defaultPrevented: event.defaultPrevented, target: target && { tagName: target.tagName, isContentEditable: target.isContentEditable } });
      if (!action) return;
      event.preventDefault();
      latest.current(action);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const byKey = new Map(entries.map(entry => [entry.key, entry]));
  const currentEntry = current === null ? undefined : byKey.get(current);
  const nextEntry = index < 0 ? undefined : byKey.get(queue[index + 1] ?? "");
  const progress = focusProgress(rail, current);
  const processed = entries.filter(isProcessed);
  const projectLine = (entry: DecisionEntry) => [...new Set(entry.summary?.projectIds.map(projects.name) ?? [])].join(", ");
  const projectIcons = (entry: DecisionEntry) => entry.summary?.projectIds.filter(id => id !== null).map(projects.name) ?? [];
  const approve = t("세션에서 승인", "Approve in session");
  const emptyNotice = focusNeedsEmptyNotice({ queue, total: props.total, filtered: props.filtered, filteredTotal: props.filteredTotal, incomplete: props.incomplete });

  return <div ref={box} style={{ ...column, flex: 1, minHeight: 0 }}>
    <div className="scroll" style={{ flex: 1 }}>
      <div style={{ ...column, alignItems: "center", padding: pad }}>
        <div style={{ ...column, width: "100%", maxWidth: 720, gap: space[4] }}>
          <div style={{ ...column, gap: space[2] }}>
            <div style={{ ...row, alignItems: "flex-start", gap: space[2] }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>{slots.filters}</div>
              <Button variant="secondary" size="sm" label={t("코디네이터에 요청", "Ask the coordinator")} expanded={operationsOpen}
                onPress={() => setOperationsOpen(open => !open)} />
            </div>
            {operationsOpen && slots.operations}
            {rail.length > 0 && <div style={{ ...row, flexWrap: "nowrap", gap: space[3] }}>
              <div aria-hidden="true" style={{ ...row, flexWrap: "nowrap", flex: 1, gap: space[1] }}>
                {rail.map(entry => <RailMark key={entry.key} cell={railCell(entry, current)} tone={entry.summary?.tone ?? "muted"} />)}
              </div>
              <span aria-live="polite" className="muted sm" style={{ whiteSpace: "nowrap" }}>
                {progress.position === null
                  ? t(`처리 ${progress.processed}건`, `${progress.processed} done`)
                  : t(`${progress.position} / ${progress.total} · 처리 ${progress.processed}건`, `${progress.position} of ${progress.total} · ${progress.processed} done`)}
              </span>
            </div>}
          </div>

          {slots.notices}
          {emptyNotice && <p className="muted">{t("지금 결정할 일이 없습니다.", "No decisions are waiting for you.")}</p>}

          <div className={currentEntry ? "surface" : undefined}
            style={currentEntry ? { ...column, gap: space[4], padding: narrow ? space[3] : space[6], borderRadius: "var(--r-xl)" } : undefined}>
            {currentEntry?.summary && <div style={{ ...row, gap: space[2] }}>
              <StatusBadge tone={currentEntry.summary.tone} label={currentEntry.label ?? decisionGroupLabel(currentEntry.summary.group, t)} />
              {!!projectLine(currentEntry) && <ProjectText projects={projectIcons(currentEntry)} lines={1} className="muted sm">{projectLine(currentEntry)}</ProjectText>}
              {currentEntry.summary.permission && <span className="sm" style={{ color: "var(--warning-text)" }}>{approve}</span>}
            </div>}
            {currentEntry?.receipts.map(renderReceipt)}
            {/* Every card stays mounted so a half-written reply survives moving to another decision. */}
            {entries.map(entry => entry.card && <div key={entry.key} style={entry.key === current ? undefined : { display: "none" }}>{entry.card}</div>)}
          </div>

          {currentEntry && <div style={{ ...column, gap: space[2] }}>
            <div style={{ ...row, gap: space[2] }}>
              <Button variant="ghost" size="sm" label={t("이전", "Previous")} disabled={index <= 0} onPress={() => act("previous")} />
              <Button variant="ghost" size="sm" label={t("나중에", "Later")} disabled={queue.length < 2} onPress={() => act("defer")} />
              {!narrow && <span className="muted sm">{t("J 다음 · K 이전 · S 나중에", "J next · K previous · S later")}</span>}
              <div style={{ flex: 1 }} />
              <Button variant="ghost" label={t("다음", "Next")} disabled={index < 0 || index >= queue.length - 1} onPress={() => act("next")} />
            </div>
            {nextEntry?.summary && <div style={{ ...column, gap: space[1] }}>
              <SectionLabel>{t("다음 차례", "Up next")}</SectionLabel>
              <div style={{ ...row, flexWrap: "nowrap", gap: space[2] }}>
                <StatusDot tone={nextEntry.summary.tone} />
                <span className="muted sm ellipsis">
                  {[nextEntry.summary.title, projectLine(nextEntry), nextEntry.summary.permission ? approve : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
            </div>}
          </div>}

          {processed.length > 0 && <div style={{ ...column, gap: space[1] }}>
            <SectionLabel count={processed.length}>{t("처리한 결정", "Handled decisions")}</SectionLabel>
            {processed.flatMap(entry => entry.receipts.map(renderReceipt))}
          </div>}

          {progressOpen && <div style={{ ...column, gap: space[4] }}>
            {slots.progress}
            {slots.history}
          </div>}
        </div>
      </div>
    </div>
    <ActivityStrip props={props} pad={pad} open={progressOpen} onToggle={() => setProgressOpen(open => !open)} t={t} />
  </div>;
}

function RailMark({ cell, tone }: { cell: RailCell; tone: Tone }) {
  const status = tone === "danger" ? "var(--destructive)" : tone === "warning" ? "var(--warning)" : "var(--border)";
  const fill = cell === "done" ? "var(--success)" : cell === "current" ? "var(--fg)"
    : cell === "waiting" ? `color-mix(in oklab, ${status} 16%, transparent)` : "var(--muted)";
  return <span style={{ flex: 1, height: 4, borderRadius: 2, background: fill, boxSizing: "border-box",
    border: cell === "waiting" ? `1px solid ${status}` : undefined }} />;
}

// Orca has no peer hosts, so only this device's running sessions count.
function ActivityStrip({ props, pad, open, onToggle, t }: { props: BoardLayoutProps; pad: number; open: boolean; onToggle: () => void; t: Translate }) {
  const { projects } = props;
  const activity = focusActivity(projects.list, [], projects.name);
  return <div style={{ ...row, flexWrap: "nowrap", gap: space[3], padding: `${space[2]}px ${pad}px`, borderTop: "1px solid var(--border)", background: "var(--bg)" }}>
    <div style={{ ...row, flex: 1, minWidth: 0, columnGap: space[4], rowGap: space[1] }}>
      <SectionLabel count={activity.running}>{t("진행 중", "Running")}</SectionLabel>
      {activity.projects.map(project => {
        const { marks, extra } = runningMarks(project.running);
        return <span key={project.id} role="group" aria-label={[project.name, t(`진행 중 ${project.running}`, `${project.running} running`),
          project.attention ? t("확인 대기 또는 오류", "Needs review or failed") : ""].filter(Boolean).join(" · ")}
          style={{ ...row, flexWrap: "nowrap", gap: space[1] }}>
          <ProjectText projectId={project.id} projects={[project.name]} lines={1} style={{ fontSize: fontSize.sm, maxWidth: 160 }}>{project.name}</ProjectText>
          {Array.from({ length: marks }, (_, i) => <RunningMark key={i} />)}
          {extra > 0 && <span className="muted sm">+{extra}</span>}
          {project.attention && <StatusDot tone="danger" />}
        </span>;
      })}
    </div>
    <Button variant="ghost" size="sm" label={open ? t("진행 닫기", "Hide progress") : t("진행 보기", "Show progress")} expanded={open} onPress={onToggle} />
  </div>;
}
