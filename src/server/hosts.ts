// Orca's stand-in for Paseo's host list and remote running sessions (client/hosts.tsx, client/remote-running.tsx,
// client/remote-sessions.ts @ 2e9d128). Paseo's client asks each connected host; on Orca the worker reads
// `orca host list` and, at most every 30 s while someone looks, `orca agent list --environment <id>` for each
// paired environment. Orca does not say whether a paired environment is connected, so one that answers counts
// as online. SSH targets show their connection; their sessions are already in this host's worktree ps.
// Paseo matches a remote session to a project by id or a unique GitHub repository; Orca's remote rows carry the
// repo's id inside worktreeId and its name, so a session matches by the same repo id, else one local project
// with the same name.
import { z } from "zod";
import type { OrcaCli } from "../orca/cli";
import type { World } from "../orca";
import type { T } from "../i18n";
import type { boardHosts } from "../contract";

type Output = z.input<typeof boardHosts.output>;
const POLL_MS = 30_000;

const hostList = z.object({ hosts: z.array(z.object({
  kind: z.enum(["local", "ssh", "environment"]), id: z.string(), name: z.string(), connected: z.boolean().nullish(),
})) });
const agentList = z.object({ agents: z.array(z.object({
  orcaSessionId: z.string().nullish(), state: z.string(), worktreeId: z.string().nullish(), workspace: z.string().nullish(),
  repo: z.string().nullish(), title: z.string().nullish(), updatedAt: z.number().nullish(),
})) });
type RemoteAgent = z.output<typeof agentList>["agents"][number];

/** Paseo's filter: running, and not waiting on a person (Orca's blocked and waiting are that). */
function running(agent: RemoteAgent) {
  return agent.state === "working" && !!agent.orcaSessionId;
}

export function matchProject(agent: RemoteAgent, world: World): string | null {
  const repoId = agent.worktreeId?.includes("::") ? agent.worktreeId.split("::")[0] : null;
  if (repoId && [...world.projects.keys()].includes(repoId as never)) return repoId;
  const named = [...world.projects.values()].filter(p => !!agent.repo && p.name === agent.repo);
  return named.length === 1 ? named[0].id : null;
}

export class HostWatch {
  private last: { at: number; value: Promise<Output> } | null = null;
  constructor(private readonly cli: OrcaCli, private readonly view: () => Promise<World>, private readonly now: () => number = Date.now) {}

  read(t: T): Promise<Output> {
    if (this.last && this.now() - this.last.at < POLL_MS) return this.last.value;
    const value = this.check(t);
    const entry = { at: this.now(), value };
    this.last = entry;
    value.catch(() => { if (this.last === entry) this.last = null; });
    return value;
  }

  private async check(t: T): Promise<Output> {
    const [{ hosts }, world] = await Promise.all([this.cli.read("host list", [], r => hostList.parse(r)), this.view()]);
    const environments = hosts.filter(h => h.kind === "environment");
    const answers = await Promise.all(environments.map(h =>
      this.cli.read("agent list", ["--environment", h.id], r => agentList.parse(r)).then(r => r.agents, () => null)));
    const online = new Map(environments.map((h, i) => [h.id, answers[i]]));
    const remoteRunning = environments.flatMap((h, i) => (answers[i] ?? []).filter(running).map(agent => ({
      hostId: h.id, hostName: h.name, sessionId: agent.orcaSessionId!, title: agent.title?.trim() || agent.orcaSessionId!.slice(0, 8),
      projectId: matchProject(agent, world), repo: agent.repo ?? null, workspace: agent.workspace ?? null,
      activityAt: typeof agent.updatedAt === "number" ? new Date(agent.updatedAt).toISOString() : null,
    })));
    const anyOnline = answers.some(a => a !== null);
    return {
      hosts: hosts.map(h => ({ id: h.id, kind: h.kind, name: h.name,
        status: h.kind === "local" ? "online" as const
          : h.kind === "ssh" ? (h.connected ? "online" as const : h.connected === false ? "offline" as const : "unknown" as const)
          : online.get(h.id) ? "online" as const : "offline" as const })),
      remoteRunning,
      checkedAt: new Date(this.now()).toISOString(),
      ...(anyOnline ? {} : { note: environments.length
        ? t("연결된 다른 Orca 환경이 없어 원격 실행 세션을 읽지 않았습니다.", "No paired Orca environment answered, so no remote running sessions were read.")
        : t("짝지은 다른 Orca 환경이 없습니다.", "There is no paired Orca environment.") }),
    };
  }
}
