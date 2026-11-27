// Adapted from paseo-coordinator-board server/dispatch.ts and the plan_board_assignment and assign_board_worker
// tools of server/operations.ts @ 2e9d128. Paseo creates a worker under an agent id and idempotency key it chose;
// Orca names a session only after it reports. So the board keeps a launch journal keyed by requestKey, written
// before `orca agent launch`, which runs in the coordinator's own shell (channel protocol 2) so Orca shows the
// coordinator handing off. A retry settles a lost answer with --retry-launch and never starts a second worker
// while the first is uncertain. Paseo's agent metadata (intent fingerprint, grade, parent, mode) is kept by the
// worker's orcaSessionId once it reports. Orca cannot report a terminal agent's permission mode, so the launch
// hook applies it (src/channel/hook.ts WORKER_MODES) and the receipt names the mode it asked for.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { launchAgent, type Fleet, type World, type WorkspaceRecord, type WorktreeId } from "../orca";
import type { OrcaCli } from "../orca/cli";
import { CLI_PATH_NOTE, cliCommand, launchMarker, type PendingLaunch } from "../channel/hook";
import {
  dispatchInputSchema, effectiveWorkerMode, includedCatalog, resolveRoute, routeChoiceSchema, sameRoute, workerGradeSchema,
  type DispatchInput, type RoutePolicy, type WorkspaceChoice,
} from "../paseo/shared/dispatch";
import type { PreferenceStore } from "../paseo/server/preferences";
import { readAccountUsage, readDirectory } from "./catalog";
import { managedRowsForCoordinator, tool, type Tool } from "./coordinator";
import { isCurrentMembership } from "./session-links";
import type { WorkItemStore } from "./work-items";

type DispatchScope = { projects: string[]; routing: RoutePolicy; coordinator: string | null; excludedProviders: string[]; usageRouting?: boolean; workerModeOverrides?: Record<string, string> };

const launchRecord = z.object({
  requestKey: z.string(), launchId: z.string(), fingerprint: z.string(), projectId: z.string(), workspaceId: z.string(),
  grade: workerGradeSchema, title: z.string(), parent: z.string(), modeId: z.string().nullable(), route: routeChoiceSchema,
  state: z.enum(["launching", "started"]), handle: z.string().nullable(), operationId: z.string().nullable(), sessionId: z.string().nullable(), at: z.number(),
});
/** Paseo's worker metadata: reports, dispatch-intent (the fingerprint), grade, dispatch-parent, dispatch-mode. */
const workerRecord = z.object({ requestKey: z.string(), reports: z.literal(true), intent: z.string(), grade: workerGradeSchema, parent: z.string(), mode: z.string().nullable() });
const journalFile = z.object({ version: z.literal(1), launches: z.record(z.string(), launchRecord), workers: z.record(z.string(), workerRecord) });
export type WorkerLaunch = z.output<typeof launchRecord>;
export type WorkerMetadata = z.output<typeof workerRecord>;
type Journal = z.output<typeof journalFile>;

const KEEP = 500;
/** How long a launch whose answer was lost, and that left no id to settle it by, stays in the hook's list. */
const PENDING_MS = 10 * 60_000;
const ADOPT_TRIES = 20;
const ADOPT_WAIT_MS = 750;

export class WorkerJournal {
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(private readonly path: string) {}
  /** One dispatch per requestKey at a time: a second waits, then finds the first one's receipt. */
  serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.running.get(key) ?? Promise.resolve();
    const next = prior.then(task, task);
    const settled = next.then(() => undefined, () => undefined);
    this.running.set(key, settled);
    void settled.then(() => { if (this.running.get(key) === settled) this.running.delete(key); });
    return next;
  }
  read(): Journal {
    try { return journalFile.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, launches: {}, workers: {} };
      throw error;
    }
  }
  change(edit: (journal: Journal) => void) {
    const journal = this.read();
    edit(journal);
    const kept = Object.values(journal.launches).sort((a, b) => b.at - a.at).slice(0, KEEP);
    const keys = new Set(kept.map(l => l.requestKey));
    const next: Journal = { version: 1, launches: Object.fromEntries(kept.map(l => [l.requestKey, l])),
      workers: Object.fromEntries(Object.entries(journal.workers).filter(([, w]) => keys.has(w.requestKey))) };
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temp = this.path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }
  /** The worker metadata of a session the board started. */
  worker(sessionId: string): WorkerMetadata | undefined {
    return this.read().workers[sessionId];
  }
  /** Drops a gone session's worker metadata; its launch record stays so the requestKey is never reused. */
  forget(sessionId: string) {
    if (this.read().workers[sessionId]) this.change(j => { delete j.workers[sessionId]; });
  }
  /** Launches still waiting for their terminal, for the launch hook. */
  pending(now = Date.now()): PendingLaunch[] {
    return Object.values(this.read().launches).filter(l => l.state === "launching" && now - l.at < PENDING_MS)
      .map(l => ({ launchId: l.launchId, modeId: l.modeId, role: "worker" as const }));
  }
  /** Names each started worker whose terminal now reports a session. */
  adopt(world: World): boolean {
    const found = Object.values(this.read().launches).flatMap(l => {
      const session = l.state === "started" && !l.sessionId && l.handle ? sessionOf(world, l.handle) : undefined;
      return session ? [[l.requestKey, session.id] as const] : [];
    });
    if (!found.length) return false;
    this.change(j => { for (const [key, id] of found) settle(j, key, id); });
    return true;
  }
}

function settle(journal: Journal, requestKey: string, sessionId: string) {
  const launch = journal.launches[requestKey];
  if (!launch) return;
  launch.sessionId = sessionId;
  journal.workers[sessionId] = { requestKey, reports: true, intent: launch.fingerprint, grade: launch.grade, parent: launch.parent, mode: launch.modeId };
}

function sessionOf(world: World, handle: string) {
  return [...world.sessions.values()].filter(s => s.handle === handle).sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** Paseo's usable(): not archived, on this computer, with a folder. Orca has no setup status or background workspaces. */
function usable(workspace: WorkspaceRecord | undefined): workspace is WorkspaceRecord {
  return !!workspace && !workspace.archived && (!workspace.hostId || workspace.hostId === "local") && !!workspace.path;
}

export function managedWorkspaces(world: World, projects: readonly string[]): WorkspaceChoice[] {
  if (!projects.length) return [];
  return [...world.workspaces.values()].filter(w => usable(w) && projects.includes(w.projectId))
    .sort((a, b) => a.projectId.localeCompare(b.projectId))
    .map(w => ({ id: w.id, projectId: w.projectId, title: w.title.trim() || w.branch || w.path }));
}

const uncertain = "이전 작업자 실행 결과를 확인하지 못했습니다. 두 개가 뜨지 않게 같은 요청으로는 다시 띄우지 않습니다. 워크스페이스의 터미널을 확인한 뒤 필요하면 새 requestKey로 배정하세요.";

/** bin: the plugin's bin folder, named in the worker's prompt for its report command. */
/** items: the work item each assign opens (./work-items.ts), linked to the worker once it reports. */
export type DispatchDeps = { fleet: Pick<Fleet, "view" | "cli" | "invalidate">; journal: WorkerJournal; items?: WorkItemStore; bin?: string; sleep?: (ms: number) => Promise<void> };

/** What the board adds under the coordinator's prompt: a board worker reports on its own card (Paseo's report_to_board). */
export const workerNote = (bin: string, doneMeans?: string | null) =>
  (doneMeans ? "완료 기준: " + doneMeans + "\n" : "") +
  "보드에 결정할 일이나 확인할 결과를 보고할 때는 절대 경로로 `" + cliCommand(bin) + " report --kind question --text-file -`(확인할 결과는 `--kind review`)를 실행하고 글은 표준 입력으로 넘기세요. " +
  "맡은 일을 완료 기준까지 끝냈으면 마지막에 `--kind done`으로 한 번 보고하세요. 글에는 한 일, 산출물(PR, 파일), 검증 근거를 적습니다. " + CLI_PATH_NOTE;

/** assign's job: Paseo's dispatch input and what done means for the work, kept on the board's work item. */
export const assignJobSchema = dispatchInputSchema.extend({ doneMeans: z.string().trim().min(1).max(2000).optional() });

export async function dispatchWorker(deps: DispatchDeps, caller: OrcaCli | null | undefined, request: DispatchInput, getScope: () => DispatchScope, doneMeans: string | null = null) {
  const input = dispatchInputSchema.parse(request);
  return deps.journal.serial(input.requestKey, () => dispatchOnce(deps, caller, input, getScope, doneMeans));
}

async function dispatchOnce(deps: DispatchDeps, caller: OrcaCli | null | undefined, input: DispatchInput, getScope: () => DispatchScope, doneMeans: string | null) {
  const scopeForProject = () => {
    const state = getScope();
    if (typeof state.coordinator !== "string" || !state.coordinator) throw new Error("현재 기기의 코디네이터를 먼저 지정해 주세요.");
    if (!state.projects.includes(input.projectId)) throw new Error("이 호스트에서 관리할 프로젝트를 먼저 선택해 주세요.");
    return { workerModeOverrides: state.workerModeOverrides ?? {}, coordinator: state.coordinator, routing: state.routing, excluded: state.excludedProviders, usageRouting: state.usageRouting !== false };
  };
  const initial = scopeForProject();
  const fingerprint = createHash("sha256").update(JSON.stringify([
    input.projectId, input.workspaceId, input.grade, input.title, input.prompt, !!input.needsHooks,
    input.expectedRoute.provider, input.expectedRoute.model, input.expectedRoute.effort,
  ])).digest("hex");
  const world = await deps.fleet.view({ maxAgeMs: 0 });
  const target = world.workspaces.get(input.workspaceId as WorktreeId);
  if (!usable(target) || target.projectId !== input.projectId) {
    throw new Error("선택한 프로젝트에서 작업 가능한 워크스페이스를 다시 골라 주세요.");
  }
  const receipt = deps.journal.read().launches[input.requestKey];
  let parent: string;
  let modeId: string | undefined;
  const route = input.expectedRoute;
  if (receipt) {
    scopeForProject();
    if (receipt.workspaceId !== target.id || receipt.fingerprint !== fingerprint) {
      throw new Error("이미 다른 작업에 사용한 요청입니다. 새 작업으로 시작해 주세요.");
    }
    parent = receipt.parent;
    modeId = receipt.modeId ?? undefined;
  } else {
    const checkUsage = initial.usageRouting && !initial.routing[input.grade];
    const provider = route.provider;
    modeId = effectiveWorkerMode(provider, initial.workerModeOverrides);
    const [directory, usage] = await Promise.all([readDirectory(deps.fleet.cli), checkUsage ? readAccountUsage(deps.fleet.cli) : []]);
    if (modeId && !directory.providers.find(p => p.id === provider)?.workerModes?.some(mode => mode.id === modeId))
      throw new Error(`${provider} 작업 권한 모드 '${modeId}'를 확인할 수 없습니다. 설정에서 사용할 수 있는 작업 권한을 선택하세요.`);
    const state = scopeForProject();
    if (modeId !== effectiveWorkerMode(provider, state.workerModeOverrides))
      throw new Error("작업 권한 설정이 바뀌었습니다. 미리보기를 다시 확인해 주세요.");
    if (checkUsage !== (state.usageRouting && !state.routing[input.grade])) {
      throw new Error("배정 설정이 바뀌었습니다. 미리보기를 다시 확인해 주세요.");
    }
    const selected = resolveRoute(input.grade, state.routing, includedCatalog(directory.catalog, state.excluded), input.needsHooks, state.usageRouting ? usage : []);
    if (!selected || !sameRoute(route, selected)) {
      throw new Error("현재 배정 결과가 미리보기와 다릅니다. 호스트와 모델을 다시 확인해 주세요.");
    }
    parent = state.coordinator;
  }
  if (input.expectedModeId !== undefined && input.expectedModeId !== modeId)
    throw new Error("작업 권한이 배정 미리보기와 다릅니다. 호스트 설정을 다시 확인해 주세요.");
  const result = (sessionId: string | null, handle: string | null) => ({ sessionId, route, ...(modeId && { modeId }), ...(handle && { terminal: handle }) });

  let launch = receipt;
  if (launch?.sessionId) return result(launch.sessionId, launch.handle);
  if (launch?.state === "launching" && !launch.operationId) throw new Error(uncertain);
  if (launch?.state !== "started") {
    if (!caller) throw new Error("작업자 배정은 코디네이터 터미널의 coordinator-board 명령으로만 할 수 있습니다.");
    if (!launch) {
      launch = { requestKey: input.requestKey, launchId: randomUUID(), fingerprint, projectId: input.projectId, workspaceId: target.id,
        grade: input.grade, title: input.title, parent, modeId: modeId ?? null, route, state: "launching", handle: null, operationId: null, sessionId: null, at: Date.now() };
      const fresh = launch;
      deps.journal.change(j => {
        if (j.launches[input.requestKey]) throw new Error("같은 요청을 이미 실행하고 있습니다. 결과를 확인한 뒤 다시 실행하세요.");
        j.launches[input.requestKey] = fresh;
      });
      deps.items?.create({ itemId: input.requestKey, projectId: input.projectId, workspaceId: target.id, title: input.title, doneMeans });
    }
    const outcome = await launchAgent(caller, {
      agent: route.provider, worktree: target.id, model: route.model, effort: route.effort,
      prompt: launchMarker(launch.launchId) + "\n" + input.prompt + (deps.bin ? "\n\n" + workerNote(deps.bin, deps.items?.read().items[input.requestKey]?.doneMeans ?? doneMeans) : ""), retryLaunch: launch.operationId,
    });
    if (outcome.kind === "refused") {
      deps.journal.change(j => { delete j.launches[input.requestKey]; });
      throw new Error("Orca가 작업자 실행을 거절했습니다: " + outcome.message);
    }
    if (outcome.kind === "unknown") {
      const operationId = outcome.operationId ?? launch.operationId;
      deps.journal.change(j => { const l = j.launches[input.requestKey]; if (l) l.operationId = operationId; });
      throw new Error(uncertain);
    }
    launch = { ...launch, state: "started", handle: outcome.handle, operationId: outcome.operationId };
    const started = launch;
    deps.journal.change(j => { j.launches[input.requestKey] = started; });
    deps.fleet.invalidate();
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));
  for (let tries = 0; tries < ADOPT_TRIES; tries += 1) {
    const session = sessionOf(await deps.fleet.view({ maxAgeMs: 0 }), launch.handle!);
    if (session) {
      deps.journal.change(j => settle(j, input.requestKey, session.id));
      deps.items?.link([[input.requestKey, session.id]]);
      return result(session.id, launch.handle);
    }
    await sleep(ADOPT_WAIT_MS);
  }
  // The terminal is open; its session id comes with the agent's first report, and the board records it then.
  return result(null, launch.handle);
}

/** The plan and assign coordinator commands (Paseo's plan_board_assignment and assign_board_worker). */
export function dispatchCommands(store: PreferenceStore, deps: DispatchDeps): { plan: Tool; assign: Tool } {
  function ownerScope(caller: string) {
    const scope = store.read();
    if (scope.coordinator !== caller) throw new Error("현재 지정된 코디네이터만 작업을 배정할 수 있습니다.");
    return scope;
  }
  const plan = tool("coordinator", z.strictObject({ needsHooks: z.boolean().optional() }), async ({ needsHooks }, { paseo, agent }) => {
    const first = ownerScope(agent.id);
    const [directory, world, rows, projectList, usage] = await Promise.all([
      readDirectory(deps.fleet.cli),
      deps.fleet.view(),
      managedRowsForCoordinator(paseo, store, agent.id),
      paseo.projects.list(),
      first.usageRouting ? readAccountUsage(deps.fleet.cli) : [],
    ]);
    const latest = ownerScope(agent.id);
    const selected = (id: string) => first.projects.includes(id) && latest.projects.includes(id);
    const projects = projectList.projects.filter(p => selected(p.projectId))
      .map(p => ({ id: p.projectId, title: p.projectCustomName || p.projectDisplayName, path: p.projectRootPath }));
    const sessions = rows.filter(r => isCurrentMembership(r, first) && isCurrentMembership(r, latest))
      .map(({ id, title, projectId, sourceProjectId, workspaceTitle, status }) => ({ id, title, projectId, sourceProjectId, workspaceTitle, status }));
    const allowed = includedCatalog(directory.catalog, latest.excludedProviders);
    const routes = workerGradeSchema.options.map(grade => {
      const route = resolveRoute(grade, latest.routing, allowed, needsHooks, latest.usageRouting ? usage : []);
      const expectedModeId = route ? effectiveWorkerMode(route.provider, latest.workerModeOverrides) : undefined;
      return { grade, route, expectedModeId };
    });
    return { text: JSON.stringify({ projects, workspaces: managedWorkspaces(world, first.projects).filter(w => selected(w.projectId)), sessions, routes }) };
  });
  const assign = tool("coordinator", z.strictObject({ job: assignJobSchema }), async ({ job: { doneMeans, ...job } }, { paseo, agent, caller }) => {
    ownerScope(agent.id);
    await managedRowsForCoordinator(paseo, store, agent.id);
    return { text: JSON.stringify(await dispatchWorker(deps, caller, job, () => {
      const scope = ownerScope(agent.id);
      return { projects: scope.projects, routing: scope.routing, coordinator: agent.id, excludedProviders: scope.excludedProviders, usageRouting: scope.usageRouting, workerModeOverrides: scope.workerModeOverrides };
    }, doneMeans ?? null)) };
  });
  return { plan, assign };
}
