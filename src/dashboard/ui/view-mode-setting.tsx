/** @jsxImportSource react */
// Paseo's board view switch (client/view-mode-setting.tsx), saved per device.
import { boardViewDescription, boardViewLabel, boardViewModes, boardViewSetting, type BoardViewMode } from "../../paseo/client/view-mode";
import { useDeviceSetting } from "../device-setting";
import { column, SectionLabel, SegmentedControl, space } from "./controls";
import { useBoardLanguage } from "./language";

export function useBoardViewMode() {
  const saved = useDeviceSetting(boardViewSetting);
  const mode = saved.values.mode;
  async function select(next: BoardViewMode) {
    if (saved.saving || next === mode) return;
    await saved.save({ mode: next });
  }
  return { mode, select, saving: saved.saving, saveFailed: saved.saveFailed };
}
export type BoardViewState = ReturnType<typeof useBoardViewMode>;

export function BoardViewSwitch({ view }: { view: BoardViewState }) {
  const { t } = useBoardLanguage();
  return <SegmentedControl accessibilityLabel={t("보드 보기", "Board view")} value={view.mode} disabled={view.saving}
    options={boardViewModes.map(id => ({ id, label: boardViewLabel(id, t) }))} onChange={id => void view.select(id)} />;
}

export function BoardViewSetting({ view }: { view: BoardViewState }) {
  const { t } = useBoardLanguage();
  return <div style={{ ...column, gap: space[2] }}>
    <SectionLabel>{t("보드 보기", "Board view")}</SectionLabel>
    <BoardViewSwitch view={view} />
    <p className="muted sm">{boardViewDescription(view.mode, t)}</p>
    {view.saveFailed && <p role="status" className="warn sm">{t("보기 설정을 이 기기에 저장하지 못했습니다.", "Could not save the view on this device.")}</p>}
  </div>;
}
