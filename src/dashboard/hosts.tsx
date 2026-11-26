/** @jsxImportSource react */
// Paseo's BoardHosts (client/hosts.tsx) in settings mode, cut to a list: the Orca worker reports the hosts it
// knows through board.hosts, and a worker without that method shows no card. Hiding hosts and browsing a
// host's sessions need a peer session API that Orca plugins do not have.
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { call } from "./rpc";
import { Button, column, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export { boardHosts } from "../contract";
import { boardHosts } from "../contract";
type Host = z.output<typeof boardHosts.output>["hosts"][number];

const statusText: Record<Host["status"], [string, string]> = {
  online: ["연결됨", "Online"], connecting: ["연결 중", "Connecting"], idle: ["연결 대기", "Idle"],
  offline: ["연결 끊김", "Offline"], error: ["연결 오류", "Connection error"], unknown: ["연결 미확인", "Connection unknown"],
};
const tone: Record<Host["status"], string> = {
  online: "var(--success)", connecting: "var(--working)", idle: "var(--muted-fg)", offline: "var(--muted-fg)", error: "var(--destructive)", unknown: "var(--muted-fg)",
};
const unsupported = (error: unknown) => /unknown[_ ]method|no handler|not (?:registered|found)/i.test(error instanceof Error ? error.message : String(error));

export function BoardHosts() {
  const { t } = useBoardLanguage();
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error" | "unsupported">("loading");
  const generation = useRef(0);
  async function load() {
    const seq = ++generation.current;
    setState("loading");
    try {
      const result = await call(boardHosts, {});
      if (seq === generation.current) { setHosts(result.hosts); setState("ready"); }
    } catch (error) {
      if (seq === generation.current) setState(unsupported(error) ? "unsupported" : "error");
    }
  }
  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, []);
  if (state === "unsupported") return null;
  return <section className="surface" style={{ ...column, gap: 8, padding: 14, borderRadius: "var(--r-xl)" }}>
    <div style={{ ...row, justifyContent: "space-between", gap: 8 }}>
      <span role="heading" aria-level={2} style={{ fontSize: 17, lineHeight: "24px", fontWeight: 600 }}>{t("Orca 호스트", "Orca hosts")}</span>
      {hosts && <span className="muted">{t(`앱에 등록 ${hosts.length}대`, `Registered hosts: ${hosts.length}`)}</span>}
    </div>
    <p className="muted">{t("이 보드가 아는 Orca 호스트입니다. 보드는 지금 보는 호스트의 세션만 모읍니다.", "Orca hosts this board knows about. The board gathers sessions from the current host only.")}</p>
    {state === "loading" && <p role="status" className="muted">{t("호스트를 확인하고 있습니다.", "Loading hosts…")}</p>}
    {state === "error" && <div style={{ ...row, gap: 8 }}>
      <p role="status" className="danger">{t("호스트 목록을 읽지 못했습니다.", "Could not load hosts.")}</p>
      <Button size="sm" label={t("호스트 다시 읽기", "Reload hosts")} onPress={() => void load()} />
    </div>}
    {state === "ready" && hosts && !hosts.length && <p className="muted">{t("등록된 호스트가 없습니다.", "No registered hosts.")}</p>}
    {state === "ready" && hosts?.map(host => <div key={host.id} style={{ ...row, flexWrap: "nowrap", gap: 8, paddingTop: 7, borderTop: "1px solid var(--border)" }}>
      <span className="state-dot" aria-hidden="true" style={{ background: tone[host.status], flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
        {host.label}{host.current ? t(" · 현재 보드", " · Current board") : ""} · <span className="muted">{t(...statusText[host.status])}</span>
      </span>
    </div>)}
  </section>;
}
