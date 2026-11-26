// Candidate 2 — "Fleet port": a deep, Orca-honest domain port under the ported Paseo server.
//
// Shape in one line: Paseo's server logic keeps its business rules but stops talking to an SDK. It talks to ONE
// object, Fleet, whose vocabulary is what Orca can actually guarantee (states, reach, conversations with markers,
// idempotent deliveries, journaled launches, settle signals). Everything Orca-specific (CLI, ids, joins, truncation,
// Windows argv limits, markers, retry tokens) lives behind it. Nothing in src/paseo imports src/orca/* except
// src/orca/index.ts (enforced: package.json "imports" map + eslint no-restricted-imports on deep "src/orca/*" paths).
//
// ─── Module map ──────────────────────────────────────────────────────────────────────────────────────────────────
//   src/orca/index.ts         Fleet interface, createFleet(), exported domain types. The ONLY public door.
//   src/orca/cli.ts           orca.exe process boundary: locate, env, spawn, envelope parse, semaphore, single-flight.
//   src/orca/view.ts          FleetView: CLI agent list + terminal list + host workspace/project lists → LiveSession.
//                             Owns every id join (orcaSessionId ↔ paneKey ↔ term handle ↔ workspace list id).
//   src/orca/conversation.ts  "orca agent read" → Conversation (+ evidenceId, + board marker parse, + tail repair).
//   src/orca/marker.ts        The board marker codec "[cb:<uuid>]" (written by deliver, read by conversation).
//   src/orca/deliver.ts       Outbox journal + routes (terminal send / mail / mail-as-caller) + reconcile. Never resends.
//   src/orca/launch.ts        Launch journal + launch marker + --retry-launch handling + adoption.
//   src/orca/signals.ts       Pure reducer: status events + poll diffs → turn-ended / permission-cleared / gone.
//   src/orca/catalog.ts       agent installed, account list (usage), host list, remote environments.
//   src/channel/protocol.ts   NDJSON wire types between the shim CLI and the worker (shared by both bundles).
//   src/channel/server.ts     Named-pipe server, caller verification, BoardCommand dispatch, exec-as-caller frames.
//   src/channel/hook.ts       agent.launch.before: env/PATH/token/permission args. Pure + sync (2 s hook budget).
//   src/cli/coordinator-board.ts  The shim client (dist/coordinator-board.cjs); bin/coordinator-board(.cmd) launch it.
//   src/paseo/plugin-shim.ts  Local defineRpc/defineSettings so P/shared/*.ts copy verbatim (tsconfig paths alias
//                             "@getpaseo/plugin" → this file). NOT an SDK mimic: no server SDK surface is reproduced.
//   src/paseo/runtime.ts      BoardContext {fleet}, BoardServer, defineBoardCommand (replaces defineAgentTool).
//   src/paseo/server/*.ts     Ported Paseo server files (PORT_PLAN at the bottom says which bodies change).
//   src/worker.ts             activate(): wires Orca API → Fleet → channel → Paseo handlers; events; 30 s poll.
//
// Longest trace: decisions.ts → orca/deliver.ts → orca/cli.ts (3 files). Snapshot: worker.ts → discovery.ts → orca/view.ts.

import { z } from "zod";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Shared primitives (src/orca/index.ts re-exports these)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** orca_session_id (CLI "orcaSessionId"). THE session identity on the board. Chat: stable across /clear.
 *  Terminal: new id after /clear (a new conversation is a new board session; accepted). */
export type SessionId = Brand<string, "SessionId">;
/** CLI terminal handle "term_<uuid>". Same value as host agents.list / terminal.* terminalId (ensemble passes one
 *  where the other is expected, e.g. host terminalId → `orca terminal show --terminal`). */
export type TerminalHandle = Brand<string, "TerminalHandle">;
/** Terminal pane: "<tabId>:<leafId>" (observed: joins CLI agent row ↔ terminal list row, and equals ORCA_PANE_KEY).
 *  Chat: "structured-agent-session-<SessionId>:<pane>". */
export type PaneKey = Brand<string, "PaneKey">;
/** host workspace.list id: "identity:wt2:<host>:<x>" or "folder:<uuid>". Events carry it as workspaceListId. */
export type WorkspaceListId = Brand<string, "WorkspaceListId">;
/** Paseo's deterministic UUID for a board message (decision/clarification/digest/work/fact/merge notice). */
export type MessageId = Brand<string, "MessageId">;
/** 24 hex chars, same width as Paseo's evidenceId. */
export type EvidenceId = Brand<string, "EvidenceId">;
export type AgentId = "claude" | "codex" | "opencode" | "grok" | "gemini" | "cursor" | (string & {});

export type OrcaState = "working" | "blocked" | "waiting" | "done";
export type Surface = "terminal" | "chat";
export type TurnOutcome = "success" | "failure" | "cancellation" | "superseded" | "interruption" | "unconfirmed";

export interface Disposable { dispose(): void }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/index.ts — the port
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Everything the board needs from Orca. Each verb hides a policy, not just a call:
 *  - view():          4 sources joined, cached ≤ maxAgeMs, single-flight; partial data is reported, never thrown.
 *  - conversation():  agent read + tail repair + evidenceId + marker parse; cached by (id, updatedAt).
 *  - deliver():       idempotent per messageId; refuses unsafe targets; never re-sends; reconciles by marker.
 *  - launch():        idempotent per operationKey; journaled; permission args via the hook; never relaunches blind.
 *  - catalog():       installed agents, usage windows, hosts (TTL-cached; failure → empty + reason).
 *  - remoteRunning(): paired environments' running sessions (Paseo remote-running parity).
 *  - onSignal():      turn ended / permission cleared / gone, from events AND polling through one reducer.
 */
export interface Fleet {
  view(opts?: { maxAgeMs?: number; signal?: AbortSignal }): Promise<FleetView>;
  conversation(id: SessionId, opts: { limit: 48 | 100; fresh?: boolean; signal?: AbortSignal }): Promise<Conversation>;
  deliver(d: Delivery): Promise<DeliveryOutcome>;
  launch(spec: LaunchSpec, opts?: { as?: AgentCall }): Promise<LaunchOutcome>;
  catalog(): Promise<Catalog>;
  remoteRunning(): Promise<readonly RemoteSession[]>;
  onSignal(fn: (s: Signal) => void): Disposable;
  /** Fed by worker.ts from orca.events.on("agent.status.changed" | "workspace.removed"). */
  observe(e: StatusEvent | WorkspaceRemovedEvent): void;
}

export interface FleetDeps {
  host: { call<T>(method: string, params?: unknown): Promise<T> };   // OrcaWorkerApi.host
  cli: OrcaCli;
  dataDir: string;                      // ~/.orca-coordinator-board/<rootKey>/ (outbox.json, launches.json, mail/)
  boardSender: () => Promise<TerminalHandle | null>;  // plugin-owned mailbox terminal (see deliver routes)
  now: () => number;
  log: (m: string) => void;
}

export function createFleet(deps: FleetDeps): Fleet {
  // TODO: compose view.ts / conversation.ts / deliver.ts / launch.ts / signals.ts / catalog.ts. No logic here.
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/cli.ts — process boundary (private to src/orca)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Reads are cacheable, shareable and retried once on spawn failure. Writes are none of these. Two methods, two
 *  types: a write can never be single-flighted, cached or retried by accident. */
export type ReadVerb =
  | "agent list" | "agent read" | "agent show" | "terminal list"
  | "account list" | "host list" | "agent installed";
export type WriteVerb = "terminal send" | "orchestration send" | "agent launch";

export const CLI_TIMEOUT_MS: Readonly<Record<ReadVerb | WriteVerb, number>> = {
  "agent list": 10_000, "agent read": 10_000, "agent show": 10_000, "terminal list": 10_000,
  "account list": 3_000 /* Paseo usage read is 3 s */, "host list": 10_000, "agent installed": 10_000,
  "terminal send": 25_000 /* --wait-submit 10 + margin */, "orchestration send": 20_000, "agent launch": 90_000,
};

/** Windows CreateProcess command line is capped at 32 767 UTF-16 units. Keep headroom for exe path + quoting. */
export const MAX_ARGV_CHARS = 30_000;

export type WriteResult =
  | { kind: "ok"; result: unknown }
  /** Orca answered ok:false. preSend=true only for PRE_SEND_CODES (Orca guarantees nothing reached the agent). */
  | { kind: "failed"; code: string | null; message: string; preSend: boolean; retryToken: string | null }
  /** Timeout, killed, unparseable stdout: the effect may or may not have happened. */
  | { kind: "ambiguous"; why: "timeout" | "killed" | "unparseable" | "exit-without-envelope" };

export interface OrcaCli {
  readonly exe: string | null;          // null → every call rejects with CliUnavailable (view() reports partial)
  read<T>(verb: ReadVerb, args: readonly string[], parse: (result: unknown) => T,
          opts?: { ttlMs?: number; signal?: AbortSignal }): Promise<T>;
  write(verb: WriteVerb, args: readonly string[], opts?: { signal?: AbortSignal }): Promise<WriteResult>;
}

/** Error codes after which nothing was typed/sent. Any other ok:false from a write counts as ambiguous. */
export const PRE_SEND_CODES: ReadonlySet<string> = new Set([
  // TODO(Phase D): confirm the real codes by sending to a closed handle and to an unknown orca_session_id.
  "invalid_params", "not_found", "terminal_not_found", "not_writable", "outside_active_worktree", "too_long",
]);

/** Pure. Order: ORCA_CLI_COMMAND (if it exists) → ORCA_CLI_BIN_DIR/orca(.exe) → <dirname(execPath)>/resources/bin/orca(.exe)
 *  → null. Never "orca.cmd" (execFile cannot run .cmd without a shell) and never a bare "orca" (the worker PATH is unknown).
 *  Observed install: <LocalAppData>/Programs/orca/resources/bin/{orca.exe, orca.cmd, orca-agent-hook.exe, …}. */
export function locateOrca(input: {
  platform: NodeJS.Platform; execPath: string; env: Readonly<Record<string, string | undefined>>; exists(path: string): boolean;
}): string | null {
  throw new Error("not implemented");
}

/** Pure. Allowlist, not passthrough. The worker env lacks APPDATA/HOME on Windows, and it must NOT carry agent-pane vars
 *  (ORCA_TERMINAL_HANDLE, ORCA_PANE_KEY, ORCA_AGENT_SESSION_ID, ORCA_AGENT_HOOK_TOKEN…) or the CLI would take the
 *  worker for an agent. Fills APPDATA = %USERPROFILE%\AppData\Roaming, LOCALAPPDATA, HOME = USERPROFILE,
 *  ORCA_USER_DATA_PATH = %APPDATA%\orca (observed value), GH_PROMPT_DISABLED=1, GIT_TERMINAL_PROMPT=0.
 *  Keeps PATH/Path, SystemRoot, windir, ComSpec, PATHEXT, TEMP, TMP, USERPROFILE. */
export function cliEnv(base: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform): Record<string, string> {
  throw new Error("not implemented");
}

/** Orca CLI JSON envelope (observed): {"id", "ok": true, "result": {...}, "_meta": {"runtimeId"}} or
 *  {"ok": false, "error": {"code", "message", ...}}. Some commands print progress first: take the last JSON object. */
export const cliEnvelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }).passthrough(),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().optional(), message: z.string() }).passthrough() }).passthrough(),
]);

export function createCli(cfg: { exe: string | null; env: Record<string, string>; maxConcurrent: number; log(m: string): void }): OrcaCli {
  // TODO:
  //  - semaphore(maxConcurrent=4) shared by reads and writes; writes jump the queue.
  //  - read(): key = verb + argv. ttl hit → cached value; in flight → same promise; else execFile(exe,
  //    [...verb.split(" "), ...args, "--json"], {shell:false, windowsHide:true, timeout: CLI_TIMEOUT_MS[verb],
  //    maxBuffer: 16 MiB, env}) → cliEnvelope → ok:false throws CliError(code, message) → parse(result) (zod, domain).
  //    Retry once only when the spawn itself failed (ENOENT/EBUSY/EAGAIN), never after the process ran.
  //  - write(): argv chars > MAX_ARGV_CHARS → {failed, code:"too_long", preSend:true}. No cache, no sharing, no retry.
  //    ok → {ok}; ok:false → {failed, preSend: PRE_SEND_CODES.has(code), retryToken: error.retryRequest ??
  //    error.operationId ?? null}; timeout/kill → {ambiguous}; exit without envelope → {ambiguous}.
  //  - abort signal kills the child.
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/view.ts — who exists, where, in what state
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface ProjectRef { id: string; title: string; path: string; hostId: string | null; hidden: boolean }
export interface WorkspaceRef {
  listId: WorkspaceListId; projectId: string | null; title: string; branch: string | null;
  path: string; hostId: string | null; kind: "worktree" | "folder";
}

/** How a message can reach the session. Derived on every view; never stored. */
export type Reach =
  | { kind: "terminal"; handle: TerminalHandle }            // live PTY found in terminal list
  | { kind: "chat" }                                        // mail route (orchestration send --to orca_session_id:)
  | { kind: "unreachable"; why: "asleep" | "other-host" };  // listed "done" while asleep (no PTY), or not this host

export interface LastAssistant {
  text: string;
  /** Terminal rows: CLI agent list returns the WHOLE last message (observed up to 7 050 chars, ending at the real end).
   *  Chat rows: whitespace-collapsed head capped at 200 chars → complete=false. */
  complete: boolean;
}

/** Facts only status events give (in-memory; lost on worker restart until the next event). */
export interface TurnFacts { stateSince: number; lastOutcome: TurnOutcome | null; sawWorking: boolean }

export interface LiveSession {
  readonly id: SessionId;
  readonly surface: Surface;
  readonly agent: AgentId;
  readonly title: string;
  readonly state: OrcaState;
  readonly reach: Reach;
  readonly workspace: WorkspaceRef | null;    // null when the CLI worktree id joins no host workspace row
  readonly updatedAt: number;                 // CLI updatedAt (ms). Paseo activityAt = ISO of this
  readonly lastAssistant: LastAssistant | null;
  readonly turn: TurnFacts | null;
}

export type PartialReason =
  | "cli-unavailable" | "agents-failed" | "terminals-failed" | "workspaces-truncated" | "agents-truncated"
  | "terminals-truncated" | "other-hosts-omitted";

export interface FleetView {
  readonly at: number;
  readonly sessions: ReadonlyMap<SessionId, LiveSession>;
  readonly workspaces: readonly WorkspaceRef[];
  readonly projects: readonly ProjectRef[];
  /** Terminal agents that have not reported an id yet ("shows no ID until it first reports"). Not boardable. */
  readonly unidentified: number;
  readonly partial: readonly PartialReason[];
  bySession(paneKeyOrHandle: PaneKey | TerminalHandle): SessionId | null;
}

/** Observed `agent list --json` → result {agents[], truncated, hostScope{hostIds, omittedHostIds,
 *  omittedHostSelectors[{hostId, selector}]}}. Terminal row: paneKey "<tabId>:<leafId>", worktreeId "<repoUuid>::<abs path>".
 *  Chat row: paneKey "structured-agent-session-<id>:<pane>", worktreeId "folder:<uuid>" or "<uuid>::<path>". No handle. */
const cliAgentRow = z.object({
  orcaSessionId: z.string().min(1).optional(),     // absent until a terminal agent first reports
  kind: z.enum(["terminal", "chat"]),
  agent: z.string(),
  state: z.enum(["working", "blocked", "waiting", "done"]),
  worktreeId: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
  repo: z.string().nullable().optional(),
  hostId: z.string().nullable().optional(),
  paneKey: z.string(),
  title: z.string().nullable().optional(),
  lastAssistantMessage: z.string().nullable().optional(),
  updatedAt: z.number(),
}).passthrough();

/** Observed `terminal list --json` → result {terminals[], hostScope, topologyRevisions, totalCount, truncated}.
 *  Row: handle "term_<uuid>", ptyId "<worktreeId>@@<8hex>", worktreeId, worktreePath, tabId, leafId, title, connected,
 *  writable, lastOutputAt, preview, executionHostId, agentIdentity ("claude" | "codex" | absent: an agent NAME, not an id). */
const cliTerminalRow = z.object({
  handle: z.string().startsWith("term_"), tabId: z.string(), leafId: z.string(),
  worktreeId: z.string().nullable().optional(), connected: z.boolean().optional(), writable: z.boolean().optional(),
  executionHostId: z.string().nullable().optional(),
}).passthrough();

/** Pure. One join key for all three workspace id shapes:
 *   "folder:<uuid>"         → itself (same string in CLI rows, host workspace.list, events)
 *   "<uuid>::<path>"        → "path:" + normalizePath(path) + "@" + hostId   (CLI rows; event workspaceId)
 *   "identity:…" + row.path → "path:" + normalizePath(path) + "@" + hostId   (host workspace.list rows)
 *  normalizePath: backslash → slash, no trailing slash, lowercase on win32. */
export type WorkspaceKey = Brand<string, "WorkspaceKey">;
export function workspaceKey(input: { id?: string | null; path?: string | null; hostId?: string | null }): WorkspaceKey | null {
  throw new Error("not implemented");
}

/** Pure join. Inputs are parsed rows; output is the view. No I/O: unit-tested from recorded fixtures. */
export function buildView(input: {
  at: number;
  agents: readonly z.infer<typeof cliAgentRow>[] | null;          // null = CLI failed
  terminals: readonly z.infer<typeof cliTerminalRow>[] | null;
  workspaces: readonly WorkspaceRef[]; projects: readonly ProjectRef[];
  turnFacts: ReadonlyMap<PaneKey, TurnFacts>;
  flags: { agentsTruncated: boolean; terminalsTruncated: boolean; workspacesTruncated: boolean; otherHosts: boolean };
}): FleetView {
  // TODO:
  //  termByPane = Map(tabId + ":" + leafId → handle)
  //  wsByKey    = Map(workspaceKey(ws) → ws)
  //  for row of agents:
  //    !row.orcaSessionId → unidentified++; continue
  //    reach = row.kind === "chat" ? (isLocal(row.hostId) ? {chat} : {unreachable, "other-host"})
  //          : termByPane.has(row.paneKey) ? {terminal, handle} : {unreachable, "asleep"}
  //    lastAssistant = row.lastAssistantMessage ? {text, complete: row.kind === "terminal"} : null
  //    workspace = wsByKey.get(workspaceKey({id: row.worktreeId, path: after(row.worktreeId, "::"), hostId: row.hostId}))
  //  terminals === null → partial "terminals-failed" and every terminal reach is unreachable (deliver refuses
  //  instead of guessing a handle).
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/marker.ts — the one marker format
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** "[cb:<uuid>]" appended to the FIRST line of every board message. First line, because `agent read` keeps the head
 *  of a message and cuts the tail (observed: ~1 200 chars + "\n… (truncated)"). If the first line is longer than
 *  400 chars, the marker goes on its own first line instead. */
export const MARKER = /\[cb:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/;
export function stamp(text: string, id: MessageId): string { throw new Error("not implemented"); }
export function readStamp(text: string): MessageId | null { throw new Error("not implemented"); }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/conversation.ts — evidence source
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type ConversationEntry =
  | { kind: "user"; text: string; complete: boolean; boardMessageId: MessageId | null }
  | { kind: "assistant"; text: string; complete: boolean; tools: readonly string[] }
  | { kind: "tool"; name: string; state: string | null };

export interface Conversation {
  readonly sessionId: SessionId;
  /** agent read "state": "working" → unfinished (Paseo refuses an excerpt, as for a timeline gap); absent → unknown. */
  readonly turn: "settled" | "unfinished" | "unknown";
  readonly entries: readonly ConversationEntry[];   // oldest → newest, at most limit
  readonly windowFull: boolean;                     // agent read "limited"
  /** sha256(["orca-evidence/v1", sessionId, ...entries AS READ (role, text as returned, tool names)]).slice(0, 24).
   *  Hashes the as-read text, never the repaired tail, so it is a pure function of Orca's transcript window. */
  readonly evidenceId: EvidenceId;
}

/** Observed `agent read <id> --limit n --json` result: {orcaSessionId, kind, agent, source: "transcript" | "chat",
 *  entries[], limited, state?}. Terminal (transcript): {kind:"message", role, text, tools?: [{name}]} (tools ride on
 *  assistant messages, text often ""). Chat: {kind:"message", role, text} | {kind:"tool", name, state:"completed"}. */
const readResult = z.object({
  orcaSessionId: z.string(), kind: z.enum(["terminal", "chat"]), source: z.string(),
  entries: z.array(z.union([
    z.object({ kind: z.literal("message"), role: z.enum(["user", "assistant"]), text: z.string(),
               tools: z.array(z.object({ name: z.string() })).optional() }).passthrough(),
    z.object({ kind: z.literal("tool"), name: z.string(), state: z.string().optional() }).passthrough(),
  ])),
  limited: z.boolean().optional(), state: z.enum(["working", "blocked", "waiting", "done"]).optional(),
}).passthrough();

export const TRUNCATION_SUFFIX = "\n… (truncated)";

/** Pure. Normalize both entry shapes, parse markers, and repair the last assistant message's tail: if it ends with
 *  TRUNCATION_SUFFIX, and last.complete (terminal), and normalize(last.text) starts with normalize(head), use
 *  last.text and complete=true. Chats stay complete=false (question detection sees the head only: risk R3). */
export function toConversation(id: SessionId, raw: unknown, last: LastAssistant | null): Conversation {
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/deliver.ts — the only way anything is sent
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Who the recipient should see as the sender (Paseo parity):
 *  person → human-initiated sends (decision reply, clarification, tracked answer, digest, work request)
 *  board  → sourceAgentId "plugin:coordinator-board" (merge notifications)
 *  agent  → sourceAgentId = the coordinator (board facts). Exists only while that agent's shim call is open. */
export type Sender =
  | { kind: "person" }
  | { kind: "board" }
  | { kind: "agent"; call: AgentCall };

export interface Delivery {
  messageId: MessageId;
  to: SessionId;
  text: string;                              // Paseo envelope text; deliver() stamps the marker
  subject: string;                           // mail subject (mail routes); ≤ 120 chars
  mailType: "question" | "status" | "handoff";
  from: Sender;
  /** Paseo activeTurnBehavior "steer" ≈ "queue-in-agent": a working claude/codex TERMINAL takes the paste as queued
   *  input (Orca separates accepted from submitted); a working chat holds mail until its turn ends. Default "refuse". */
  whenWorking: "refuse" | "queue-in-agent";
  /** Photos already saved under the plugin data dir; listed as absolute paths (Orca has no image attachment). */
  images?: readonly { path: string; mimeType: string }[];
}

export type RouteKind = "terminal-input" | "mail" | "mail-as-caller";

export type RefuseReason =
  | "gone" | "blocked" | "waiting" | "working" | "asleep" | "other-host"
  | "too-long" | "no-board-sender" | "needs-focus" | "cli-unavailable" | "content-changed";

export type DeliveryOutcome =
  /** Paseo "sent". proof says how we know. */
  | { status: "delivered"; route: RouteKind; proof: "submitted" | "queued-in-agent" | "mail-id" | "transcript" }
  /** Paseo "pending/unconfirmed". Calling deliver() again with the same messageId only reconciles; it never re-sends. */
  | { status: "unconfirmed"; route: RouteKind; attemptedAt: number }
  /** Nothing left the worker. Safe to call again later with the SAME messageId (queued tracked replies rely on this). */
  | { status: "refused"; reason: RefuseReason };

/** Persisted BEFORE the first byte leaves (outbox.json: temp file + rename, 0600). One record per messageId, ≤ 1 000,
 *  pruned after 14 days. Owns transport facts only; Paseo receipts keep owning business facts (fingerprint, version). */
interface OutboxRecord {
  messageId: MessageId; to: SessionId; route: RouteKind;
  textDigest: string;          // sha256(stamped text): same id + different text → refused "content-changed"
  head: string;                // normalized first 400 chars of the stamped text (prefix match vs truncated transcript)
  state: "attempting" | "delivered" | "unconfirmed";
  at: number;
  proof?: "submitted" | "queued-in-agent" | "mail-id" | "transcript";
  mailId?: string;             // orchestration send result id
  retryToken?: string;         // reported by Orca on an ambiguous write; kept for diagnosis, never used automatically
}

/** Route table (pure). Nothing else picks a route.
 *                 terminal reach                          chat reach
 *  person   →  terminal-input (a user turn, like Paseo)    mail --from <board mailbox>; envelope says origin person
 *  board    →  mail --from <board mailbox>                  mail --from <board mailbox>
 *  agent    →  mail-as-caller (runs in the caller's shell)  mail-as-caller
 *  board mailbox missing → "no-board-sender" (Paseo: a sourced delivery never falls back to an unsigned prompt). */
export function chooseRoute(reach: Reach, from: Sender, boardMailbox: TerminalHandle | null): RouteKind | RefuseReason {
  throw new Error("not implemented");
}

export function createDeliver(deps: { cli: OrcaCli; view: Fleet["view"]; conversation: Fleet["conversation"];
                                      outboxPath: string; mailDir: string; boardSender: FleetDeps["boardSender"]; now(): number }) {
  return async function deliver(d: Delivery): Promise<DeliveryOutcome> {
    // TODO (per-recipient mutex: one delivery per SessionId at a time):
    // 1. text = stamp(d.text + imageLines(d.images), d.messageId); digest = sha256(text)
    // 2. rec = outbox.get(d.messageId)
    //    rec && rec.textDigest !== digest  → {refused, "content-changed"}
    //    rec?.state === "delivered"        → {delivered, rec.route, rec.proof}
    //    rec (attempting | unconfirmed)    → return reconcile(rec)          // NEVER exec again
    // 3. s = (await view({maxAgeMs: 0})).sessions.get(d.to)
    //    !s → gone · blocked → blocked · waiting → waiting   // transport safety: text typed into a permission prompt or
    //                                                         // an AskUserQuestion TUI can select an option
    //    reach unreachable → asleep | other-host
    //    working && (d.whenWorking === "refuse" || (reach terminal && s.agent ∉ {claude, codex})) → working
    // 4. route = chooseRoute(s.reach, d.from, await boardSender())
    //    terminal-input && text.length > MAX_ARGV_CHARS - 512 → too-long
    //    mail routes: write text to <mailDir>/<messageId>.txt, pass --body-file (no argv limit, no shell quoting)
    // 5. outbox.put({..., state: "attempting"})   ← durable before exec
    // 6. exec
    //    terminal-input: cli.write("terminal send", ["--terminal", h, "--text", text, "--enter", "--wait-submit", "10"])
    //    mail:           cli.write("orchestration send", ["--to", "orca_session_id:" + id, "--from", board,
    //                               "--type", d.mailType, "--subject", d.subject, "--body-file", f])
    //    mail-as-caller: d.from.call.exec(["orchestration", "send", "--to", ..., "--type", "status", "--subject", ...,
    //                               "--body-file", f])
    // 7. ok → delivered (submitted | queued-in-agent from the receipt; mail-id); failed && preSend → outbox.delete,
    //    refused (needs-focus when code is "outside_active_worktree", else gone); failed && !preSend | ambiguous →
    //    persist retryToken, wait 1.5 s, reconcile(rec)
    throw new Error("not implemented");
  };
  // reconcile(rec): terminal-input → conversation(rec.to, {limit: 100, fresh: true}); a user entry with
  //   boardMessageId === rec.messageId whose normalized text and rec.head agree on their common prefix → delivered
  //   ("transcript"); else unconfirmed. mail* → rec.mailId ? delivered("mail-id") : unconfirmed.
  //   100 is agent read's max: a busy recipient can push the message out of the window → stays unconfirmed (Paseo's
  //   own outcome when its 128-item tail misses it).
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/launch.ts — coordinator creation and worker dispatch
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Permission args the launch hook appends (terminal only). Paseo allowlist: coordinator claude auto|default,
 *  codex auto-review|auto; workers never "dangerous"/bypassPermissions (codex full-access excepted). Keyed by Paseo
 *  mode id so P/shared/dispatch.ts stays verbatim. Flag values are per CLI version: TODO(Phase D) verify each. */
export const PERMISSION_ARGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  claude: { default: [], auto: ["--permission-mode", "auto"] },
  codex: { "auto-review": [], auto: [], "full-access": [] },
};

export interface LaunchSpec {
  operationKey: string;                  // Paseo idempotencyKey (coordinator) / requestKey-derived (worker)
  agent: AgentId; workspace: WorkspaceRef;
  model?: string; effort?: string;       // the CLI refuses --effort without --model
  prompt: string;                        // charter + task; launch.ts appends the launch marker
  role: "coordinator" | "worker";
  modeId: string | null;                 // → PERMISSION_ARGS in the hook; why every board launch is --surface terminal
  title?: string;
}

export type LaunchOutcome =
  | { status: "started" | "adopted"; handle: TerminalHandle; sessionId: SessionId | null /* arrives on first report */ }
  | { status: "unconfirmed"; operationKey: string }   // reply lost and no Orca retry id: board says "check workspace"
  | { status: "refused"; reason: "cli-unavailable" | "unknown-agent" | "invalid-model" };

/** "[cb:L<12 hex of sha256(operationKey)>]" at the end of the prompt. The hook reads it (event.terminalId → journal),
 *  so a crash between spawn and reply still adopts the right terminal. It also stays in the first user turn, so
 *  `agent read` of a new session can confirm which launch made it. */
export const LAUNCH_MARKER = /\[cb:L([0-9a-f]{12})\]/;

interface LaunchRecord {
  operationKey: string; markerId: string; spec: LaunchSpec;
  state: "attempting" | "started" | "unconfirmed";
  handle?: TerminalHandle;              // from the hook (authoritative) or the CLI reply
  retryOperationId?: string;            // from an Orca error: the ONLY sanctioned retry ("never retry as a fresh launch")
  at: number;
}

export function createLauncher(deps: { cli: OrcaCli; journalPath: string; view: Fleet["view"]; now(): number }) {
  return {
    /** Read synchronously by the launch hook (2 s budget: no I/O inside the hook). */
    pendingByMarker(markerId: string): LaunchRecord | null { throw new Error("not implemented"); },
    /** Called by the hook; persists asynchronously. */
    noteHandle(markerId: string, handle: TerminalHandle): void { throw new Error("not implemented"); },
    async launch(spec: LaunchSpec, as?: AgentCall): Promise<LaunchOutcome> {
      // TODO:
      // rec = journal.get(spec.operationKey)
      //   started                                → adopted(rec.handle, view.bySession(rec.handle))
      //   attempting|unconfirmed + rec.handle    → adopted   (the hook saw the terminal)
      //   attempting|unconfirmed + retry id      → same argv + ["--retry-launch", id]
      //   attempting|unconfirmed, neither        → {unconfirmed}   (never a fresh launch)
      // else journal.put(attempting), then
      //   argv = ["--agent", a, "--worktree", selectorFor(ws) /* TODO(Phase D) selector syntax */, "--surface",
      //           "terminal", "--prompt", prompt + "\n" + marker, ...(model ? ["--model", m, ...(effort ? ["--effort", e] : [])] : [])]
      //   as ? as.exec(["agent", "launch", ...argv])   // Orca records "handed off by <coordinator>" (Paseo parent)
      //      : cli.write("agent launch", argv)
      //   ok → started(result.outcome.handle); failed with operation id → keep it, unconfirmed; ambiguous → unconfirmed
      throw new Error("not implemented");
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/signals.ts — queue drain triggers
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface StatusEvent {
  kind: "agent.status.changed"; workspaceId: string | null; workspaceListId?: string; paneKey: string;
  terminalId?: string; state: OrcaState; receivedAt: number; sessionId?: string;
  mainAgent?: { state: OrcaState; outcome?: TurnOutcome; stateStartedAt: number };
}
export interface WorkspaceRemovedEvent { kind: "workspace.removed"; workspaceId: string; workspaceListId?: string; path: string }

export type Signal =
  | { kind: "turn-ended"; sessionId: SessionId; outcome: TurnOutcome | null }   // ≈ Paseo agent.turn.after
  | { kind: "permission-cleared"; sessionId: SessionId }                         // ≈ agent.permission.after (+250 ms recheck)
  | { kind: "gone"; sessionId: SessionId }                                       // ≈ agent.close.after / archive.after
  | { kind: "changed" };                                                         // → panels.post("board.changed")

export type Observation =
  | { source: "event"; e: StatusEvent | WorkspaceRemovedEvent }
  | { source: "poll"; view: FleetView };

export interface SignalMemo {
  byPane: ReadonlyMap<PaneKey, { state: OrcaState; sawWorking: boolean; outcome: TurnOutcome | null; since: number }>;
  bySession: ReadonlyMap<SessionId, { state: OrcaState; sawWorking: boolean; missingPolls: number }>;
}

/** Pure. One reducer for both sources, so events and polling cannot disagree about what a turn end is.
 *  turn-ended: working → done|waiting, only if this pane/session was SEEN working (drops "first done after launch").
 *  permission-cleared: blocked → anything else. gone: missing from 2 consecutive polls, or its workspace removed.
 *  Events resolve paneKey → SessionId through the latest view (chat pane keys embed the id). An event for a pane the
 *  view cannot resolve yet updates byPane only; the next poll carries it over by paneKey. */
export function reduce(memo: SignalMemo, obs: Observation, resolve: (pane: PaneKey) => SessionId | null):
  { memo: SignalMemo; signals: readonly Signal[]; turnFacts: ReadonlyMap<PaneKey, TurnFacts> } {
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/orca/catalog.ts
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Shapes so P/shared/usage-routing.ts stays verbatim. From `account list --json` result.rateLimits.<agent>.
 *  {session, weekly, fableWeekly?, monthly?}.{usedPercent, windowMinutes, resetsAt} + updatedAt + error.
 *  remainingPct = 100 - usedPercent. Local host only (the CLI rejects --environment). */
export interface UsageWindow { key: string; usedPct: number; remainingPct: number; windowMinutes: number; resetsAt: number }
export interface ProviderUsage { providerId: AgentId; fetchedAt: number; windows: UsageWindow[]; status: "ok" | "error" }
export interface Catalog {
  installed: readonly { id: AgentId; name: string }[];      // `agent installed --json` → result.agents[{id, name, default}]
  usage: readonly ProviderUsage[];                          // [] on failure (Paseo: 3 s, failure → [])
  hosts: readonly { id: string; kind: "local" | "ssh" | "environment"; name: string; selector: string; connected?: boolean }[];
  /** Orca has no model/mode catalog: static suggestions + user-typed ids (Paseo copy becomes "추천 n개 · 직접 입력 가능"). */
  models: Readonly<Record<string, readonly string[]>>;
}
export interface RemoteSession { environment: string; id: SessionId; title: string; agent: AgentId; state: OrcaState }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/channel/protocol.ts — shim ⇄ worker (NDJSON over a named pipe / unix socket)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** \\.\pipe\orca-coordinator-board-<rootKey> on win32, /tmp/orca-coordinator-board-<rootKey>.sock elsewhere.
 *  rootKey = sha256(pluginRoot).slice(0, 12). Derivable from the shim's own location, so a chat (no launch hook,
 *  no env) still reaches it when its first prompt names the absolute shim path. */
export function pipePath(pluginRoot: string, platform: NodeJS.Platform): string { throw new Error("not implemented"); }

/** What the shim knows about itself. Everything is self-reported except token, which the worker can verify. */
export interface CallerClaim {
  terminalHandle: string | null;   // ORCA_TERMINAL_HANDLE
  paneKey: string | null;          // ORCA_PANE_KEY ("<tabId>:<leafId>"; joins agent list directly)
  agentSessionId: string | null;   // ORCA_AGENT_SESSION_ID (chats)
  worktreeId: string | null;       // ORCA_WORKTREE_ID ?? ORCA_WORKSPACE_ID
  token: string | null;            // CB_CALLER_TOKEN = hex HMAC-SHA256(secret, terminalHandle), set by the launch hook
}

export type BoardVerb = "help" | "read" | "classify" | "plan" | "assign" | "fact" | "review" | "report";

/** Line 1, shim → worker. Free text never travels in argv (cmd.exe re-parses %, ^, & in .cmd arguments): it comes from
 *  stdin ("-") or a --text-file/--job-file/--quote-file the shim reads and inlines here. */
export interface ChannelRequest {
  v: 1;
  verb: BoardVerb;
  flags: Record<string, string | boolean>;
  text?: string;
  caller: CallerClaim;
  cwd: string;
}

/** worker → shim, zero or more before the reply: "run `orca <argv> --json` in your shell". */
export interface ExecFrame { kind: "exec"; id: number; argv: readonly string[]; timeoutMs: number }
/** shim → worker. */
export interface ExecResultFrame { kind: "exec-result"; id: number; ok: boolean; result?: unknown; error?: { code?: string; message: string } }
/** worker → shim, last line; the connection closes after it. */
export interface ReplyFrame { kind: "reply"; exit: ShimExit; stdout: string; stderr?: string }

/** 0 ok · 1 command error · 2 plugin not reachable · 3 dropped mid-command (may or may not have happened)
 *  · 4 caller not allowed (not the coordinator / reporting off / not token-verified for this verb). */
export type ShimExit = 0 | 1 | 2 | 3 | 4;

/** The shim may re-send after a drop only for verbs whose execute() writes nothing. */
export const SAFE_TO_RESEND: ReadonlySet<BoardVerb> = new Set(["help", "read", "plan"]);

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/channel/hook.ts — agent.launch.before (pure, synchronous, < 1 ms)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface LaunchBeforeEvent {
  agent: string; workspaceId: string | null; workspaceKind: "worktree" | "folder" | null;
  terminalId?: string; command: string; env: Record<string, string>;
}

export interface HookConfig {
  platform: NodeJS.Platform;
  binDir: string; pipe: string; nodeExe: string;          // nodeExe = worker process.execPath (Orca's Electron)
  secret: Uint8Array | null;                               // loaded in activate(); null → no token
  workerPath: string | undefined;                          // fallback when event.env has no PATH/Path
  isLocal(workspaceId: string | null): boolean;            // from the last view (no I/O)
  pending(markerId: string): LaunchRecord | null;          // launcher.pendingByMarker
  noteHandle(markerId: string, handle: TerminalHandle): void;
}

/** Returns the event for next(). Rules:
 *  - always: env CB_PIPE, CB_BIN, CB_NODE; PATH = binDir + delimiter(platform) + existing, where the existing key is found
 *    case-insensitively ("Path" on Windows) and written back under the same name (never two PATH keys).
 *  - terminalId && secret → CB_CALLER_TOKEN = hex(HMAC-SHA256(secret, terminalId)). Stateless: survives worker restarts
 *    with nothing persisted per launch (derive, don't sync).
 *  - non-local workspace or a wsl.exe command: env only, no PATH edit (a Windows path in a Linux PATH is useless).
 *  - LAUNCH_MARKER in command → rec = pending(id): noteHandle(id, terminalId); append PERMISSION_ARGS[agent][rec.spec.modeId]
 *    right after the executable word. Launches without our marker get env only; their command is never touched.
 *  - never throws (a throw counts as "pass" and PATH injection would vanish silently): catch, log, return env-only. */
export function onAgentLaunch(cfg: HookConfig, ev: LaunchBeforeEvent): LaunchBeforeEvent {
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/channel/server.ts — caller verification and command dispatch
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** A caller with an open connection. Only server.ts can construct one (the symbol is module-private), which is what
 *  makes Sender {kind:"agent"} impossible to fabricate: you can send "as the coordinator" only while serving the
 *  coordinator's own command. */
declare const callToken: unique symbol;
export interface AgentCall {
  readonly [callToken]: true;
  readonly sessionId: SessionId;
  readonly trust: "token-verified-terminal" | "claimed-chat";
  /** Runs `orca <argv> --json` in the caller's own shell via ExecFrame. Rejects once the call has replied. */
  exec(argv: readonly string[], timeoutMs?: number): Promise<unknown>;
}

/** Each Paseo agent tool becomes one BoardCommand. audience decides who may call it; execute keeps Paseo's body. */
export interface BoardCommand<I> {
  verb: BoardVerb;
  tool: string;                                    // Paseo tool name, kept for the charter text
  description: string;                             // `coordinator-board help` prints these (generated, not hand-synced)
  audience: "coordinator" | "reporting-session";
  input: z.ZodType<I>;
  execute(input: I, ctx: { fleet: Fleet; agent: AgentCall }): Promise<{ text: string; isError?: boolean }>;
}

export function serveChannel(deps: {
  path: string; secret: Uint8Array; fleet: Fleet;
  commands: readonly BoardCommand<any>[];
  /** Paseo authorization: coordinator === caller || pendingCoordinator === caller; reporting meta === true. */
  allowed(audience: BoardCommand<unknown>["audience"], who: SessionId): boolean;
  log(m: string): void;
}): Disposable {
  // TODO per connection:
  //  line 1 → ChannelRequest (zod); malformed → exit 1
  //  identify(claim, await fleet.view()):
  //    token && terminalHandle && timingSafeEqual(token, HMAC(secret, terminalHandle))
  //      → sid = view.bySession(handle) ?? view.bySession(paneKey); trust "token-verified-terminal"
  //    else agentSessionId && view.sessions.get(id)?.surface === "chat" → trust "claimed-chat"
  //    else → exit 4 "unknown caller"
  //  coordinator audience requires "token-verified-terminal" (coordinators are always launched --surface terminal)
  //  cmd = commands by verb; input = cmd.input.parse({...flags, text}) → ZodError → exit 1 with the issues
  //  allowed() before AND after execute (Paseo re-verifies scope after every await)
  //  write ReplyFrame. Socket closed mid-command → AgentCall.exec rejects; the shim prints exit 3; receipts written by
  //  execute() (outbox, launch journal) decide what really happened.
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/cli/coordinator-board.ts + bin/ — the shim (bundled as dist/coordinator-board.cjs)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** bin/coordinator-board.cmd (PowerShell, cmd; Codex on Windows). Prefers Orca's own runtime: a known Node version. */
export const SHIM_CMD = `@echo off
setlocal
set "HERE=%~dp0"
if defined CB_NODE if exist "%CB_NODE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%CB_NODE%" "%HERE%..\dist\coordinator-board.cjs" %*
  exit /b %ERRORLEVEL%
)
where node >nul 2>nul && ( node "%HERE%..\dist\coordinator-board.cjs" %* & exit /b %ERRORLEVEL% )
echo coordinator-board: no Node.js runtime found 1>&2
exit /b 2
`;
/** bin/coordinator-board (sh): Git Bash (Claude Code's Bash tool on Windows), macOS, Linux. Same order as .cmd. */
export const SHIM_SH = "#!/bin/sh\n# TODO: CB_NODE with ELECTRON_RUN_AS_NODE=1, else node, else exit 2\n";

/** Shim main: argv = verb + flags (--*-file and "-" are read into ChannelRequest.text); connect to CB_PIPE ??
 *  pipePath(<shim dir>/..); send; answer ExecFrames with execFile(orcaExe(), [...argv, "--json"], {env: process.env})
 *  so Orca sees THIS agent as the actor; print the reply; exit with ReplyFrame.exit.
 *  orcaExe(): ORCA_CLI_COMMAND → ORCA_CLI_BIN_DIR\orca.exe (win32) or /orca → "orca". (Ensemble's extensionless
 *  lookup fails on Windows; this is the fix.) Re-send after a drop only for SAFE_TO_RESEND. */
export function shimMain(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<ShimExit> {
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/paseo/runtime.ts — what ported Paseo server files import instead of @getpaseo/plugin/server
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Replaces PluginHandlerContext. Paseo code that took (input, {paseo}) now takes (input, {fleet}). */
export interface BoardContext { fleet: Fleet; signal?: AbortSignal }

/** Replaces PluginServerContext.handle. Paseo hooks become Fleet signals (worker.ts). */
export interface BoardServer {
  handle<I, O>(rpc: { name: string; input: z.ZodType<I>; output: z.ZodType<O> },
               fn: (input: I, ctx: BoardContext) => Promise<O> | O): void;
}

/** Replaces defineAgentTool: same fields plus verb + audience. */
export function defineBoardCommand<I>(c: BoardCommand<I>): BoardCommand<I> { return c; }

/** Paseo agent metadata (coordinator-board/reports, operating-session, dispatch-intent/parent/mode, grade) moves to a
 *  plugin-side store keyed by SessionId (session-meta.json). Only the Paseo server ever read it. */
export interface SessionMetaStore {
  get(id: SessionId): Readonly<Record<string, unknown>>;
  set(id: SessionId, patch: Readonly<Record<string, unknown>>): void;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/paseo/server/discovery.ts (rewritten) — THE lane table
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Paseo's verbatim contract type (P/shared/contract.ts); shown here only for the sketch. */
type SessionRow = {
  id: string; title: string; projectId: string; projectTitle: string; workspaceTitle: string;
  model: string | null; provider?: string | null; reporting?: boolean; status?: string;
  nativePending?: boolean; permissionVersion?: string; decisionRequestedAt?: string; activityAt?: string;
  lane: "human" | "running" | "review" | "idle" | "unknown"; detail: string;
};

/** Orca facts → pre-classification lane. conversation.ts classify (verbatim) then promotes an idle row whose current
 *  evidence holds a question (or a matching judgment) to human/review exactly as in Paseo. That is how a plain-text
 *  question, which Orca reports as "done", becomes a human-lane card.
 *
 *  | Orca facts                                  | status  | lane    | nativePending | detail (ko)              |
 *  |---------------------------------------------|---------|---------|---------------|--------------------------|
 *  | blocked                                     | blocked | human   | true          | 세션에서 권한 요청 확인  |
 *  | waiting (AskUserQuestion-style TUI)         | waiting | human   | true          | 세션에서 선택 질문 확인  |
 *  | working                                     | running | running |               | 작업 중                  |
 *  | done, turn.lastOutcome = failure            | error   | review  |               | 오류 확인 필요           |
 *  | done, reach unreachable "asleep"            | closed  | idle    |               | 대화 종료                |
 *  | done, reach unreachable "other-host"        | idle    | idle    |               | 다른 호스트 세션         |
 *  | done (incl. interruption / cancellation)    | idle    | idle    |               | 다음 요청 대기 / 중단됨  |
 *  | no orcaSessionId yet                        | not a row (counted in view.unidentified)                       |
 *
 *  permissionVersion (blocked | waiting) = sha256([id, state, turn?.stateSince ?? updatedAt]); decisionRequestedAt is the
 *  same instant as ISO. New episode → new version; same episode → same version (Paseo's guarantee).
 *  model = null (Orca exposes no per-session model); provider = s.agent. */
export function laneFacts(s: LiveSession): Pick<SessionRow, "status" | "lane" | "detail" | "nativePending" | "permissionVersion" | "decisionRequestedAt"> {
  throw new Error("not implemented");
}

/** Paseo canReceiveBoardInput, honest version. Steer analog: only a working claude/codex TERMINAL coordinator. */
export function canReceiveBoardInput(s: LiveSession, coordinator: boolean): boolean {
  // blocked | waiting → false; reach unreachable → false; done && lastOutcome !== "failure" → true;
  // coordinator && working && reach terminal && agent ∈ {claude, codex} → true; else false
  throw new Error("not implemented");
}

export async function discoverSessions(fleet: Fleet, meta: SessionMetaStore): Promise<SessionRow[]> {
  // const view = await fleet.view();
  // return [...view.sessions.values()].map(s => ({ id: s.id, title: s.title || "세션 " + s.id.slice(0, 8),
  //   projectId: s.workspace?.projectId ?? "unassigned", projectTitle: projectOf(view, s)?.title ?? "프로젝트 미확인",
  //   workspaceTitle: s.workspace?.title ?? "워크스페이스 미확인", provider: s.agent, model: null,
  //   ...(meta.get(s.id)["coordinator-board/reports"] === true ? { reporting: true } : {}),
  //   activityAt: new Date(s.updatedAt).toISOString(), ...laneFacts(s) }));
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/paseo/server/conversation.ts — only excerpt() changes; regexes, classify, decorate cache stay verbatim
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Paseo's Evidence, minus deliveries (mail is confirmed by its mail id at send time, so board-facts.decorate no
 *  longer needs to find it in the recipient's timeline). */
export function excerpt(conv: Conversation): {
  id: string; turns: { role: "user" | "assistant"; text: string; truncated?: boolean }[];
  replies?: Map<string, string>; lastInputIds?: string[]; boardMessageHashes?: Map<string, string>;
  clarificationMessages?: Map<string, { bodyHash: string; response?: string }>; laterInput?: boolean;
} {
  // TODO: conv.turn === "unfinished" → throw (same message as Paseo's gap/staleCursor). "unknown" → accept.
  // id = conv.evidenceId. messageIds = entry.boardMessageId ? [it] : []  (replaces messageId/clientMessageId).
  // laterInput = tool entries after the last text entry (both Orca shapes are normalized to kind "tool").
  // turns: last 4 user/assistant texts, each last 2 000 chars, truncated = !complete || length > 2 000.
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// src/worker.ts — activate()
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface OrcaWorkerApiLike {
  host: FleetDeps["host"];
  events: { on(e: string, fn: (payload: any) => void): Disposable };
  hooks: { on(h: string, fn: (event: any, next: (e: any) => unknown) => unknown): Disposable };
  panels: { handle(name: string, fn: (input: unknown, c: { signal?: AbortSignal }) => unknown): Disposable;
            post(event: string, payload: unknown): void };
  storage: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
  statusBar?: unknown;
  log(m: string): void;
}

export default async function activate(orca: OrcaWorkerApiLike): Promise<void> {
  // TODO:
  //  pluginRoot = dirname(dirname(fileURLToPath(import.meta.url))); rootKey = sha256(pluginRoot)[0:12]
  //  dataDir = join(os.homedir() /* USERPROFILE on win32 */, ".orca-coordinator-board", rootKey)
  //  secret = storage.get("callerSecret") ?? (randomBytes(32) → storage.set)
  //  cli = createCli({exe: locateOrca(...), env: cliEnv(process.env, process.platform), maxConcurrent: 4, log})
  //  fleet = createFleet({host: orca.host, cli, dataDir, boardSender, now: Date.now, log})
  //  orca.events.on("agent.status.changed", e => fleet.observe({kind: "agent.status.changed", ...e}))
  //  orca.events.on("workspace.removed", e => fleet.observe({kind: "workspace.removed", ...e}))
  //  orca.hooks.on("agent.launch.before", (ev, next) => next(onAgentLaunch(hookCfg, ev)))
  //  serveChannel({path: pipePath(pluginRoot, process.platform), secret, fleet, allowed, commands: [coordinator.read,
  //    coordinator.classify, operations.plan, operations.assign, facts.command, trackedReview, reporting.command]})
  //  every P/shared defineRpc contract → orca.panels.handle(rpc.name, input => handler(rpc.input.parse(input), {fleet}))
  //  fleet.onSignal(s => {
  //    if (s.kind === "turn-ended" || s.kind === "permission-cleared") { resumeQueued(s.sessionId); mergeNotices.resume(s.sessionId) }
  //    if (s.kind === "gone") resumeReplies(s.sessionId)
  //    orca.panels.post("board.changed", {})      // a signal only; the frame pulls board.snapshot (post ≤ 256 KiB)
  //  })
  //  setInterval(30_000): fleet.view({maxAgeMs: 0}) → reducer + status bar count (P/shared/decision-count.ts)
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Per-snapshot call budget (enforced in view.ts / conversation.ts; asserted in tests with a counting OrcaCli fake)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const BUDGET = {
  /** host calls, in-process, every snapshot */
  host: ["project.list", "workspace.list{includeStatus}"],
  /** CLI processes every snapshot (parallel; ~0.55 s each observed; single-flight, shared for viewMaxAgeMs) */
  cliFixed: ["agent list", "terminal list"],
  /** agent read only for managed sessions whose lane needs evidence (idle / error), cache key (SessionId, updatedAt).
   *  At most 8 cache misses per snapshot at concurrency 3; the rest fill in the background, then post board.changed.
   *  Warm snapshot = 2 CLI calls; cold worst case = 10. */
  conversationMissesPerSnapshot: 8,
  viewMaxAgeMs: 2_000,
  conversationTtlMs: 60_000,      // Paseo's excerpt cache; also invalidated when updatedAt changes
  catalogTtlMs: { usage: 60_000, hosts: 60_000, installed: 300_000, remoteRunning: 30_000 },
  send: "1 fresh view (2 CLI) + 1 agent read (guard evidence) + 1 write; reconcile adds 1 agent read --limit 100",
} as const;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PORT_PLAN — the 28 P/server files under this design (the count asked for)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const PORT_PLAN = {
  /** 9: import paths only (tsconfig alias). */
  unchanged: ["decision-message", "display-usage", "notes", "preferences", "pr-merge", "project-decision-sources",
              "reply-photos", "session-photos", "snapshot-reads"],
  /** 3: type renames only (PluginHandlerContext → BoardContext, paseo → fleet, defineAgentTool → defineBoardCommand). */
  mechanical: ["recommendation", "tracked-decisions", "tracked-review"],
  /** 10: business logic kept; SDK call blocks replaced. The 6 send sites lose their copy of the
   *  "refetch 128 → find messageId → hash compare" recovery block: it becomes the same fleet.deliver(delivery) call. */
  callSites: ["conversation" /* excerpt() only */, "decisions", "clarifications", "board-facts", "merge-notifications",
              "digest", "usage-routing" /* fleet.catalog().usage */, "session-links" /* view.projects */,
              "operations" /* projects + command defs */, "prs" /* execCommand → runner, workspaces from view */],
  /** 6: rewritten against Orca (plus index.server.ts → src/worker.ts). */
  rewritten: ["discovery" /* lane table */, "lifecycle" /* fleet.launch, no pin */, "dispatch" /* catalog + launch */,
              "coordinator" /* BoardCommands + channel auth instead of agent.open.before */,
              "reporting" /* SessionMetaStore + command */, "project-icons" /* no Orca icon revision */],
} as const;
