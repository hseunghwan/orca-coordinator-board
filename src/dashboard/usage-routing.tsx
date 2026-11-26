/** @jsxImportSource react */
// Paseo's UsageRouting and AccountCard (client/usage-routing.tsx). The bar is Orca's Progress recipe.
import type { ProviderEntry } from "../paseo/shared/dispatch";
import { hasUsageReading, recentUsage, type AccountUsage } from "../paseo/shared/usage-routing";
import { useWidth } from "./use-width";
import { Button, column, row } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

function AccountCard({ label, report, supplemental, issue }: { label: string; report?: AccountUsage; supplemental?: boolean; issue?: AccountUsage["issue"] }) {
  const { t, language } = useBoardLanguage();
  const locale = language === "ko" ? "ko-KR" : "en-US";
  const date = (stamp: string) => new Date(stamp).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const number = (n: number) => n.toLocaleString(locale, { maximumFractionDigits: 2 });
  const rows = report?.status === "available" ? [
    ...report.windows.map(w => ({ name: w.label, value: w.remainingPct === null ? null : number(w.remainingPct) + "%", pct: w.remainingPct, reset: w.resetsAt })),
    ...report.balances.map(b => ({
      name: b.label, value: b.remaining === null ? null : number(b.remaining) + (b.limit !== null && b.limit > 0 ? " / " + number(b.limit) : "") + " " + b.unit,
      pct: b.remaining !== null && b.limit !== null && b.limit > 0 ? Math.max(0, Math.min(100, 100 * b.remaining / b.limit)) : null, reset: b.resetsAt,
    })),
  ] : [];
  const stale = report && !recentUsage(report);
  return <div style={{ ...column, gap: 7, padding: 10, borderRadius: "var(--r-md)", border: "1px solid var(--border)", background: "var(--bg)" }}>
    <p style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{[label, report?.plan].filter(Boolean).join(" · ")}</p>
    {rows.map((entry, i) => {
      const expired = !!entry.reset && Date.parse(entry.reset) <= Date.now();
      const pct = expired ? null : entry.pct;
      const value = expired ? t("초기화 후 조회 대기", "Awaiting new reading") : entry.value ?? t("미확인", "Unknown");
      return <div key={i} style={{ ...column, gap: 4 }}>
        <div style={{ ...row, alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <span className="muted" style={{ fontSize: 13 }}>{entry.name}</span>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{!expired && entry.value !== null ? t(value + " 남음", value + " left") : value}</span>
        </div>
        {pct !== null && <div role="progressbar" aria-label={t(entry.name + " 잔여량", entry.name + " remaining")} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={pct} aria-valuetext={value} className="progress">
          <div style={{ width: `${pct}%`, background: stale ? "var(--muted-fg)" : pct <= 10 ? "var(--warning)" : "var(--primary)" }} />
        </div>}
        {entry.reset && !expired && <p className="muted sm">{t(date(entry.reset) + " 초기화", "Resets " + date(entry.reset))}</p>}
      </div>;
    })}
    {!rows.length && <p className="muted" style={{ fontSize: 13 }}>{!report ? t("연결된 사용량 보고서가 없습니다.", "No connected usage report.")
      : report.status === "error" ? t("사용량 조회에 실패했습니다.", "Usage lookup failed.")
      : t("제공된 잔여량 수치가 없습니다.", "No remaining quota reported.")}</p>}
    {issue && <p className="warn sm">{issue === "login" ? t("사용량 조회에 다시 로그인이 필요합니다.", "Sign in again for usage reports.")
      : t("사용량 조회 요청 한도에 도달했습니다.", "Usage lookup is rate-limited.")}</p>}
    {report && (supplemental || report.fetchedAt) && <p className="muted sm">{[
      supplemental && t("호스트 추가 보고 · 표시 전용", "Host report · display only"),
      report.fetchedAt && (stale ? t("이전 측정", "Last known reading") : t("조회", "Checked")) + " " + date(report.fetchedAt),
    ].filter(Boolean).join(" · ")}</p>}
  </div>;
}

export function UsageRouting({ providers, reports, supplemental = [], enabled, busy, onToggle }: {
  providers: ProviderEntry[]; reports: AccountUsage[]; supplemental?: AccountUsage[]; enabled: boolean; busy: boolean; onToggle: () => void;
}) {
  const { t } = useBoardLanguage();
  const [ref, width] = useWidth();
  const seen = new Set([...reports, ...supplemental].map(r => r.providerId));
  const added = new Set(supplemental.filter(hasUsageReading).map(r => r.providerId));
  const counts = new Map<string, number>();
  for (const r of reports) counts.set(r.providerId, (counts.get(r.providerId) ?? 0) + 1);
  const cards = [
    ...reports.filter(r => !added.has(r.providerId) || hasUsageReading(r) || (counts.get(r.providerId) ?? 0) > 1)
      .map(r => ({ id: r.providerId, label: r.label, report: r, issue: r.issue, supplemental: false })),
    ...supplemental.map(r => ({ id: r.providerId, label: r.label, report: r, issue: counts.get(r.providerId) === 1 ? reports.find(p => p.providerId === r.providerId)?.issue : undefined, supplemental: true })),
    ...providers.filter(p => !seen.has(p.id)).map(p => ({ id: p.id, label: p.label, report: undefined, issue: undefined, supplemental: false })),
  ];
  return <div style={{ ...column, gap: 9 }}>
    <div ref={ref} style={{ display: "grid", gridTemplateColumns: width >= 580 ? "repeat(2, minmax(0, 1fr))" : "minmax(0, 1fr)", gap: 8, alignItems: "start" }}>
      {cards.map((card, i) => <AccountCard key={card.id + ":" + i} {...card} />)}
    </div>
    {!cards.length && <p className="muted">{t("호스트에 사용량 보고서가 없습니다.", "This host has no usage reports.")}</p>}
    <div style={{ alignSelf: "flex-start" }}>
      <Button toggle selected={enabled} disabled={busy}
        label={enabled ? t("사용량 기반 자동 배정 켜짐", "Usage-aware routing on") : t("사용량 기반 자동 배정 꺼짐", "Usage-aware routing off")} onPress={onToggle} />
    </div>
    <p className="muted sm">{t("자동 배정은 같은 등급에서 공통 한도가 있는 계정의 가장 낮은 잔여율을 비교합니다. 직접 저장한 배정 순서가 우선입니다.", "Automatic routing compares the lowest fresh headroom for candidates with a shared quota window. Saved route priorities take precedence.")}</p>
  </div>;
}
