/** @jsxImportSource react */
// Paseo's RouteEditor and CandidateList (client/route-editor.tsx).
import { useState } from "react";
import { browseModels, explainEmptyRoute, savedCandidateIssue } from "../paseo/client/route-options";
import { resolveRoute, sameRoute, workerGradeSchema, type Grade, type RouteChoice } from "../paseo/shared/dispatch";
import type { Operations } from "../paseo/shared/operations";
import type { Translate } from "../paseo/view-types";
import { Button, column, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

const wrap = { ...row, gap: 6 };

function gradeName(grade: Grade, t: Translate) {
  const names = { A: t("최상", "Highest"), B: t("높음", "High"), C: t("중간", "Medium"), D: t("기본", "Basic"), M: t("운영", "Operations") };
  return grade + " · " + names[grade];
}
export function routeName(route: RouteChoice | null, t: Translate) {
  return route ? [route.provider, route.model, route.effort].filter(Boolean).join(" / ") : t("사용 가능한 후보 없음", "No available candidate");
}

type Props = { data: Operations; busy: boolean; save: (grade: Grade, rows: RouteChoice[], revision: number) => Promise<boolean> };

export function RouteEditor({ data, busy, save }: Props) {
  const { t } = useBoardLanguage();
  const [grade, setGrade] = useState<Grade>("C");
  return <div style={{ ...column, gap: 8 }}>
    <p style={{ fontWeight: 600 }}>{t("작업 난이도", "Task difficulty")}</p>
    <div style={wrap}>
      {workerGradeSchema.options.map(g => <Button key={g} size="sm" label={gradeName(g, t)} selected={g === grade} onPress={() => setGrade(g)} />)}
    </div>
    <div style={wrap}>
      <p style={{ fontWeight: 600 }}>{t("운영 세션", "Coordinator session")}</p>
      <Button size="sm" label={gradeName("M", t)} selected={grade === "M"} onPress={() => setGrade("M")} />
    </div>
    {grade === "M" && <p className="muted">{t("M은 코디네이터를 만들거나 교체할 때 사용합니다. 현재 세션은 그대로 운영됩니다.", "M selects the model for a new or replacement coordinator. The current session keeps its model.")}</p>}
    <CandidateList key={grade + ":" + data.revision} data={data} busy={busy} grade={grade} save={save} />
  </div>;
}

function CandidateList({ data, busy, grade, save }: Props & { grade: Grade }) {
  const { t } = useBoardLanguage();
  const [rows, setRows] = useState<RouteChoice[]>(data.routing[grade] ?? []);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(6);
  const [provider, setProvider] = useState<string | null>(null);
  const [edit, setSelection] = useState<RouteChoice | null>(null);
  const route = resolveRoute(grade, data.routing, data.catalog, false, data.usageRouting ? data.usage : undefined);
  const saved = data.routing[grade]?.length;
  const browser = browseModels(data, grade, provider, query, limit, t, route);
  const editAvailable = edit && data.catalog.some(m => m.provider === edit.provider && m.model === edit.model && (edit.effort === null || m.efforts.includes(edit.effort)));
  const selection = editAvailable ? edit : route;
  const model = selection && browser.choices.find(m => m.model === selection.model && m.provider === selection.provider);
  function filter(id: string | null) { setProvider(id); setSelection(null); setLimit(6); }
  return <div style={{ ...column, gap: 7 }}>
    <p>{saved ? t("저장된 배정", "Saved route") : t("추천 설정", "Recommended route")} · {routeName(route, t)}</p>
    {!route && <p className="muted" style={{ whiteSpace: "pre-wrap" }}>{explainEmptyRoute(data, grade, t)}</p>}
    {rows.map((r, i) => {
      const issue = savedCandidateIssue(data, grade, r, t);
      return <div key={JSON.stringify(r)} style={wrap}>
        <p className={issue ? "warn" : undefined}>{i === 0 ? t("우선", "Primary") : t(`예비 ${i}`, `Fallback ${i}`)} · {routeName(r, t)}{issue ? " · " + issue : ""}</p>
        {i > 0 && <Button size="sm" label={t("앞으로", "Move up")} disabled={busy} onPress={() => {
          const next = [...rows];
          [next[i - 1], next[i]] = [next[i], next[i - 1]];
          setRows(next);
        }} />}
        <Button size="sm" label={t("후보 제외", "Remove candidate")} disabled={busy} onPress={() => setRows(rows.filter((_, index) => i !== index))} />
      </div>;
    })}
    {browser.providers.length > 1 && <div style={wrap}>
      <Button size="sm" label={t("전체 실행기", "All providers")} selected={browser.active === null} onPress={() => filter(null)} />
      {browser.providers.map(p => <Button key={p.id} size="sm" label={`${p.label} · ${p.count}`} selected={browser.active === p.id} onPress={() => filter(p.id)} />)}
    </div>}
    <input className="input" aria-label={t("모델 검색", "Search models")} placeholder={t("실행기 또는 모델 검색", "Search providers or models")} value={query}
      onChange={event => { setQuery(event.target.value); setLimit(6); setSelection(null); }} />
    {browser.hint && <p className="muted">{browser.hint}</p>}
    <div style={wrap}>
      {browser.choices.map(m => <Button key={JSON.stringify([m.provider, m.model])} size="sm"
        label={m.provider + " / " + m.model + (route?.provider === m.provider && route.model === m.model ? " · " + (saved ? t("적용 중", "In use") : t("추천", "Recommended")) : "")}
        selected={selection?.provider === m.provider && selection.model === m.model}
        onPress={() => setSelection(route?.provider === m.provider && route.model === m.model ? route : { provider: m.provider, model: m.model, effort: null })} />)}
      {browser.choices.length < browser.count && <Button size="sm" variant="ghost" label={t("모델 더 보기", "Show more models")} onPress={() => setLimit(limit + 12)} />}
    </div>
    {model && selection && <div style={{ ...column, gap: 6 }}>
      <p>{t("추론 강도", "Reasoning effort")}</p>
      <div style={wrap}>
        {[null, ...model.efforts].map(e => <Button key={e ?? "default"} size="sm" label={e ?? t("실행기 기본 강도", "Provider default")}
          selected={e === selection.effort} onPress={() => setSelection({ ...selection, effort: e })} />)}
        <Button size="sm" label={t("후보에 추가", "Add candidate")} disabled={busy || rows.length >= 12 || rows.some(r => sameRoute(r, selection))}
          onPress={() => { setRows([...rows, selection]); setSelection(null); }} />
      </div>
    </div>}
    <div style={wrap}>
      <Button variant="default" label={t("배정표 저장", "Save routing")} disabled={busy || JSON.stringify(rows) === JSON.stringify(data.routing[grade] ?? [])}
        onPress={() => void save(grade, rows, data.revision)} />
      <Button label={t("추천으로 복원", "Restore defaults")} disabled={busy || !data.routing[grade]} onPress={() => void save(grade, [], data.revision)} />
    </div>
  </div>;
}
