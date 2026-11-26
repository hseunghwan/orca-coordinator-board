/** @jsxImportSource react */
// Paseo's TrackedSessionChips and VerifiedSessionChip (client/tracked-session-chips.tsx,
// client/verified-session-chip.tsx). Orca checks a session by asking the worker to open it, so verify
// both checks and opens, and the chip shows the result of that one call.
import { useEffect, useRef, useState } from "react";
import { column, SessionChip } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export type TrackedSessionLinks = {
  owner?: { id: string; open: () => void; verify?: () => Promise<boolean> };
  source?: () => void;
};

type ChipProps = { label: string; accessibilityLabel: string; onPress: () => void; verify?: () => Promise<boolean> };

export function VerifiedSessionChip({ verify, ...props }: ChipProps) {
  const { t } = useBoardLanguage();
  const [state, setState] = useState<"ready" | "checking" | "failed">("ready");
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!verify) return <SessionChip {...props} />;
  async function visit() {
    if (!verify || pending.current) return;
    pending.current = true;
    setState("checking");
    try {
      const opened = await verify();
      if (active.current) setState(opened ? "ready" : "failed");
    } catch {
      if (active.current) setState("failed");
    } finally { pending.current = false; }
  }
  return <span style={{ ...column, maxWidth: "100%", gap: 2 }}>
    <SessionChip {...props} onPress={() => void visit()} />
    {state !== "ready" && <span role="status" className="muted sm">{state === "checking"
      ? t("세션 확인 중…", "Checking session…") : t("이 호스트에서 세션 연결을 확인하지 못했습니다.", "Could not verify this session on its host.")}</span>}
  </span>;
}

export function TrackedSessionChips({ links, title }: { links: TrackedSessionLinks; title: string }) {
  const { t } = useBoardLanguage();
  const { owner, source } = links;
  return <>
    {owner && <VerifiedSessionChip key={owner.id} label={t("운영 코디네이터", "Operating coordinator")}
      accessibilityLabel={title + " · " + t("운영 코디네이터 세션 열기", "Open operating coordinator session")}
      onPress={owner.open} verify={owner.verify} />}
    {source && <SessionChip label={owner ? t("원래 작업 세션", "Source work session") : t("연결 세션", "Linked session")}
      accessibilityLabel={title + " · " + (owner ? t("원래 작업 세션 열기", "Open source work session") : t("연결된 세션 열기", "Open linked session"))} onPress={source} />}
  </>;
}
