// candidate-1 — Orca server layer for the Paseo-parity Coordinator Board worker.
//
// SHAPE IN ONE LINE: P/server/*.ts runs (almost) verbatim against a *Paseo SDK facade* whose every read is a
// projection of ONE coherent Orca snapshot (World, from orca worktree ps --json + orca repo list --json),
// whose every write goes through ONE never-resend Courier, and whose agent tools arrive over ONE named-pipe shim.
//
// tsconfig "paths": { "@getpaseo/plugin": ["src/paseo-sdk/plugin.ts"], "@getpaseo/plugin/server": ["src/paseo-sdk/server.ts"] }
// => P/server files keep their imports byte-for-byte. Body changes: lifecycle.ts, dispatch.ts, project-icons.ts (3/28).
//
// Module map (only src/orca/index.ts and src/paseo-sdk/* are importable from outside src/orca; enforced by
// scripts/check-imports.mjs in "npm run check": any import of "src/orca/<x>" from outside src/orca fails the build).
//
//   src/worker.ts                  composition root (port of P/index.server.ts; data dir + coordinator dir lines change)
//   src/paseo-sdk/plugin.ts        defineRpc, defineSettings, findSvgIconProblem          (alias of @getpaseo/plugin)
//   src/paseo-sdk/server.ts        PluginServerContext, PluginHandlerContext, defineAgentTool, execCommand, Paseo types
//   src/orca/index.ts              createOrcaBackend(orca) -> { server, sdk, dispose }    (the ONLY adapter entry)
//   src/orca/cli.ts                OrcaCli: locate orca.exe, env, spawn, envelope parse, semaphore, single-flight
//   src/orca/cli-schemas.ts        zod schemas for the CLI JSON we consume (private)
//   src/orca/world.ts              World snapshot + WorldReader + the Orca->Paseo projection tables (lanes live here)
//   src/orca/transcript.ts         orca agent read -> Paseo TimelinePage (seqEnd/epoch/messageId/sender recovered)
//   src/orca/wire.ts               trailer marker + mail-header codec (the only place that knows the wire text)
//   src/orca/outbox.ts             per-message journal: reserve-before-spawn, never resend
//   src/orca/courier.ts            send(): transport choice (typed | mail | caller-mail) + execution
//   src/orca/transitions.ts        agent.status.changed + poll diffs -> Paseo hooks (turn/permission/close/archive)
//   src/orca/shim/protocol.ts      pipe protocol types (also bundled into dist/cli.cjs)
//   src/orca/shim/server.ts        named-pipe server, caller resolution + proof, AsyncLocalStorage caller
//   src/orca/shim/launch-env.ts    agent.launch.before: env + PATH (pure, <2 s)
//   src/orca/catalog.ts            providers.* facade: installed agents, static model/mode tables, account usage
//   src/orca/launcher.ts           idempotent launch (marker + journal + --retry-launch), adoption of orcaSessionId
//   src/cli/coordinator-board.ts   the shim client -> dist/cli.cjs ; bin/coordinator-board (sh) + bin/coordinator-board.cmd

import type { OrcaWorkerApi } from "orca/worker"; // .orca/types

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 0. Branded ids. Every Orca id format gets its own type, so a terminal handle can never be passed where an
//    orcaSessionId is expected (the bug the v0.1 port had with terminalId vs workspace ids).
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** "c9ef3e4f-…" — conversation id. Stable for chats across /clear; a terminal agent gets a NEW one on /clear and has
 *  none until it first reports. This is SessionRow.id and the Paseo agent id. */
export type OrcaSessionId = Brand<string, "OrcaSessionId">;
/** Terminal: "<tabId>:<leafId>" (== ORCA_PANE_KEY == terminal list tabId:leafId, verified 3/3).
 *  Chat: "structured-agent-session-<orcaSessionId>:<tabId>". Stable per pane, survives /clear. Event join key. */
export type PaneKey = Brand<string, "PaneKey">;
/** "term_<uuid>" — the CLI terminal handle; ps agents[].address for terminal agents. */
export type TerminalHandle = Brand<string, "TerminalHandle">;
/** ps/agent-list worktreeId: "<repoId>::<path>" (git) or "folder:<uuid>" (folder). Same format as the event's
 *  workspaceId. This is the board's canonical workspace key and Paseo's agent.workspaceId. */
export type WorktreeId = Brand<string, "WorktreeId">;
/** host workspace.list id (== event workspaceListId). Needed only for host calls (workspace.open, editor.open). */
export type WorkspaceListId = Brand<string, "WorkspaceListId">;
/** ps address.worktree "identity:wt2:<env>:<uuid>" — the stable CLI selector for --worktree. */
export type WorktreeSelector = Brand<string, "WorktreeSelector">;
/** orca repo list id (git: uuid; folder: "folder-workspace:<uuid>"). == Paseo projectId. */
export type RepoId = Brand<string, "RepoId">;

/** A row the board can show but not address yet: a terminal agent that has not reported (no orcaSessionId). */
export type SessionKey = { kind: "session"; id: OrcaSessionId } | { kind: "pane"; paneKey: PaneKey };
/** The Paseo-visible id string for a SessionKey. "pane:" ids are never sendable (Courier rejects them by type). */
export function sessionKeyId(key: SessionKey): string { throw new Error("not implemented"); }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. The World: one coherent snapshot. Data structure first — every access pattern is a map lookup.
//    Built from TWO CLI calls: `orca worktree ps --json --limit 500` (workspaces + agents + handles + outcome,
//    local + SSH hosts) and `orca repo list --json` (projects, icons, remotes; cached 60 s).
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export type OrcaState = "working" | "blocked" | "waiting" | "done";
export type TurnOutcome = "success" | "failure" | "cancellation" | "superseded" | "interruption" | "unconfirmed";

/** Where a message to this session goes. Derived from ps agents[].address; never stored. */
export type Address =
  | { kind: "terminal"; handle: TerminalHandle }          // address "term_…"
  | { kind: "chat"; session: OrcaSessionId }              // address "orca_session_id:…"
  | { kind: "none"; why: "no-handle-yet" | "asleep" | "other-host" };

export interface SessionRecord {
  readonly key: SessionKey;
  readonly paneKey: PaneKey;
  readonly surface: "terminal" | "chat";
  readonly agent: string;                 // ps agentType: "claude" | "codex" | …
  readonly state: OrcaState;
  readonly stateStartedAt: number;        // ms
  readonly updatedAt: number;             // ms; Paseo agent.updatedAt / row.activityAt (ISO) — ONE source for list AND refresh
  readonly outcome: TurnOutcome | null;   // mainAgent.outcome of the last finished turn
  readonly interrupted: boolean;
  readonly tool: { name: string; input: string | null } | null; // ps toolName/toolInput: what a blocked/waiting pane waits on
  readonly lastPrompt: string | null;     // ps prompt (last asked) — used by launcher adoption (launch marker)
  readonly lastAssistant: string | null;
  readonly title: string;                 // taskTitle ?? displayName ?? conversationName
  readonly parentPaneKey: PaneKey | null; // Orca lineage (Paseo dispatch-parent analogue, read only)
  readonly backgroundWork: number;        // subagents with state working
  readonly unread: boolean;               // activity.unread — Paseo requiresAttention analogue
  readonly livePty: boolean;              // hasLivePty (terminals); chats: true
  readonly address: Address;
  readonly worktree: WorktreeId;
  readonly hostId: string;
}

export interface WorkspaceRecord {
  readonly id: WorktreeId;
  readonly selector: WorktreeSelector | null;   // address.worktree
  readonly repo: RepoId;
  readonly path: string;
  readonly branch: string;                      // "refs/heads/x" stripped
  readonly displayName: string;
  readonly kind: "git" | "folder-workspace";
  readonly isArchived: boolean;
  readonly isPinned: boolean;                   // read only — Orca has no pin setter
  readonly hostId: string;
  readonly linkedPR: { number: number; url: string; state?: string } | null;
}

export interface ProjectRecord {
  readonly id: RepoId;
  readonly name: string;                        // displayName
  readonly path: string;
  readonly kind: "git" | "folder";
  readonly remoteUrl: string | null;            // gitRemoteIdentity.remoteUrl (Paseo gitRuntime.remoteUrl)
  readonly icon: { revision: string; dataUrl: string } | null; // repoIcon.src (upload) -> project-icons
}

export interface World {
  readonly at: number;
  readonly sessions: ReadonlyMap<string, SessionRecord>;          // by sessionKeyId
  readonly byPane: ReadonlyMap<PaneKey, SessionRecord>;           // events, caller resolution, succession
  readonly byHandle: ReadonlyMap<TerminalHandle, SessionRecord>;  // caller resolution (ORCA_TERMINAL_HANDLE)
  readonly workspaces: ReadonlyMap<WorktreeId, WorkspaceRecord>;
  readonly projects: ReadonlyMap<RepoId, ProjectRecord>;
  /** ps hostScope: hosts covered and the ones not covered (paired environments need --environment). */
  readonly coverage: { hosts: readonly string[]; omitted: readonly { hostId: string; selector: string }[] };
  readonly truncated: boolean;
}

export interface WorldReader {
  /** Single-flight: concurrent callers share one spawn. maxAgeMs 0 = "a read that STARTED after this call"
   *  (guards use 0; snapshot uses 0; transitions poll uses 0; panels' cheap reads use 2000). */
  read(opts: { maxAgeMs: number; signal?: AbortSignal }): Promise<World>;
  /** Last completed World without spawning (events use it to resolve paneKey -> session). */
  peek(): World | null;
  /** host workspace.list id for a worktree, joined by (hostId, normalized path). Cached; host call, no CLI. */
  listIdFor(worktree: WorktreeId): Promise<WorkspaceListId | null>;
  /** The session now living in the pane an older session lived in (terminal /clear). Used ONLY to let the designated
   *  coordinator follow its pane; decisions/judgments/notes stay keyed to the conversation (new id = new evidence). */
  successorOf(old: OrcaSessionId): OrcaSessionId | null;
}

export function createWorldReader(deps: { cli: OrcaCli; host: OrcaWorkerApi["host"]; now(): number }): WorldReader {
  // TODO
  //   ps    = cli.ps()            (zod-parsed; ps.worktrees[].agents[])
  //   repos = cli.repos()         (60 s cache; icon revision = sha256(repoIcon.src).slice(0,12))
  //   for each worktree w (skip none; archived kept with isArchived so close/archive transitions can be detected)
  //     for each agent a: key = a.orcaSessionId ? session(a.orcaSessionId) : pane(a.paneKey)
  //       surface = a.paneKey.startsWith("structured-agent-session-") ? "chat" : "terminal"
  //       address = a.address?.startsWith("term_") ? terminal : a.address?.startsWith("orca_session_id:") ? chat
  //                 : surface==="terminal" && !a.hasLivePty ? none/asleep : none/no-handle-yet
  //   remember pane history: paneKey -> [orcaSessionId...] (in memory + storage, 256 panes) for successorOf
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Projection tables: Orca -> Paseo agent/workspace/project views. The ONLY place Orca state meets Paseo meaning.
//    discovery.ts:observedState / canReceiveBoardInput / permissionVersion then run verbatim on the view.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
/** Exactly the Paseo agent fields P/server reads (grepped: discovery, decisions, clarifications, digest,
 *  board-facts, merge-notifications, reporting, lifecycle, dispatch). Nothing more — no fake capabilities. */
export interface PaseoAgentView {
  id: string; title: string | null; workspaceId: WorktreeId | null; archivedAt: string | null; internal: boolean;
  provider: string | null; model: string | null; metadata: Record<string, unknown>;
  status: "initializing" | "running" | "idle" | "error" | "closed";
  updatedAt: string;                                          // ISO of SessionRecord.updatedAt
  activeTurn: { startedAt: string } | null;
  pendingPermissions: { id: string; title: string; name: string; description: string }[];
  attentionReason: "permission" | "error" | "finished" | null;
  attentionTimestamp: string | null;
  lastError: string | null;
  requiresAttention: boolean;
  backgroundWork: { count: number };
  currentModeId: string | null;                               // only for board-launched agents (launch journal)
}

/** LANE TABLE (first matching row wins). Comment column = resulting Paseo lane via verbatim observedState().
 *
 *  | # | Orca condition                                   | Paseo view                                                          | lane    |
 *  |---|--------------------------------------------------|---------------------------------------------------------------------|---------|
 *  | 1 | key.kind === "pane" (no orcaSessionId yet)       | status initializing                                                  | unknown |
 *  | 2 | workspace.isArchived                             | archivedAt = now  (row dropped by discovery)                         | —       |
 *  | 3 | state blocked                                    | pendingPermissions=[{id:paneKey@stateStartedAt,title:tool.name??"permission",name:tool.name,description:tool.input}], attentionReason permission, attentionTimestamp stateStartedAt, status running | human (nativePending) |
 *  | 4 | state waiting (TUI question, e.g. AskUserQuestion)| same as 3 with title "question" — answered IN the session, never typed into | human (nativePending) |
 *  | 5 | state working                                    | status running, activeTurn {startedAt}                               | running |
 *  | 6 | done && outcome failure                          | status error, attentionReason error                                  | review  |
 *  | 7 | done && terminal && !livePty (asleep)            | status closed                                                        | idle (never re-read; Paseo closed) |
 *  | 8 | done && unread                                   | status idle, requiresAttention true, attentionReason finished        | review  |
 *  | 9 | done                                             | status idle                                                          | idle    |
 *
 *  Then conversation.ts:classify (verbatim) promotes idle/review rows: plain-text question in the last assistant turn
 *  -> human (THIS is the "Orca shows plain-text questions as done" fix), user turn after a question -> review.
 *  permissionVersion = sha256(pendingPermissions tuple) changes when stateStartedAt or the tool changes.
 *  interruption / cancellation / superseded / unconfirmed outcomes fall through to 8/9 (a person stopping a turn is not
 *  an error in Paseo either). */
export function paseoAgentView(rec: SessionRecord, ws: WorkspaceRecord | undefined, local: LocalAgentFacts): PaseoAgentView {
  throw new Error("not implemented");
}
/** Facts Orca does not hold and the plugin keeps itself (plugin storage, keyed by orcaSessionId). */
export interface LocalAgentFacts { metadata: Record<string, unknown>; currentModeId: string | null }

export interface PaseoWorkspaceView {
  id: WorktreeId; projectId: RepoId; title: string; name: string; projectCustomName: null; projectDisplayName: string;
  internal: false; background: false; archivingAt: string | null; workspaceDirectory: string; setupStatus: "completed";
  gitRuntime: { remoteUrl: string | null; currentBranch: string | null };
  githubRuntime: { pullRequest: { url: string; number: number; headRefName: string | null; isMerged: boolean; state: string } | null };
  project: { checkout: { remoteUrl: string | null; cwd: string; mainRepoRoot: string } };
  projectRootPath: string; pinnedAt: string | null;
}
export function paseoWorkspaceView(ws: WorkspaceRecord, project: ProjectRecord | undefined): PaseoWorkspaceView { throw new Error("not implemented"); }

export interface PaseoProjectView {
  projectId: RepoId; projectCustomName: null; projectDisplayName: string; projectRootPath: string;
  projectCustomIconRevision: string | null;  // icon.revision -> project-icons reads it through ProjectIconSource
}
export function paseoProjectView(p: ProjectRecord): PaseoProjectView { throw new Error("not implemented"); }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. Transcript: orca agent read -> Paseo TimelinePage, so conversation.ts:excerpt and every reconciliation loop
//    (decisions, clarifications, board-facts, tracked-decisions) run verbatim.
//    Observed: { orcaSessionId, kind, agent, source:"transcript"|"chat", entries:[
//      {kind:"message", role:"user"|"assistant", text, tools?:[{name}]} | {kind:"tool", name, state} ], limited, state? }
//    No timestamps, no seq, no epoch, no message ids, newest <=100, no cursor.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export type TimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_call"; callId: string; name: string; status: string;
      agentMessage?: { event: "message"; sender: { id: string }; text: string } };
export interface TimelinePage {
  entries: { item: TimelineItem; seqEnd: number; timestamp?: string }[];
  epoch: string; error?: string; gap?: boolean; staleCursor?: boolean;
}

export interface TranscriptReader {
  /** limit is clamped to 100 (Paseo asks 48 for evidence, 128 for reconciliation — 128 becomes 100). */
  refetch(session: OrcaSessionId, opts: { limit: number }): Promise<TimelinePage>;
}
export function createTranscriptReader(deps: { cli: OrcaCli; world: WorldReader; outbox: Outbox; wire: WireCodec }): TranscriptReader {
  // TODO mapping, per entry, oldest -> newest:
  //   user text:  w = wire.unwrap(text)  // strips mail header + trailer marker
  //     w.marker && outbox.get(w.marker.messageId) -> canonical text = outbox entry's sent text (marker proves delivery;
  //        paste/mail framing must not break Paseo's hash(text) === messageHash). Log "fidelity" when they differ.
  //     w.marker?.provenance === "agent" | "board" -> tool_call { callId:"paseo-agent-message:"+id, status:"completed",
  //        agentMessage:{event:"message", sender:{id:w.marker.sender}, text} }   (board-facts / merge delivery check)
  //     else -> user_message { text, messageId: w.marker?.messageId }
  //     a mail from someone else (no marker) -> user_message with the header stripped
  //   assistant text "" with tools[] -> one tool_call per tool ; assistant text -> assistant_message
  //   kind:"tool" -> tool_call { callId: "orca-tool:"+index, name, status: state }
  // seqEnd (no absolute seq exists): for text items = number of text items AFTER it (0 = newest); tool items reuse
  //   the seqEnd of the text item before them. => identical text history gives identical evidenceId; a new text turn
  //   changes it; trailing plain tool calls do not (same as Paseo, whose digest only hashes text turns + agentMessage
  //   tool calls). Collision only if the last 4 texts AND the text count after them repeat exactly.
  // epoch = orcaSessionId (a terminal /clear gives a new id, i.e. a new epoch — matches Paseo semantics).
  // timestamp: only the newest assistant text gets one = ISO(SessionRecord.updatedAt) when the read's state is "done"
  //   (Paseo uses it for decisionRequestedAt). Older entries: none.
  // error: only on CLI failure or schema mismatch. state:"working" is NOT an error (Paseo's running timelines are
  //   not errors either; callers only build evidence for idle rows).
  throw new Error("not implemented");
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4. Wire codec: the one place that knows what our text looks like on the wire.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export type Provenance =
  | { kind: "person" }                                   // a human pressed send (decisions, clarifications, work/digest requests, tracked replies)
  | { kind: "board" }                                    // plugin-originated (merge notifications: Paseo sourceAgentId "plugin:coordinator-board")
  | { kind: "agent"; caller: CallerContext };            // on behalf of the coordinator (board facts: sourceAgentId = caller)

export interface Marker { messageId: string; provenance: Provenance["kind"]; sender: string | null }
export interface WireCodec {
  /** Appends ONE final ASCII line "[cb:v1:<messageId>:<p|b|a>[:<senderSessionId>]]" (and attachment paths above it).
   *  ASCII so it survives bracketed paste, ConPTY and transcript storage. Does not touch the Paseo envelope. */
  wrap(text: string, marker: Marker, attachments: readonly string[]): string;
  /** Strips "──── From: <name> (<addr>) (<type>) ────\nSubject: …\n" mail framing and the trailer; returns the marker. */
  unwrap(recorded: string): { text: string; marker: Marker | null; mailFrom: { name: string; address: string; type: string } | null };
}
export const wire: WireCodec = null as never;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 5. Outbox + Courier: sending. Paseo's own receipts (pending -> sent, reconcile, never resend) stay in P/server
//    verbatim; the Outbox is the adapter's own write-ahead record so that (a) a crash between spawn and receipt is
//    reconcilable from the transcript and (b) the SAME messageId can never be spawned twice, even by a buggy caller.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface OutboxEntry {
  messageId: string; to: OrcaSessionId; address: Address; transport: Transport; provenance: Provenance["kind"];
  text: string; textHash: string; reservedAt: number;
  state: "reserved" | "accepted" | "submitted" | "failed-before-spawn" | "uncertain";
  cliRetryRequestId?: string;   // reported by terminal send / orchestration send; recorded, NEVER replayed automatically
  witnessedAt?: number;         // agent.prompt.before saw our marker (terminal targets only)
}
export interface Outbox {
  /** Atomic (temp+rename, 0600) in <dataDir>/outbox.json; 2000 newest kept. Throws AlreadySent if messageId exists in
   *  any state but "failed-before-spawn". This is the structural never-resend guarantee. */
  reserve(entry: Omit<OutboxEntry, "state" | "reservedAt">): void;
  settle(messageId: string, state: OutboxEntry["state"], extra?: Partial<OutboxEntry>): void;
  get(messageId: string): OutboxEntry | null;
  witness(markerLine: string): void;
}
export class AlreadySent extends Error { constructor(readonly messageId: string) { super("already sent"); } }

/** typed: `orca terminal send --terminal term_x --text <wrapped> --enter --wait-submit 8 --json` (CLI goes through the
 *          runtime, not the plugin host, so no focus switch — VERIFY in step 2; if it is focus-bound, typed sends become
 *          "typed-host" = terminal.focus + host terminal.sendText, allowed ONLY for provenance person).
 *  mail:  `orca orchestration send --to orca_session_id:<id>|term_x --from <boardSender> --type status --subject … --body-file <tmp> --json`
 *  caller-mail: the same command run IN the caller's shell through the shim (protocol exec) — Orca records the
 *          coordinator as sender without --from. */
export type Transport = "typed" | "typed-host" | "mail" | "caller-mail";

/** Pure. The whole send policy in one table.
 *  | provenance | surface  | result                                                         |
 *  | person     | terminal | typed (or typed-host per capability probe); mail if text > 30000 chars (Windows argv cap 32767) |
 *  | person     | chat     | mail (only path into a chat)                                    |
 *  | board      | any      | mail from the board sender                                       |
 *  | agent      | any      | caller-mail (refuse if the caller has no live shim connection)   |  */
export function chooseTransport(p: Provenance["kind"], surface: SessionRecord["surface"], wrappedLength: number, caps: { typedViaCli: boolean }): Transport {
  throw new Error("not implemented");
}

export interface SendRequest {
  to: OrcaSessionId; text: string; messageId: string; provenance: Provenance;
  /** Paseo "steer": accept a working recipient. Terminal claude/codex queue typed input mid-turn; chats queue mail to
   *  turn end ("agent-session.queued-messages.v2"). Without steer a working recipient is refused (Busy). */
  steer: boolean;
  images: readonly { mimeType: string; data: string }[];
}
export type SendResult = { status: "accepted" | "submitted"; transport: Transport };
export class Busy extends Error {} export class NotAddressable extends Error {} export class Uncertain extends Error {}

export interface Courier {
  /** 1 fresh World (maxAge 0) -> recipient must exist, be addressable, not blocked/waiting, idle unless steer.
   *  2 images -> <dataDir>/outbox-images/<messageId>-<i>.<ext>; absolute paths go into the trailer block.
   *  3 outbox.reserve (throws AlreadySent)  4 spawn per chooseTransport  5 outbox.settle.
   *  Any failure after 4 starts -> settle "uncertain" and throw Uncertain. No retry, no --retry-request replay. */
  send(req: SendRequest): Promise<SendResult>;
}
/** The --from identity for mail sent by the board itself: a plugin-owned idle terminal ("Coordinator Board"), created
 *  lazily with host terminal.create in the coordinator's workspace, handle persisted, re-verified via World.byHandle. */
export interface BoardSender { handle(): Promise<TerminalHandle> }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 6. Transitions: Paseo hooks from Orca. Fed by agent.status.changed (terminal panes, immediate) AND by every World
//    read (all panes incl. chats). Drains in P/server are idempotent, so over-firing is safe; under-firing is not.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export type PaseoHookName = "agent.turn.after" | "agent.permission.after" | "agent.close.after" | "agent.archive.after";
export interface Transitions {
  /** event: { paneKey, state, mainAgent?{state,outcome,stateStartedAt}, workspaceListId?, terminalId? } */
  onStatusEvent(e: { paneKey: string; state: OrcaState; stateStartedAt?: number }): void;
  onWorld(w: World): void;
  on(hook: PaseoHookName, fn: (event: { agent: { id: string } }) => Promise<void> | void): () => void;
}
/** Rules (prev = last seen state for the pane; first sighting is NEVER a transition — launch-time "done" is not a turn end):
 *  working -> done|waiting              => agent.turn.after
 *  blocked|waiting -> working|done      => agent.permission.after   (index.server's own +250 ms second pass stays)
 *  present -> absent in 2 consecutive Worlds => agent.close.after     (1 miss can be ps truncation/flap)
 *  workspace.isArchived false -> true   => agent.archive.after
 *  dedup key: paneKey|toState|stateStartedAt. paneKey -> orcaSessionId via world.peek(); unknown -> world.read() once.
 *  Every fired hook also posts panels "board.changed" (debounced 400 ms). Poll: World read every 30 s while a board
 *  frame or the status bar needs it. */
export function createTransitions(world: WorldReader): Transitions { throw new Error("not implemented"); }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 7. Coordinator report channel: Paseo MCP tools -> shim CLI over a named pipe. Protocol types only.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
/** Pipe name is computable by both sides WITHOUT launch-hook env (chats get no hook):
 *  win32: \\.\pipe\orca-coordinator-board-<h12>   else: <os.tmpdir()>/orca-cb-<h12>.sock
 *  h12 = sha256(normalizeCase(ORCA_USER_DATA_PATH)).slice(0,12)  — one board per Orca profile. */
export function pipePath(userDataPath: string, platform: NodeJS.Platform): string { throw new Error("not implemented"); }

export namespace ShimProtocol {
  /** NDJSON, one connection per command. Client -> worker first line. */
  export interface Request {
    v: 1;
    tool: string;                 // a Paseo agent-tool name: read_board_conversation | classify_board_conversation | …
    input: unknown;               // JSON object; the CLI reads it from --input-file / stdin "-" (never from argv on Windows)
    claim: CallerClaim;           // self-reported, verified by the worker
    cwd: string;
  }
  /** From the agent's env. */
  export interface CallerClaim {
    paneKey: string | null;            // ORCA_PANE_KEY (terminal) — primary join key
    terminalHandle: string | null;     // ORCA_TERMINAL_HANDLE
    agentSessionId: string | null;     // ORCA_AGENT_SESSION_ID (chats)
    worktreeId: string | null;         // ORCA_WORKTREE_ID
    userDataPath: string | null;       // ORCA_USER_DATA_PATH (the worker learns the real profile path from this)
  }
  /** Worker -> client while handling: run `orca <args> --json` in YOUR shell (caller-mail, caller-launch, proof). */
  export interface Exec { kind: "exec"; id: number; args: string[]; timeoutMs: number }
  export interface ExecResult { kind: "exec-result"; id: number; ok: boolean; result?: unknown; error?: string; code?: string }
  /** Worker -> client, last line. exitCode: 0 ok, 1 tool error, 2 board unreachable/not allowed, 3 dropped mid-command. */
  export interface Reply { kind: "reply"; text: string; isError: boolean; exitCode: 0 | 1 | 2 | 3 }
  /** "help" is a pseudo-tool: the worker answers with the caller's toolset (names, descriptions, input JSON schema)
   *  derived from the registered defineAgentTool list — the CLI never hard-codes tool names (no hand-synced list). */
}

/** Verified caller. Resolution: paneKey -> World.byPane; else handle -> byHandle; else agentSessionId -> sessions.
 *  Proof (once per connection, cached 5 min per paneKey): exec ["status"] in the caller shell and require
 *  result.caller.orcaSessionId === resolved id. Unverifiable -> exitCode 2. Self-reported env alone is never trusted. */
export interface CallerContext {
  session: OrcaSessionId; paneKey: PaneKey;
  exec<T>(args: string[], timeoutMs?: number): Promise<T>;   // only valid during this request (AsyncLocalStorage)
}
export interface ShimServer {
  listen(): Promise<void>;   // removes a stale socket on POSIX; on win32 a second worker gets EADDRINUSE -> log + retry 5 s
  close(): Promise<void>;
  current(): CallerContext | null;
}

/** agent.launch.before — pure, no I/O, well under the 2 s deadline. Applied to EVERY launch (tool gating happens per
 *  call in the worker, as Paseo re-verifies per call), so the hook never needs to know who the coordinator is.
 *  env += { CB_PIPE, CB_BIN: <pluginRoot>\bin, CB_NODE: process.execPath }
 *  PATH: find the key case-insensitively in event.env ("Path" on Windows); if present, prepend CB_BIN with
 *        path.delimiter (";" on win32); if absent, do NOT invent one (a worker PATH could clobber the agent's) — the
 *        charter always uses the absolute "%CB_BIN%\coordinator-board.cmd" / "$CB_BIN/coordinator-board" anyway.
 *  command: untouched, EXCEPT for board launches carrying a launch marker (§9) whose agent has a MODE_ARGS entry:
 *        append whole tokens (e.g. claude: --permission-mode <auto|default>) without re-quoting the prompt. */
export function launchEnv(event: { agent: string; command: string; env: Record<string, string> }, ctx: { pipe: string; bin: string; node: string; launches: LaunchJournal }): { command: string; env: Record<string, string> } {
  throw new Error("not implemented");
}
// bin/coordinator-board.cmd (CRLF):
//   @echo off & setlocal
//   set "CB_RUN=%CB_NODE%" & if not defined CB_RUN set "CB_RUN=%ORCA_AGENT_HOOK_NODE%"
//   set ELECTRON_RUN_AS_NODE=1
//   "%CB_RUN%" "%~dp0..\dist\cli.cjs" %*
// bin/coordinator-board (sh, for Claude's Git-Bash tool on Windows and for POSIX):
//   ELECTRON_RUN_AS_NODE=1 exec "${CB_NODE:-${ORCA_AGENT_HOOK_NODE:-node}}" "$(dirname "$0")/../dist/cli.cjs" "$@"

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 8. CLI execution layer. Callers outside src/orca never see argv or the CLI envelope.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface OrcaCliLocation { exe: string; userDataPath: string; source: "setting" | "execPath" | "install" | "path" }
/** Order: settings "orcaCliPath" -> <dirname(process.execPath)>/resources/bin/orca.exe -> %LOCALAPPDATA%\Programs\orca\
 *  resources\bin\orca.exe (LOCALAPPDATA rebuilt from USERPROFILE when the worker env lacks it) -> `where orca.exe`.
 *  Always orca.EXE: Node refuses to spawn .cmd without shell:true (CVE-2024-27980), and shell:true reopens quoting bugs.
 *  The worker may run from a daemon-host profile copy of Orca.exe whose resources/bin is absent — hence the fallbacks.
 *  userDataPath: learned from the first shim request's claim, persisted; default %APPDATA%\orca. */
export function locateOrcaCli(env: Record<string, string | undefined>, execPath: string): Promise<OrcaCliLocation> { throw new Error("not implemented"); }

/** Closed set of verbs = the full CLI surface this plugin is allowed to touch. Mutating verbs are marked. */
export interface OrcaCli {
  ps(): Promise<PsResult>;                                                       // worktree ps --json --limit 500       15 s
  repos(): Promise<RepoListResult>;                                              // repo list --json          (60 s)     10 s
  read(id: OrcaSessionId, limit: number): Promise<AgentReadResult>;              // agent read orca_session_id:<id> --limit n --json  10 s
  accounts(): Promise<AccountListResult>;                                        // account list --json       (60 s)      3 s deadline like Paseo
  installed(): Promise<InstalledResult>;                                         // agent installed --json    (5 min)    10 s
  hosts(): Promise<HostListResult>;                                              // host list --json          (5 min)    10 s
  remoteAgents(environment: string): Promise<AgentListResult>;                   // agent list --environment <n> --json  15 s
  /** MUTATING */ typedSend(h: TerminalHandle, text: string): Promise<{ accepted: boolean; submitted: boolean; retryRequestId?: string }>;   // 20 s
  /** MUTATING */ mail(m: { to: string; from: TerminalHandle; subject: string; bodyFile: string; type: "status" }): Promise<{ messageId: string; retryRequestId?: string }>; // 15 s
  /** MUTATING */ launch(l: LaunchArgs): Promise<LaunchResult>;                  // agent launch … --json     90 s
}
/** Mechanics (private):
 *  - execFile(exe, [...args, "--json"], { shell:false, windowsHide:true, timeout, maxBuffer: 32 MiB, encoding:"utf8",
 *      env: commandEnv(process.env) + { ORCA_USER_DATA_PATH, APPDATA, LOCALAPPDATA, HOME } }) — commandEnv from CB/src/github.ts.
 *  - Envelope: { id, ok:true, result, _meta } | { ok:false, error:{ code, message } } ; non-zero exit -> parse stdout
 *      envelope if any, else CliUnavailable(stderr ≤300). result parsed by the verb's zod schema (passthrough extra keys);
 *      shape mismatch -> CliShapeError (logged once per verb+Orca version) — never "best effort" into domain types.
 *  - Semaphore: 4 concurrent orca processes (each ≈0.55–0.7 s on this machine, 1.4.277). Read verbs single-flight per argv.
 *      Mutating verbs bypass single-flight and are serialized per target (handle / session).
 *  - Abort: the panel's signal kills the child for READ verbs only; mutating verbs are never aborted once spawned
 *      (an abort cannot un-send; the Outbox records "uncertain").
 *  - Text on argv: Windows CreateProcess limit 32767 UTF-16 units -> typedSend asserts wrapped.length ≤ 30000;
 *      chooseTransport routes longer text to mail(--body-file). */
export function createOrcaCli(loc: OrcaCliLocation): OrcaCli { throw new Error("not implemented"); }

// Parsed result shapes (domain-side; the zod schemas live in cli-schemas.ts and are not exported).
export interface PsResult { worktrees: unknown[]; hostScope: World["coverage"]; truncated: boolean }
export interface RepoListResult { repos: unknown[] }
export interface AgentReadResult { orcaSessionId: string; kind: "terminal" | "chat"; source: "transcript" | "chat"; limited: boolean; state?: "working" | "done" | string;
  entries: ({ kind: "message"; role: "user" | "assistant"; text: string; tools?: { name: string }[] } | { kind: "tool"; name: string; state: string })[] }
export interface AccountListResult { rateLimits: Record<string, { provider: string; status: string; updatedAt: number;
  session: Window | null; weekly: Window | null; monthly?: Window | null; [k: string]: unknown }> }
interface Window { usedPercent: number; windowMinutes: number; resetsAt: number }
export interface InstalledResult { agents: { id: string; installed: boolean }[] }
export interface HostListResult { hosts: { kind: "local" | "ssh" | "environment"; name: string; id: string; selector: string; connected?: boolean }[] }
export interface AgentListResult { agents: unknown[]; truncated: boolean }
export interface LaunchArgs { agent: string; worktree: WorktreeSelector; prompt: string; model?: string; effort?: string; surface: "terminal" | "chat"; retryLaunch?: string }
export interface LaunchResult { outcome: { kind: "terminal" | "chat" | "structured"; handle?: string }; receipt?: { detail?: string }; operationId?: string }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 9. Launcher: idempotent agent creation (coordinator + workers). Replaces workspace.agents.create({agentId,
//    idempotencyKey}) — Orca cannot take a caller-chosen id, so idempotency is marker + journal + adoption.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface LaunchJournal {
  /** key = Paseo idempotencyKey. state: reserved -> launched(handle|opId) -> adopted(orcaSessionId) | uncertain. */
  get(key: string): LaunchRecord | null;
  reserve(key: string, spec: LaunchSpec): LaunchRecord;
  byMarker(marker: string): LaunchRecord | null;     // used by launchEnv (mode args) and adoption
}
export interface LaunchSpec { workspace: WorktreeId; agent: string; model?: string; effort?: string; modeId?: string;
  prompt: string; charter?: string; metadata: Record<string, unknown>; parent?: OrcaSessionId; surface: "terminal" }
export interface LaunchRecord { key: string; marker: string; spec: LaunchSpec; state: "reserved" | "launched" | "adopted" | "uncertain";
  handle?: TerminalHandle; operationId?: string; session?: OrcaSessionId }
export interface Launcher {
  /** 1 journal hit adopted & alive -> return it. 2 hit launched/reserved -> look for the marker "[cb:L<key8>]" in
   *  World sessions' lastPrompt / byHandle -> adopt. 3 not found & a reported operationId exists -> retryLaunch once.
   *  4 not found otherwise -> "uncertain" (never a second fresh launch; Paseo's uncertain rule).
   *  5 fresh -> reserve, launch --surface terminal, record handle; orcaSessionId adopted on the first World that shows it.
   *  asCaller: when a shim caller is current (assign_board_worker), the launch runs IN the caller's shell so Orca shows
   *  "handed off" from the coordinator. */
  launch(key: string, spec: LaunchSpec): Promise<LaunchRecord>;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 10. Catalog: providers.* facade. Orca has no model/mode catalog -> static tables, marked as such.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
/** One table per provider: models offered (recommendations + user-entered ids accepted), modes allowed and the argv
 *  each mode needs on a terminal launch. Coordinator allow-list mirrors P/server/dispatch.ts:21-45. */
export const PROVIDERS: Readonly<Record<string, { label: string; models: readonly { id: string; label: string; efforts: readonly string[]; isDefault?: boolean }[];
  modes: readonly { id: string; label: string; colorTier: "safe" | "moderate" | "dangerous"; argv: readonly string[] }[] }>> = null as never;
/** account list -> Paseo listUsage: windows from session/weekly/monthly/*Weekly; remainingPct = 100 - usedPercent;
 *  fetchedAt = updatedAt; status "ok" only. Local host only (account list rejects --environment). */
export function usageFromAccounts(a: AccountListResult): unknown { throw new Error("not implemented"); }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 11. The facade: the Paseo SDK subset P/server uses, implemented on 1–10. (src/paseo-sdk/server.ts re-exports types.)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface PaseoSdk {
  agents: {
    /** One page, hasMore:false (World is not paged). includeArchived:false honoured; filter.statuses honoured. */
    list(q: { filter?: { includeArchived?: boolean; includeBackground?: boolean; statuses?: string[] }; sort?: unknown; page?: unknown }):
      Promise<{ entries: { agent: PaseoAgentView; project: { projectKey: RepoId; projectName: string; workspaceName: string } }[]; pageInfo: { hasMore: false; nextCursor: null } }>;
    ref(id: string): {
      refresh(): Promise<{ agent: PaseoAgentView; project: { projectKey: RepoId } } | null>;   // World.read({maxAgeMs:0})
      /** sourceAgentId: undefined -> person; "plugin:coordinator-board" -> board; === current shim caller -> agent;
       *  anything else -> throws (Paseo never sends as a third party). messageId required (Outbox key). */
      send(text: string, o: { messageId: string; activeTurnBehavior?: "steer"; images?: { mimeType: string; data: string }[]; sourceAgentId?: string }): Promise<void>;
      setMetadata(patch: Record<string, unknown>): Promise<void>;   // plugin storage "agent-meta/<id>"
      timeline: { refetch(o: { direction: "tail"; projection: "projected"; limit: number }): Promise<TimelinePage> };
    };
  };
  workspaces: {
    list(q: { filter?: { includeBackground?: boolean; projectId?: string }; sort?: unknown; page?: unknown }): Promise<{ entries: PaseoWorkspaceView[]; pageInfo: { hasMore: false; nextCursor: null } }>;
    ref(id: string): { refresh(): Promise<PaseoWorkspaceView | null>; setPinned(v: boolean): Promise<never> /* throws Unsupported -> lifecycle reports pinFailed */ };
  };
  projects: { list(): Promise<{ projects: PaseoProjectView[] }> };
  providers: {
    listAvailable(): Promise<{ providers: { provider: string; available: boolean; error: string | null }[]; error: null }>;
    snapshot(): Promise<{ entries: { provider: string; label: string }[] }>;
    listModels(p: string, o?: { cwd?: string }): Promise<{ models: { id: string; label: string; isDefault: boolean; isSelectable: true; thinkingOptions: { id: string }[] }[] }>;
    listModes(p: string, o?: { cwd?: string }): Promise<{ modes: { id: string; label: string; colorTier: string }[] }>;
    listUsage(): Promise<unknown>;
  };
}

/** The server-context facade (src/paseo-sdk/server.ts). */
export interface PaseoServerFacade {
  handle<I, O>(rpc: { name: string; input: { parse(x: unknown): I } }, fn: (input: I, ctx: { paseo: PaseoSdk }) => Promise<O> | O): () => void;
  /** "agent.open.before" is not an Orca hook: handlers are kept and consulted by the shim server per call with a
   *  synthetic request { purpose:"interactive", agentId: caller.session, metadata, tools: [] } — exactly how Paseo
   *  decides which tools an agent gets (coordinator.ts:74-79, reporting.ts:37-40). The other four come from Transitions. */
  addHook(name: PaseoHookName | "agent.open.before", fn: (e: any, ctx: { paseo: PaseoSdk }) => unknown): () => void;
  registerSettings(def: { id: string; scope: "host"; version: number; schema: unknown }): void;  // -> plugin storage
}
export function defineAgentTool<I>(def: { name: string; description: string; input: { parse(x: unknown): I };
  execute(input: I, ctx: { paseo: PaseoSdk; agent: { id: string } }): Promise<{ text: string; isError?: boolean }> }): typeof def { return def; }
/** P/server/prs.ts execCommand: execFile shell:false + commandEnv; gh/git resolved via PATH then %ProgramFiles%\GitHub CLI. */
export function execCommand(cmd: string, args: string[], o: { cwd?: string; timeout?: number; maxBuffer?: number }): Promise<{ stdout: string }> { throw new Error("not implemented"); }

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 12. Entry.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
export interface OrcaBackend { server: PaseoServerFacade; sdk: PaseoSdk; dataDir: string; dispose(): Promise<void>;
  /** Extra per-row facts the frame needs that Paseo's SessionRow lacks (surface, focus target). Added to the snapshot
   *  output in the composition root, keyed by row id — discovery.ts stays verbatim. */
  placement(rowId: string): OrcaPlacement | null }
export interface OrcaPlacement { surface: "terminal" | "chat"; paneKey: PaneKey; worktree: WorktreeId; hostId: string; addressable: boolean }

/** Wires 1–11. Registers with Orca: panels.handle (via server.handle), events.on("agent.status.changed" |
 *  "workspace.removed"), hooks.on("agent.launch.before" -> launchEnv, "agent.prompt.before" -> outbox.witness),
 *  a 30 s World poll, and the shim pipe. */
export function createOrcaBackend(orca: OrcaWorkerApi, opts: { pluginRoot: string }): Promise<OrcaBackend> {
  throw new Error("not implemented");
}

// ── Caller usage (src/worker.ts, ported from P/index.server.ts) ─────────────────────────────────────────────────────
// export default async function activate(orca: OrcaWorkerApi) {
//   const backend = await createOrcaBackend(orca, { pluginRoot: dirname(fileURLToPath(import.meta.url)) + "/.." });
//   const server = backend.server;                      // same object shape P/index.server.ts receives as `server`
//   const dataDir = backend.dataDir;                    // was $PASEO_HOME/plugin-data/coordinator-board
//   ... the rest of P/index.server.ts unchanged: new DecisionSender(...), server.handle(boardSnapshot, ...),
//       server.addHook("agent.turn.after", onRecipientAvailable), registerCoordinatorTools(server, ...) ...
//   server.handle(boardSnapshot, async (input, { paseo }) => withPlacement(await buildSnapshot(paseo, input), backend));
// }
