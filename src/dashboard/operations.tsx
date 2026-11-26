/** @jsxImportSource react */
// Paseo's OperationsPanel (client/operations.tsx) on Orca. Normal mode is the coordinator composer, or the
// setup screen while the board has no coordinator; settings mode holds providers, usage, routing and the
// coordinator replacement.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { z } from "zod";
import { explainEmptyRoute } from "../paseo/client/route-options";
import { resolveRoute, type RouteChoice } from "../paseo/shared/dispatch";
import { askDigest, requestWork, setProviderInclusion, setWorkerMode, updateRouting } from "../paseo/shared/operations";
import { setUsageRouting } from "../paseo/shared/usage-routing";
import type { Translate } from "../paseo/view-types";
import { noRetry, retryKey, type RetryKey } from "./request-key";
import { FactReplyControls } from "./fact-reply-controls";
import { ProviderSettings } from "./providers";
import { RouteEditor } from "./route-editor";
import { UsageRouting } from "./usage-routing";
import { call, operations, startCoordinator } from "./rpc";
import { SendButton, SendTextInput } from "./send-input";
import { Button, column, row, SessionChip, space } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

type Operations = z.output<typeof operations.output>;
type Feedback = { tone: "ok" | "danger"; text: string; area: Area } | null;
type Area = "provider" | "usage" | "routing" | "coordinator";
type Delivery = "work" | "digest";

export type OperationsPanelProps = {
  settings: boolean; coordinator: string | null; configured: boolean; projects: readonly { id: string; title: string }[];
  refreshBoard: () => void; openCoordinator?: (id: string) => void;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const routeName = (route: RouteChoice | null, t: Translate) =>
  route ? [route.provider, route.model, route.effort].filter(Boolean).join(" / ") : t("사용 가능한 후보 없음", "No available candidate");
const wrap = { ...row, gap: 6 };

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return <section className="surface" style={{ ...column, gap: 10, padding: 14, borderRadius: "var(--r-xl)" }}>
    <div style={{ ...row, gap: space[2] }}>
      <span role="heading" aria-level={2} style={{ fontSize: 17, lineHeight: "24px", fontWeight: 600 }}>{title}</span>
      {aside}
    </div>
    {children}
  </section>;
}

export function OperationsPanel({ settings, coordinator, configured, projects, refreshBoard, openCoordinator }: OperationsPanelProps) {
  const { t, language } = useBoardLanguage();
  const [data, setData] = useState<Operations | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [text, setText] = useState("");
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [chosenWorkspace, setChosenWorkspace] = useState<string | null>(null);
  const live = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const delivery = useRef<Record<Delivery, RetryKey>>({ work: noRetry, digest: noRetry });

  const refresh = useCallback(async (setup: boolean, clearError = true) => {
    const token = ++generation.current;
    setLoading(true);
    try {
      const next = await call(operations, setup ? { view: "setup" } : {});
      if (live.current && token === generation.current) {
        setData(next);
        if (clearError) setFeedback(prior => prior?.tone === "danger" ? null : prior);
      }
    } catch (e) {
      if (live.current && token === generation.current) setFeedback({ tone: "danger", text: message(e), area: "provider" });
    } finally {
      if (live.current && token === generation.current) setLoading(false);
    }
  }, []);
  const needsModels = settings || (configured && !coordinator);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; generation.current++; };
  }, []);
  useEffect(() => { if (needsModels) void refresh(!settings); }, [needsModels, settings, refresh]);
  useEffect(() => {
    setConfirm(false);
    delivery.current = { work: noRetry, digest: noRetry };
  }, [coordinator]);
  useEffect(() => { setConfirm(false); setFeedback(null); }, [settings, language]);

  async function act<T>(run: () => Promise<T>, done: string, area: Area = "coordinator"): Promise<T | null> {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const value = await run();
      if (live.current) { refreshBoard(); setFeedback({ tone: "ok", text: done, area }); }
      return value;
    } catch (e) {
      if (live.current) setFeedback({ tone: "danger", text: message(e), area });
      return null;
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function post(kind: Delivery) {
    if (!coordinator || pending.current) return;
    const request = text.trim();
    if (kind === "work" && !request) return;
    const payload = JSON.stringify(kind === "digest" ? [coordinator, language] : [coordinator, request, []]);
    delivery.current[kind] = retryKey(delivery.current[kind], payload, "board");
    const input = { coordinator, requestKey: delivery.current[kind].key };
    const sent = await act(async () => {
      const result = kind === "digest" ? await call(askDigest, { ...input, language, handleBoardFacts: true })
        : await call(requestWork, { ...input, text: request });
      if (!result.ok) throw Error(t("전송을 확인하지 못했습니다. 다시 시도해 주세요.", "Delivery was not confirmed. Please retry."));
      return result;
    }, kind === "digest"
      ? t("다이제스트를 요청했습니다. 코디네이터 세션에서 답을 확인하세요.", "Digest requested. Open the coordinator session to read the response.")
      : t("첨부 없이 코디네이터에게 요청을 보냈습니다.", "Sent the request to the coordinator without attachments."));
    if (sent && live.current) {
      delivery.current[kind] = noRetry;
      if (kind === "work") { setText(""); setEditorExpanded(false); }
    }
  }

  if (!settings && !configured && !coordinator) return null;
  const model = data && resolveRoute("M", data.routing, data.catalog, false, data.usageRouting ? data.usage : undefined);
  const mode = data?.coordinatorMode;
  const modeText = mode ? t(`도구 권한 · ${mode.label}`, `Tool permissions · ${mode.label}`)
    : t("권한 모드를 확인할 수 없습니다. 실행기와 모델을 새로 고쳐 주세요.", "Permission mode unavailable. Refresh providers and models.");
  const workspaces = data?.workspaces ?? [];
  const startIn = workspaces.find(w => w.id === chosenWorkspace) ?? workspaces.find(w => w.focused) ?? workspaces[0];
  const projectTitle = (id: string) => projects.find(project => project.id === id)?.title;

  function connect() {
    if (!model || !mode || !configured) return;
    void act(() => call(startCoordinator, {
      expectedCoordinator: coordinator, replace: !!coordinator, expectedRoute: model, expectedModeId: mode.id, ...(startIn && { workspaceId: startIn.id }),
    }), t("운영 세션을 연결했습니다.", "Coordinator session connected.")).then(result => {
      if (result && live.current) setConfirm(false);
    });
  }

  const feedbackNode = feedback && <p role="status" className={feedback.tone} style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{feedback.text}</p>;
  const feedbackIn = (area: Area) => feedback?.area === area && feedbackNode;
  async function saveThen(run: () => Promise<unknown>, done: string, area: Area) {
    const result = await act(run, done, area);
    if (live.current) await refresh(false, !!result);
    return !!result;
  }
  const startPicker = startIn && <label style={{ ...row, flexWrap: "nowrap", gap: space[2], minWidth: 0 }}>
    <span className="muted" style={{ whiteSpace: "nowrap" }}>{t("시작할 워크스페이스", "Start in")}</span>
    <select className="select" value={startIn.id} disabled={busy || loading} onChange={event => setChosenWorkspace(event.target.value)}>
      {workspaces.map(w => <option key={w.id} value={w.id}>
        {[projectTitle(w.projectId), w.title].filter(Boolean).join(" · ") + (w.focused ? t(" (지금 보는 곳)", " (focused)") : "")}
      </option>)}
    </select>
  </label>;
  const routeLine = loading ? t("사용할 수 있는 모델을 확인하고 있습니다.", "Checking available models…")
    : model ? null
    : data ? explainEmptyRoute(data, "M", t) : t("실행기와 모델을 새로 고쳐 주세요.", "Refresh providers and models.");

  if (settings) return <div style={{ ...column, gap: 14 }}>
    <Section title={t("사실 질문 자동 답장", "Automatic replies to factual questions")}><FactReplyControls /></Section>
    <Section title={t("사이드바 고정", "Sidebar pinning")}>
      <p className="muted">{t("Orca는 플러그인이 워크스페이스를 사이드바에 고정하게 하지 않아 이 설정이 없습니다.", "Orca does not let plugins pin workspaces in the sidebar, so this setting is unavailable.")}</p>
    </Section>
    <Section title={t("실행기", "Providers")} aside={<span style={{ marginLeft: "auto" }}>
      <Button size="sm" label={loading ? t("실행기 조회 중…", "Loading providers…") : t("실행기·모델 새로 고침", "Refresh providers and models")} disabled={loading || busy} onPress={() => void refresh(false)} />
    </span>}>
      <p className="muted">{t("새로 발견한 실행기는 기본으로 포함됩니다. 연결된 모델이 있는 실행기에 작업을 배정합니다.", "New providers are included by default. Providers with available models can receive assignments.")}</p>
      <p className="muted sm">{t("모델 목록은 제안입니다. Orca는 플러그인에 실행기의 모델 목록을 알려 주지 않아, 실행기가 실제로 받는 모델과 다를 수 있습니다.", "Model lists are suggestions. Orca does not give plugins a provider's model list, so a provider may accept different models.")}</p>
      {data && <ProviderSettings providers={data.providers} catalog={data.catalog} busy={busy || loading} overrides={data.workerModeOverrides}
        setMode={(provider, modeId) => void saveThen(() => call(setWorkerMode, { provider, modeId, expectedRevision: data.revision }),
          t("다음 작업 세션의 권한을 저장했습니다.", "Saved permissions for new worker sessions."), "provider")}
        change={(provider, included) => void saveThen(() => call(setProviderInclusion, { provider, included, expectedRevision: data.revision }),
          included ? t("이 실행기를 새 작업 배정에 포함했습니다.", "Provider included in new assignments.") : t("이 실행기를 새 작업 배정에서 제외했습니다.", "Provider excluded from new assignments."), "provider")} />}
      {feedbackIn("provider")}
    </Section>
    {data && <Section title={t("계정별 남은 사용량", "Remaining account usage")}>
      <UsageRouting providers={data.providers} reports={data.usage ?? []} supplemental={data.displayUsage} enabled={data.usageRouting ?? false} busy={busy || loading || !data.usage}
        onToggle={() => void saveThen(() => call(setUsageRouting, { enabled: !data.usageRouting, expectedRevision: data.revision }),
          t("사용량 기반 배정 설정을 저장했습니다.", "Saved the usage routing preference."), "usage")} />
      {feedbackIn("usage")}
    </Section>}
    <Section title={t("모델 배정", "Model routing")}>
      <p className="muted">{t("추천 설정은 연결된 실행기에서 사용할 수 있는 모델을 고릅니다. 직접 정하려면 후보를 원하는 순서대로 저장하세요.", "Recommended settings use available models from connected providers. To customize a grade, save its models in order of preference.")}</p>
      {data && <RouteEditor data={data} busy={busy || loading} save={(grade, candidates, expectedRevision) => saveThen(() => call(updateRouting, { grade, candidates, expectedRevision }),
        grade === "M" ? t("운영 세션 모델을 저장했습니다. 다음 생성 또는 교체부터 적용됩니다.", "Coordinator model saved for the next creation or replacement.") : t("배정표를 저장했습니다. 다음 배정부터 적용됩니다.", "Routing saved for the next assignment."), "routing")} />}
      {feedbackIn("routing")}
    </Section>
    {configured && coordinator && <Section title={t("운영 세션 교체", "Replace coordinator")}>
      <p className="muted">{t("새 코디네이터를 만들 때 쓸 모델", "Model for the next coordinator")} · {loading ? t("조회 중…", "Loading…") : routeName(model, t)}</p>
      {!loading && model && <p className="muted">{modeText}</p>}
      {!loading && data && !model && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{explainEmptyRoute(data, "M", t)}</p>}
      {confirm && <p>{t("새 운영 세션이 준비되면 담당자를 바꿉니다. 진행 중인 작업과 결정 카드는 유지됩니다.", "The new session takes over when ready. Current work and decisions stay on the board.")}</p>}
      {confirm && startPicker}
      <div style={wrap}>
        <Button label={confirm ? t("교체 취소", "Cancel replacement") : t("새 코디네이터로 교체…", "Replace coordinator…")} expanded={confirm}
          disabled={busy || (!confirm && (loading || !model || !mode))} onPress={() => setConfirm(!confirm)} />
        {confirm && <Button label={t("새 세션으로 교체", "Switch to new session")} disabled={busy || loading || !model || !mode} onPress={connect} />}
      </div>
      {feedbackIn("coordinator")}
    </Section>}
  </div>;

  const sendRequest = { disabled: busy || !configured || !text.trim(), onPress: () => void post("work") };
  const requestLabel = t("코디네이터에게 맡길 일", "Request for the coordinator");
  return <Section title={t("코디네이터", "Coordinator")} aside={coordinator && openCoordinator &&
    <SessionChip label={t("코디네이터 세션", "Coordinator session")} accessibilityLabel={t("코디네이터 세션 열기", "Open coordinator session")} onPress={() => openCoordinator(coordinator)} />}>
    {coordinator ? <>
      <div style={{ ...row, gap: space[2], justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600 }}>{requestLabel}</span>
        <Button size="sm" expanded={editorExpanded} label={editorExpanded ? t("입력창 접기", "Collapse editor") : t("입력창 펼치기", "Expand editor")}
          onPress={() => setEditorExpanded(expanded => !expanded)} />
      </div>
      <SendTextInput send={sendRequest} className="textarea-strong" aria-label={requestLabel} value={text} disabled={busy} maxLength={24000}
        placeholder={t("예: 초안 작성과 자료 검증을 나눠 맡겨 주세요", "Example: Assign the first draft and source checks separately.")}
        onChange={event => setText(event.target.value)}
        style={{ height: editorExpanded ? Math.min(480, Math.max(160, Math.round(window.innerHeight * 0.48))) : undefined }} />
      <div style={wrap}>
        <SendButton label={t("코디네이터에 요청 보내기", "Send to coordinator")} send={sendRequest} selected={!sendRequest.disabled} />
        <Button label={t("다이제스트 요청", "Request digest")} disabled={busy || !configured} onPress={() => void post("digest")} />
      </div>
      <p className="muted">{!configured ? t("설정에서 관리할 프로젝트를 선택해 주세요.", "Choose a project to manage in Settings.")
        : t("작업 요청은 코디네이터에게 전달됩니다. 다이제스트는 내 결정과 추천 답장을 모읍니다.", "Requests go to the coordinator. A digest gathers decisions and suggested replies.")}</p>
    </> : <>
      <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{routeLine ?? t(`연결된 모델로 운영 세션을 만듭니다 · ${routeName(model, t)}`, `Create a coordinator session with ${routeName(model, t)}`)}</p>
      {!loading && model && <p className="muted">{modeText}</p>}
      {startPicker}
      <div style={wrap}>
        <Button label={data?.routing.M ? t("저장한 모델로 시작", "Start with saved model") : t("추천 설정으로 시작", "Start with recommended settings")}
          disabled={busy || loading || !model || !mode} onPress={connect} />
      </div>
    </>}
    {feedbackNode}
  </Section>;
}
