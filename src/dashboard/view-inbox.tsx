/** @jsxImportSource react */
// Paseo's mail-style inbox (client/view-inbox.tsx): urgency-grouped list on the left, the chosen decision
// on the right. Every card stays mounted and hidden while unselected, so a draft survives moving around.
import { useEffect, useRef, useState } from "react";
import {
  activeDecisionCount, inboxKeyStep, inboxOrder, inboxRow, inboxRowAccessibilityLabel, inboxSectionLabel, inboxSections,
  isNarrowInbox, keepSelection, stepSelection, type InboxRow, type InboxTab, type KeyTarget,
} from "../paseo/client/inbox";
import type { BoardLayoutProps, DecisionEntry } from "./board-layout";
import { useWidth } from "./use-width";
import { Button, column, ProjectText, row, SectionLabel, SegmentedControl, space, StatusDot } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

const listWidth = 352;

function InboxListRow({ row: item, projectNames, selected, onPress }: { row: InboxRow; projectNames: string[]; selected: boolean; onPress: () => void }) {
  return <button type="button" className="list-row" aria-selected={selected} aria-label={inboxRowAccessibilityLabel(item)} onClick={onPress}>
    <span style={{ marginTop: 5 }}><StatusDot tone={item.tone} /></span>
    <span style={{ ...column, flex: 1, minWidth: 0, gap: space[0.5] }}>
      <span style={{ ...row, flexWrap: "nowrap", gap: space[2] }}>
        <span className="ellipsis" style={{ flex: 1 }}>{item.title}</span>
        {item.aside && <span className="muted sm" style={{ whiteSpace: "nowrap" }}>{item.aside}</span>}
      </span>
      <ProjectText projects={projectNames} lines={1} className="muted sm">{item.meta}</ProjectText>
    </span>
  </button>;
}

export function InboxView({ compact, entries, slots, projects }: BoardLayoutProps) {
  const { t } = useBoardLanguage();
  const [tab, setTab] = useState<InboxTab>("decisions");
  const [box, width] = useWidth();
  const [requesting, setRequesting] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  const sections = inboxSections(entries);
  const order = inboxOrder(sections);
  const lastOrder = useRef<readonly string[]>(order);
  const selected = keepSelection(lastOrder.current, order, chosen);
  useEffect(() => {
    lastOrder.current = order;
    if (selected !== chosen) setChosen(selected);
  });
  const selectedEntry: DecisionEntry | undefined = entries.find(entry => entry.key === selected);
  const narrow = isNarrowInbox(compact, width || null);
  const showDetail = narrow && detailOpen && !!selectedEntry;
  const pad = compact ? space[3] : space[6];
  const now = Date.now();

  const detail = useRef<HTMLDivElement>(null);
  useEffect(() => { detail.current?.scrollTo({ top: 0 }); }, [selected]);

  const step = useRef((_delta: -1 | 1) => {});
  step.current = delta => {
    const next = stepSelection(order, selected, delta);
    if (next !== null) setChosen(next);
  };
  const listening = tab === "decisions";
  useEffect(() => {
    if (!listening) return;
    const onKey = (event: KeyboardEvent) => {
      const delta = inboxKeyStep(event, event.target as KeyTarget);
      if (!delta) return;
      event.preventDefault();
      step.current(delta);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listening]);

  const empty = entries.length === 0;
  const permission = !!selectedEntry?.summary?.permission;
  const scrollBody = { ...column, padding: pad, gap: space[4] };

  return <div ref={box} style={{ ...column, flex: 1, minHeight: 0 }}>
    <div style={{ ...row, gap: space[2], padding: `${space[2]}px ${pad}px`, borderBottom: "1px solid var(--border)" }}>
      <SegmentedControl value={tab} onChange={setTab} accessibilityLabel={t("보드 구역", "Board sections")} options={[
        { id: "decisions", label: t(`결정 ${activeDecisionCount(entries)}`, `Decisions ${activeDecisionCount(entries)}`) },
        { id: "progress", label: t("진행", "Progress") },
        { id: "history", label: t("기록", "History") },
      ]} />
      <div style={{ flex: 1 }} />
      {tab === "decisions" && <Button variant="secondary" size="sm" expanded={requesting}
        label={t("코디네이터에 요청", "Ask the coordinator")} onPress={() => setRequesting(open => !open)} />}
    </div>

    {/* Hidden instead of unmounted: the request panel holds its own draft and photos. */}
    <div className="scroll" style={{ display: tab === "decisions" && requesting ? "flex" : "none", flexDirection: "column", maxHeight: "50%", borderBottom: "1px solid var(--border)" }}>
      <div style={scrollBody}>{slots.operations}</div>
    </div>

    <div style={{ flex: 1, minHeight: 0, display: tab === "decisions" ? "flex" : "none", flexDirection: narrow ? "column" : "row" }}>
      {empty ? <div className="scroll" style={{ flex: 1 }}><div style={scrollBody}>
        {slots.filters}
        {slots.notices}
        {slots.history}
      </div></div> : <>
        <div className="scroll" aria-label={t("결정 목록", "Decision list")}
          style={narrow ? { flex: 1, display: showDetail ? "none" : "block" } : { width: listWidth, flex: "none", borderRight: "1px solid var(--border)" }}>
          <div style={{ ...column, padding: space[2], gap: space[2] }}>
            {(slots.filters || slots.notices) && <div style={{ ...column, padding: space[1], gap: space[2] }}>
              {slots.filters}
              {slots.notices}
            </div>}
            {sections.map(section => <div key={section.id} style={{ ...column, gap: space[0.5] }}>
              <div style={{ padding: `${space[3]}px ${space[2]}px ${space[1]}px` }}>
                <SectionLabel count={section.entries.length}>{inboxSectionLabel(section.id, t)}</SectionLabel>
              </div>
              {section.entries.map(entry => <InboxListRow key={entry.key} selected={entry.key === selected}
                projectNames={(entry.summary?.projectIds ?? entry.receipts.at(-1)?.projectIds ?? []).filter(id => id !== null).map(projects.name)}
                row={inboxRow(entry, projects.name, t, now)} onPress={() => { setChosen(entry.key); setDetailOpen(true); }} />)}
            </div>)}
            {!narrow && <p className="muted sm" style={{ padding: space[2] }}>{t("J · K 키로 이전·다음 결정", "J · K for next and previous")}</p>}
          </div>
        </div>

        <div ref={detail} className="scroll" aria-label={t("결정 상세", "Decision detail")}
          style={narrow ? { flex: 1, display: showDetail ? "block" : "none" } : { flex: 1, minWidth: 0 }}>
          <div style={scrollBody}>
            {narrow && <div style={{ alignSelf: "flex-start" }}>
              <Button variant="ghost" size="sm" label={t("목록으로", "Back to list")} onPress={() => setDetailOpen(false)} />
            </div>}
            {permission && <p className="muted sm">{t("세션에서 승인: 이 세션은 권한 승인을 기다립니다. 보드는 권한을 기다리는 세션에 답장을 보내지 않으니 세션을 열어 승인하세요.",
              "Approve in session: this session is waiting for permission. The board does not send to a session that waits for permission, so open the session to approve.")}</p>}
            {entries.map(entry => entry.card === null ? null : <article key={entry.key} className="surface"
              style={{ display: entry.key === selected ? "flex" : "none", flexDirection: "column", gap: space[2], padding: compact ? space[3] : space[4], borderRadius: "var(--r-xl)" }}>
              {entry.card}
            </article>)}
            {!selectedEntry && <p className="muted sm">{t("목록에서 결정을 고르세요.", "Pick a decision from the list.")}</p>}
          </div>
        </div>
      </>}
    </div>

    <div className="scroll" style={{ flex: 1, display: tab === "progress" ? "block" : "none" }}>
      <div style={scrollBody}>{slots.progress ?? <p className="muted sm">{t("표시할 세션이 없습니다.", "No sessions to show.")}</p>}</div>
    </div>
    <div className="scroll" style={{ flex: 1, display: tab === "history" ? "block" : "none" }}>
      <div style={scrollBody}>{slots.history ?? <p className="muted sm">{t("아직 결정 기록이 없습니다.", "No decision activity yet.")}</p>}</div>
    </div>
  </div>;
}
