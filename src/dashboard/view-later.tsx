/** @jsxImportSource react */
// Focus and Matrix keep their place in the view switch; their bodies arrive in a later phase.
import type { BoardLayoutProps } from "./board-layout";
import { column, space } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export function LaterView({ compact, slots }: BoardLayoutProps) {
  const { t } = useBoardLanguage();
  return <div className="scroll" style={{ flex: 1 }}>
    <div style={{ ...column, gap: space[4], padding: compact ? space[3] : space[6] }}>
      {slots.filters}
      {slots.notices}
      <p className="muted">{t("다음 단계에서 제공합니다.", "Coming in a later phase.")}</p>
    </div>
  </div>;
}
