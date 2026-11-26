/** @jsxImportSource react */
// Paseo's ProviderSettings and WorkerPermissions (client/providers.tsx).
import { useState } from "react";
import { eligibleProvider, recommendedWorkerMode, workerGradeSchema, type CatalogModel } from "../paseo/shared/dispatch";
import type { Operations } from "../paseo/shared/operations";
import type { Translate } from "../paseo/view-types";
import { useWidth } from "./use-width";
import { Button, column, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

type Provider = Operations["providers"][number];
const wrap = { ...row, gap: 6 };

function catalogStatus(provider: Provider, t: Translate) {
  if (provider.status === "unavailable") return t("사용 불가", "Unavailable");
  if (provider.status === "error") return t("모델 조회 실패", "Model lookup failed");
  if (provider.status === "empty") return t("모델 없음", "No models");
  return provider.modelCount === null ? t("모델 수 미확인", "Model count unknown") : t(`모델 ${provider.modelCount}개`, `Models: ${provider.modelCount}`);
}

function roles(id: string, catalog: CatalogModel[], t: Translate) {
  const grades = workerGradeSchema.options.filter(grade => eligibleProvider(grade, id, false, catalog));
  const worker = grades.length === 4 ? "A~D" : grades.join("·");
  const scope = [t(`작업 ${worker}`, `Work ${worker}`)];
  if (eligibleProvider("M", id, false, catalog)) scope.push(t("운영 M", "Coordinator M"));
  if (eligibleProvider("D", id, true)) scope.push(t("필수 훅", "Required hooks"));
  return scope.join(" / ");
}

export function ProviderSettings({ providers, catalog, busy, change, overrides, setMode }: {
  providers: Provider[]; catalog: CatalogModel[]; busy: boolean;
  change: (provider: string, included: boolean) => void;
  overrides?: Record<string, string>;
  setMode: (provider: string, mode: string | null) => void;
}) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(true);
  const [ref, width] = useWidth();
  const columns = Math.max(1, Math.floor((width + 8) / 260));
  if (!providers.length) return <p className="muted">{t("Orca가 알려 준 실행기가 없습니다. Orca에서 에이전트를 연결한 뒤 새로 고쳐 주세요.", "Orca reported no providers. Connect an agent in Orca, then refresh.")}</p>;
  const included = providers.filter(p => p.included);
  const ready = included.filter(p => p.available && p.status === "ready");
  return <div ref={ref} style={{ ...column, gap: 8 }}>
    <div style={{ ...row, justifyContent: "space-between", gap: 8 }}>
      <p className="muted">{t(`발견 ${providers.length}개 · 배정에 포함 ${included.length}개 · 모델 선택 가능 ${ready.length}개`, `Discovered ${providers.length} · Included ${included.length} · With models ${ready.length}`)}</p>
      <Button size="sm" expanded={expanded} label={expanded ? t("목록 접기", "Collapse list") : t("실행기 목록 펼치기", "Expand provider list")} onPress={() => setExpanded(!expanded)} />
    </div>
    {expanded && <div style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 8 }}>
      {providers.map(provider => <div key={provider.id} style={{ ...column, gap: 5, padding: 10, borderRadius: "var(--r-md)", border: "1px solid var(--border)", background: "var(--bg)" }}>
        <p style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{provider.label}</p>
        <p className="muted sm" style={{ overflowWrap: "anywhere" }}>{provider.id} · {catalogStatus(provider, t)}</p>
        <p className="muted sm">{roles(provider.id, catalog, t)}</p>
        {overrides && (provider.workerModes?.length || Object.hasOwn(overrides, provider.id) || recommendedWorkerMode(provider.id)) ? <WorkerPermissions
          provider={provider.id} modes={provider.workerModes} selected={Object.hasOwn(overrides, provider.id) ? overrides[provider.id] : undefined}
          busy={busy} save={setMode} /> : null}
        <div style={wrap}>
          <Button size="sm" toggle selected={provider.included} disabled={busy}
            label={provider.included ? t("배정에 포함됨", "Included in routing") : t("배정에서 제외됨", "Excluded from routing")}
            accessibilityLabel={t(`${provider.id} · 배정${provider.included ? "에서 제외" : "에 포함"}`, `${provider.included ? "Exclude" : "Include"} ${provider.id} ${provider.included ? "from" : "in"} routing`)}
            onPress={() => change(provider.id, !provider.included)} />
        </div>
      </div>)}
    </div>}
  </div>;
}

function WorkerPermissions({ provider, modes, selected, busy, save }: {
  provider: string; modes: Provider["workerModes"]; selected?: string; busy: boolean; save: (provider: string, mode: string | null) => void;
}) {
  const { t } = useBoardLanguage();
  const [open, setOpen] = useState(false);
  const current = selected ?? recommendedWorkerMode(provider);
  const label = modes?.find(m => m.id === current)?.label ?? current ?? t("실행기 기본", "Provider default");
  return <div style={{ ...column, gap: 5, alignItems: "flex-start" }}>
    <Button size="sm" expanded={open} label={t(`새 작업 세션 권한 · ${label}`, `New worker permissions · ${label}`)}
      accessibilityLabel={t(`${provider} · 새 작업 세션 권한 · ${label}`, `${provider} · New worker permissions · ${label}`)} onPress={() => setOpen(!open)} />
    {open && <>
      {current && !modes?.some(m => m.id === current) && <p className="muted sm">{t("호스트에서 현재 선택을 확인할 수 없습니다.", "This host has not confirmed the selected mode.")}</p>}
      <div style={{ ...row, gap: 5 }}>
        {modes?.map(mode => <Button key={mode.id} size="sm" label={mode.label} selected={current === mode.id} disabled={busy} onPress={() => save(provider, mode.id)} />)}
        {selected !== undefined && <Button size="sm" label={t("권장 모드 복원", "Restore recommended mode")} disabled={busy} onPress={() => save(provider, null)} />}
      </div>
      {provider === "codex" && modes?.some(m => m.id === "full-access") &&
        <p className="warn sm">{t("Full Access를 고르면 새 Codex 작업자가 샌드박스 밖에서도 명령을 실행할 수 있습니다.", "Full Access lets new Codex workers run commands outside the sandbox.")}</p>}
    </>}
  </div>;
}
