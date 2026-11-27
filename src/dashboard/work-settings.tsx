/** @jsxImportSource react */
// When tracked work counts as stale (board.work-settings): minutes idle since its phase began, and minutes without
// an answer to the board's done check. A worker without the method shows no card.
import { useEffect, useRef, useState } from "react";
import { boardWorkSettings, setWorkSettings, type WorkSettings } from "../contract";
import { call } from "./rpc";
import { Button, column, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

const unsupported = (error: unknown) => /unknown[_ ]method|no handler|not (?:registered|found)/i.test(error instanceof Error ? error.message : String(error));
const minutes = (text: string) => /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : NaN;

export function WorkSettingsCard() {
  const { t } = useBoardLanguage();
  const [saved, setSaved] = useState<WorkSettings | null>(null);
  const [idle, setIdle] = useState("");
  const [ask, setAsk] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error" | "unsupported">("loading");
  const generation = useRef(0);
  function show(value: WorkSettings) {
    setSaved(value);
    setIdle(String(value.idleMinutes));
    setAsk(String(value.askMinutes));
  }
  useEffect(() => {
    const seq = ++generation.current;
    call(boardWorkSettings, {}).then(value => { if (seq === generation.current) { show(value); setState("ready"); } },
      error => { if (seq === generation.current) setState(unsupported(error) ? "unsupported" : "error"); });
    return () => { generation.current++; };
  }, []);
  if (state === "unsupported") return null;
  const next = { idleMinutes: minutes(idle), askMinutes: minutes(ask) };
  const valid = [next.idleMinutes, next.askMinutes].every(value => value >= 5 && value <= 7 * 24 * 60);
  const dirty = !!saved && (next.idleMinutes !== saved.idleMinutes || next.askMinutes !== saved.askMinutes);
  async function save() {
    setState("saving");
    try { show(await call(setWorkSettings, next)); setState("ready"); }
    catch { setState("error"); }
  }
  const field = (label: [string, string], value: string, set: (text: string) => void) =>
    <label style={{ ...row, gap: 8 }}>
      <span style={{ minWidth: 0, flex: 1 }}>{t(...label)}</span>
      <input className="input" inputMode="numeric" style={{ width: 90 }} aria-label={t(...label)} value={value}
        disabled={state === "saving" || state === "loading"} onChange={event => set(event.target.value)} />
      <span className="muted">{t("분", "min")}</span>
    </label>;
  return <section className="surface" style={{ ...column, gap: 8, padding: 14, borderRadius: "var(--r-xl)" }}>
    <span role="heading" aria-level={2} style={{ fontSize: 17, lineHeight: "24px", fontWeight: 600 }}>{t("작업 방치 기준", "Stale work")}</span>
    <p className="muted">{t("보드가 배정한 작업이 이 시간 동안 멈춰 있거나 완료 확인에 답하지 않으면 방치로 표시하고 코디네이터에게 알립니다.",
      "Work the board assigned is marked stale, and the coordinator told, when it sits idle this long or leaves the done check unanswered.")}</p>
    {state === "loading" && <p role="status" className="muted">{t("기준을 읽고 있습니다.", "Loading…")}</p>}
    {saved && <>
      {field(["대기 시간", "Idle for"], idle, setIdle)}
      {field(["완료 확인 무응답", "No answer to the done check for"], ask, setAsk)}
      {!valid && <p role="status" className="danger">{t("5분에서 10080분 사이로 적어 주세요.", "Use 5 to 10080 minutes.")}</p>}
      <div><Button size="sm" label={state === "saving" ? t("저장 중…", "Saving…") : t("기준 저장", "Save")} disabled={!valid || !dirty || state === "saving"} onPress={() => void save()} /></div>
    </>}
    {state === "error" && <p role="status" className="danger">{t("작업 방치 기준을 읽거나 저장하지 못했습니다.", "Could not load or save the stale work settings.")}</p>}
  </section>;
}
