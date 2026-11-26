/** @jsxImportSource react */
// Focus and Matrix keep their place in the view switch; their bodies arrive in a later phase. The
// coordinator request opens here as it does in Paseo's Focus and Matrix headers.
import { useState } from "react";
import type { BoardLayoutProps } from "./board-layout";
import { Button, column, row, space } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export function LaterView({ compact, slots }: BoardLayoutProps) {
  const { t } = useBoardLanguage();
  const [requesting, setRequesting] = useState(false);
  return <div className="scroll" style={{ flex: 1 }}>
    <div style={{ ...column, gap: space[4], padding: compact ? space[3] : space[6] }}>
      <div style={{ ...row, gap: space[2], justifyContent: "flex-end" }}>
        <Button variant="secondary" size="sm" expanded={requesting} label={t("코디네이터에 요청", "Ask the coordinator")} onPress={() => setRequesting(open => !open)} />
      </div>
      <div style={{ display: requesting ? "block" : "none" }}>{slots.operations}</div>
      {slots.filters}
      {slots.notices}
      <p className="muted">{t("다음 단계에서 제공합니다.", "Coming in a later phase.")}</p>
    </div>
  </div>;
}
