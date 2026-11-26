/** @jsxImportSource react */
// Paseo's session progress header and "all running" list (client/session-progress.tsx). This host only:
// Orca has no peer hosts to poll.
import type { ReactNode } from "react";
import { z } from "zod";
import type { Card } from "../paseo/client/model";
import { defineSettings } from "../paseo/plugin-shim";
import type { OpenSession } from "./cards";
import { useDeviceSetting } from "./device-setting";
import type { ProjectId } from "./board-model";
import { Button, column, ProjectText, row, RunningMark, SessionChip } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

const progressSetting = defineSettings({
  id: "session-progress-view", scope: "device", version: 1,
  schema: z.object({ mode: z.enum(["projects", "running"]).default("projects") }),
});

export function SessionProgress({ cards, hostLabel, projectName, open, children }: {
  cards: Card[]; hostLabel: string; projectName: (id: ProjectId) => string; open: OpenSession; children: ReactNode;
}) {
  const { t } = useBoardLanguage();
  const saved = useDeviceSetting(progressSetting);
  const current = saved.values.mode;
  const select = (mode: "projects" | "running") => { if (!saved.saving && mode !== current) void saved.save({ mode }); };
  const rows = current === "running" ? cards.filter(card => card.lane === "running").map(({ session }) => session)
    .sort((a, b) => (Date.parse(b.activityAt ?? "") || 0) - (Date.parse(a.activityAt ?? "") || 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)) : [];
  const count = cards.filter(card => card.lane === "running").length;
  return <div style={{ ...column, gap: 12 }}>
    <div style={{ ...row, justifyContent: "space-between", gap: 8 }}>
      <span role="heading" aria-level={2} style={{ fontWeight: 500 }}>{t("세션 진행", "Session progress")}</span>
      <div style={{ ...row, gap: 5 }}>
        <Button size="sm" label={t("프로젝트별", "By project")} selected={current === "projects"} disabled={saved.saving} onPress={() => select("projects")} />
        <Button size="sm" label={t(`진행 중 모아보기 · ${count}`, `All running · ${count}`)} selected={current === "running"} disabled={saved.saving} onPress={() => select("running")} />
      </div>
    </div>
    {saved.saveFailed && <p role="status" className="warn">{t("현재 보기를 이 기기에 저장하지 못했습니다.", "Could not save this view on this device.")}</p>}
    {current === "projects" ? children : <>
      {rows.length > 0 && <div className="surface" style={{ borderRadius: "var(--r-md)", padding: "0 12px" }}>
        {rows.map((session, index) => {
          const title = session.title || t(`세션 ${session.id.slice(0, 8)}`, `Session ${session.id.slice(0, 8)}`);
          const project = projectName(session.projectId);
          return <div key={session.id} style={{ ...row, flexWrap: "nowrap", gap: 8, padding: "9px 0", borderTop: index ? "1px solid var(--border)" : undefined }}>
            <RunningMark />
            <div style={{ ...column, flex: 1, gap: 3, minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>{title}</span>
              <ProjectText projectId={session.projectId} projects={[project]} className="muted sm">{project} · {hostLabel}</ProjectText>
            </div>
            <SessionChip label={t("세션 열기", "Open session")} accessibilityLabel={`${t(`세션 열기 · ${title}`, `Open session · ${title}`)} · ${project} · ${hostLabel}`} onPress={() => open(session.id)} />
          </div>;
        })}
      </div>}
      {!count && <p className="muted">{t("선택한 프로젝트에 진행 중인 세션이 없습니다.", "No running sessions in the selected projects.")}</p>}
    </>}
  </div>;
}
