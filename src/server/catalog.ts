// Orca's stand-in for Paseo's provider directory (server/dispatch.ts) and account usage
// (server/usage-routing.ts @ 2e9d128): the agents `orca agent installed` lists, a static model list
// for each (Orca does not list an agent's models), and the rate limits `orca account list` reports.
import { z } from "zod";
import type { OrcaCli } from "../orca/cli";
import { COORDINATOR_MODES } from "../channel/hook";
import type { CatalogModel, ProviderEntry } from "../paseo/shared/dispatch";
import type { AccountUsage } from "../paseo/shared/usage-routing";

const installed = z.object({ agents: z.array(z.object({ id: z.string(), name: z.string() })) });

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
/** The models Paseo's routing table recommends, under the ids `orca agent launch --model` passes on. */
const SUGGESTED: Readonly<Record<string, readonly { model: string; label: string; efforts: string[]; isDefault?: boolean }[]>> = {
  claude: [
    { model: "claude-opus-5-5", label: "Opus 5.5", efforts: CLAUDE_EFFORTS, isDefault: true },
    { model: "claude-fable-5-2", label: "Fable 5.2", efforts: CLAUDE_EFFORTS },
    { model: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: CLAUDE_EFFORTS },
  ],
  codex: [
    { model: "gpt-6.2-astra", label: "GPT-6.2 Astra", efforts: CODEX_EFFORTS, isDefault: true },
    { model: "gpt-6.2-sol", label: "GPT-6.2 Sol", efforts: CODEX_EFFORTS },
    { model: "gpt-6-luna", label: "GPT-6 Luna", efforts: CODEX_EFFORTS },
  ],
};

export type Directory = { providers: Omit<ProviderEntry, "included">[]; catalog: CatalogModel[] };

export async function readDirectory(cli: OrcaCli): Promise<Directory> {
  let agents: z.output<typeof installed>["agents"];
  try {
    agents = (await cli.read("agent installed", [], (result) => installed.parse(result), { ttlMs: 60_000 })).agents;
  } catch {
    throw new Error("호스트의 실행기 목록을 확인하지 못했습니다.");
  }
  const providers: Directory["providers"] = [];
  const catalog: CatalogModel[] = [];
  for (const agent of agents) {
    const modes = COORDINATOR_MODES[agent.id];
    const coordinatorMode = modes ? { id: modes[0].id, label: modes[0].label } : null;
    const models = (SUGGESTED[agent.id] ?? []).map(m => ({ provider: agent.id, model: m.model, label: m.label, efforts: m.efforts, isDefault: !!m.isDefault, coordinatorMode }));
    catalog.push(...models);
    providers.push({ id: agent.id, label: agent.name, available: true, status: models.length ? "ready" : "empty", modelCount: models.length,
      workerModes: modes ? modes.map(({ id, label }) => ({ id, label })) : null });
  }
  return { providers, catalog };
}

const limitWindow = z.object({ usedPercent: z.number(), resetsAt: z.number().nullish() });
const rateLimit = z.object({
  provider: z.string(), status: z.string().nullish(), error: z.string().nullish(), planType: z.string().nullish(), updatedAt: z.number().nullish(),
}).catchall(z.unknown());
const accounts = z.object({ rateLimits: z.record(z.string(), rateLimit.nullable()).nullish() });

const iso = (ms: number | null | undefined) => typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

function usageIssue(error: string | null | undefined) {
  if (!error) return undefined;
  if (/\b429\b|rate.limit/i.test(error)) return "rate-limit" as const;
  if (/\b401\b|sign in again|login expired/i.test(error)) return "login" as const;
  return undefined;
}

/** "fableWeekly" is the weekly window of one model family; Paseo's routing reads that from "weekly_model_fable". */
function windowId(key: string) {
  const scoped = /^(.+)Weekly$/.exec(key);
  return scoped ? "weekly_model_" + scoped[1].toLowerCase() : key;
}
const WINDOW_LABELS: Readonly<Record<string, string>> = { session: "Session", weekly: "Weekly", monthly: "Monthly" };

export function usageFromAccounts(result: unknown): AccountUsage[] {
  const limits = accounts.parse(result).rateLimits ?? {};
  return Object.values(limits).flatMap(entry => {
    if (!entry) return [];
    const windows = Object.entries(entry).flatMap(([key, value]) => {
      const parsed = limitWindow.safeParse(value);
      if (!parsed.success) return [];
      const scoped = /^(.+)Weekly$/.exec(key);
      return [{
        id: windowId(key), label: WINDOW_LABELS[key] ?? (scoped ? scoped[1][0].toUpperCase() + scoped[1].slice(1) + " weekly" : key),
        summary: key === "session" || key === "weekly", resetsAt: iso(parsed.data.resetsAt),
        remainingPct: Math.min(100, Math.max(0, 100 - parsed.data.usedPercent)),
      }];
    });
    const status = entry.status === "ok" ? "available" as const : entry.status === "unavailable" ? "unavailable" as const : "error" as const;
    return [{ providerId: entry.provider, label: entry.provider, plan: entry.planType ?? null, status,
      issue: status === "available" ? undefined : usageIssue(entry.error), fetchedAt: iso(entry.updatedAt), windows, balances: [] }];
  });
}

/** Never throws, as in Paseo: a slow or failing usage reader leaves routing to the recommended order. */
export async function readAccountUsage(cli: OrcaCli): Promise<AccountUsage[]> {
  try {
    return await cli.read("account list", [], usageFromAccounts, { ttlMs: 60_000 });
  } catch {
    return [];
  }
}
