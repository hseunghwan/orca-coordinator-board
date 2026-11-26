/** @jsxImportSource react */
// Paseo's FactReplyControls (client/fact-reply-controls.tsx): the coordinator may answer a session's
// factual question about its project or status from what the board verified.
import { useEffect, useRef, useState } from "react";
import { factReplySettings, setFactAutoReply } from "../paseo/shared/board-facts";
import { call } from "./rpc";
import { Button, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export function FactReplyControls() {
  const { t } = useBoardLanguage();
  const mounted = useRef(false);
  const pending = useRef(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  async function refresh(next?: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (next !== undefined) await call(setFactAutoReply, { enabled: next });
      const settings = await call(factReplySettings, {});
      if (mounted.current) { setEnabled(settings.enabled); setFailed(false); }
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  return <>
    <p className="muted">{t("다이제스트를 요청하면 코디네이터가 보드에서 확인한 프로젝트 소속이나 세션 상태를 담당 세션에 알려 줍니다.", "When you request a digest, the coordinator can tell the assigned session its verified project or status.")}</p>
    <div style={row}>
      {failed ? <Button label={t("설정 다시 읽기", "Reload setting")} disabled={busy} onPress={() => void refresh()} />
        : <Button label={enabled === null ? t("설정 조회 중…", "Loading setting…") : enabled ? t("자동 답장 켜짐 · 끄기", "Automatic replies on · Turn off") : t("자동 답장 꺼짐 · 켜기", "Automatic replies off · Turn on")}
          selected={enabled === true} disabled={busy || enabled === null} onPress={() => void refresh(!enabled)} />}
    </div>
  </>;
}
