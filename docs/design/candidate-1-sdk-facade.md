# Candidate 1 — Paseo SDK facade over one Orca snapshot

## Problem

The board must behave like `paseo-coordinator-board`. Paseo's server is about 4,300 lines across 28 `P/server` files. Much of it is guard logic that races itself: it re-checks scope, writes pending receipts, reconciles against the timeline, and never resends. The pure `P/shared` files and the pure client files are already being copied verbatim. The open question is what the server code runs on. Orca has no SDK that matches Paseo. Its facts are spread across the host API (`agents.list` per workspace, with a different workspace-id format from events) and about a dozen CLI verbs. The CLI verbs take about 0.6 s each to spawn on this Windows machine. There are no message ids, no seq/epoch, no `sourceAgentId`, no steer, no MCP tools and no pin. The constraints the design must honor:
- `SessionRow`/contract shapes are fixed (`P/shared/contract.ts`).
- The frame calls worker RPCs with Paseo's names.
- Hooks have a 2 s deadline and are skipped on failure.
- A request times out after 30 s by default (120 s at most).
- `terminal.sendText` only reaches the focused workspace.
- The worker has no `APPDATA`/`HOME`.
- Node will not spawn `.cmd` without a shell.
- Windows argv is capped at 32,767 UTF-16 units.

## Usage (caller's view)

README for the next contributor: *"P/server files are Paseo's, unchanged. `@getpaseo/plugin` and `@getpaseo/plugin/server` resolve to `src/paseo-sdk/*` through tsconfig/esbuild aliases. To learn what Orca does underneath, read `src/orca/world.ts` (what a session is and which lane it gets) and `src/orca/courier.ts` (how anything is sent). Nothing outside `src/orca` may import from it except `src/orca/index.ts`."*

```ts
// src/worker.ts (port of P/index.server.ts; only these lines differ)
export default async function activate(orca: OrcaWorkerApi) {
  const backend = await createOrcaBackend(orca, { pluginRoot });
  const server = backend.server;          // Paseo's PluginServerContext shape
  const dataDir = backend.dataDir;        // %APPDATA%\orca\plugin-data\coordinator-board
  // …P/index.server.ts body, unchanged…
  server.handle(boardSnapshot, async (input, { paseo }) => withPlacement(await buildSnapshot(paseo, input), backend));
}

// P/server/decisions.ts — byte-identical. What it calls now means:
await paseo.agents.ref(id).refresh();     // a ps read that started after this call (single-flight), projected to Paseo fields
await recipient.send(text, { messageId, activeTurnBehavior: "steer" });   // Courier: outbox reserve, then typed or mail
const page = await recipient.timeline.refetch({ direction:"tail", projection:"projected", limit:128 }); // agent read ≤100, markers → messageId

// P/server/board-facts.ts — byte-identical; runs inside a shim call from the coordinator:
await recipient.send(body, { sourceAgentId: caller, messageId, activeTurnBehavior: "steer" }); // caller-mail: orca runs in the coordinator's shell
```
The coordinator, in its terminal, runs `coordinator-board read --session <id>` or `coordinator-board classify --input-file j.json`. It gets the same text the MCP tool returned in Paseo.

## Shape

**Data structure first: `World`.** One snapshot is built from `orca worktree ps --json --limit 500` plus `orca repo list --json` (the second is cached for 60 s). It holds maps keyed by session, paneKey, terminal handle, worktree and repo. Every access pattern is a map lookup: listing, `refresh(id)`, event→session, shim caller→session, row→workspace→project. I chose `worktree ps` over `agent list` + `terminal list` + `workspace.list` + N×`agents.list` because, observed on 1.4.277, it already joins everything:
- per agent: `orcaSessionId`, `paneKey`, **`address`** (`term_…` for terminals, `orca_session_id:…` for chats), `state`, `stateStartedAt`, `updatedAt`, `mainAgent.outcome`, `interrupted`, `toolName/toolInput`, `prompt` (last asked), `lastAssistantMessage`, `parentPaneKey`, `subagents[]`, `hasLivePty`, `activity.unread`
- per worktree: `isArchived`, `isPinned`, `repoId`, `path`, `branch`, `linkedPR`, `address.worktree` (`identity:wt2:…`)
- `hostScope`, covering local and SSH hosts

Its cost is 0.68 s and 126 KB for 27 worktrees and 34 agents. That compares with 0.56 s for `agent list`, which has no handle and no outcome. **Steady-state cost per snapshot: one ps spawn, plus `agent read` only for rows whose `(id, updatedAt, state)` stamp changed, plus Paseo's own `gh` calls.** Single source of truth: `refresh()` and `list()` read the same ps fields. Paseo's `row.activityAt === agent.updatedAt` guard therefore compares like with like (host `stateStartedAt` is never mixed in).

**Identity.** Ids are branded types so formats cannot be mixed:

| Id | Example | Role |
|---|---|---|
| `OrcaSessionId` | uuid | `SessionRow.id`, Paseo agent id, `agent read` / `orca_session_id:` target. New id on terminal `/clear`, so a new conversation gets new evidence. That is correct for judgments and answers. |
| `PaneKey` | terminal `<tabId>:<leafId>` (== `ORCA_PANE_KEY` == `terminal list` `tabId:leafId`, 3/3 matched); chat `structured-agent-session-<id>:<tab>` | Join key for `agent.status.changed` and for shim callers. Also used for coordinator succession after `/clear` (`successorOf`). |
| `TerminalHandle` | `term_<uuid>` | Typed-send target and mail `--from`. |
| `WorktreeId` | `<repoId>::<path>` or `folder:<uuid>` | Canonical workspace key, same format as the event `workspaceId`. |
| `WorkspaceListId` | host `workspace.list` id (= event `workspaceListId`) | Only for host calls (`workspace.open`, `editor.open`). Joined lazily by host + normalized path. |
| `WorktreeSelector` | `identity:wt2:<env>:<uuid>` | `--worktree` for launches. |
| `RepoId` | uuid or `folder-workspace:<uuid>` | Paseo `projectId`. Icons (`repoIcon.src`) and the remote (`gitRemoteIdentity.remoteUrl`) come from `repo list`. |

A terminal agent with no `orcaSessionId` yet gets the key `pane:<paneKey>`. Its row shows in lane `unknown` and the Courier refuses to address it. This is encoded as `SessionKey`, not as a runtime check.

**Lanes.** The lane table lives in `world.ts:paseoAgentView` (sketch §2). It produces exactly the Paseo agent fields P/server reads. `discovery.ts:observedState/canReceiveBoardInput/permissionVersion` then run verbatim:
- blocked/waiting → `pendingPermissions` built from `toolName/toolInput` → human/nativePending (a TUI question is never typed into).
- working → running.
- done+failure → error/review.
- asleep terminal → closed/idle (never re-read, as in Paseo).
- done+unread → requiresAttention/review.
- done → idle.

`conversation.ts:classify` then promotes an idle row whose last assistant turn is a plain-text question to **human**. This fixes "Orca shows plain-text questions as done" without any new code.

**Evidence** (`transcript.ts`). Observed `agent read` shape: `{orcaSessionId, kind, agent, source:"transcript"|"chat", entries:[{kind:"message",role,text,tools?}|{kind:"tool",name,state}], limited, state?}`, with no timestamps. It maps to Paseo `TimelinePage`:
- `epoch = orcaSessionId`.
- `seqEnd` = number of text items after this one. A trailing plain tool call does not change `evidenceId`, just as in Paseo, whose digest hashes only text turns.
- The newest assistant text gets `timestamp = updatedAt`.
- `state:"working"` is **not** an error, because reconciliation reads recipients mid-turn.

`excerpt()` runs verbatim, so `evidenceId` keeps Paseo's 24-hex sha256 without a seq or epoch.

**Sending** (`outbox.ts` + `courier.ts` + `wire.ts`). Every send gets one final ASCII trailer line `[cb:v1:<messageId>:<p|b|a>[:sender]]`. The Paseo envelope is untouched. On read, `wire.unwrap` strips the trailer and the mail framing (`──── From: X (addr) (type) ────\nSubject:`, observed in chat transcripts). It turns the trailer back into `user_message.messageId` (person) or a `tool_call agentMessage{sender}` (board/agent provenance). As a result, Paseo's reconciliation loops (`decisions`, `clarifications`, `board-facts`, `tracked-decisions`, `merge-notifications`) and its `boardMessageHashes` (`startsWith("[Coordinator Board · ")`) work unchanged. The Outbox is written before the spawn. It stores the sent text and throws `AlreadySent` for a repeated messageId, so never-resend is structural (per encode-lessons-in-structure and make-operations-idempotent). If the recorded text differs (paste/mail framing) but the trailer matches, the read side returns the outbox text and logs a fidelity mismatch. Transport is chosen by one pure table, `chooseTransport`:

| Provenance | Surface | Transport |
|---|---|---|
| person | terminal | typed (`orca terminal send --enter --wait-submit`); mail when the text is over 30,000 chars |
| person | chat | mail |
| board | any | mail from the board sender |
| agent | any | caller-mail, run in the coordinator's shell |

Guards are Paseo's own. The Courier adds only addressability, not-blocked/waiting, and "idle unless steer". The focused-workspace limit applies to the host `terminal.sendText`; typed sends go through the CLI and the runtime instead. If step 2 shows the CLI is also focus-bound, a capability flag switches person sends to `typed-host` (focus + sendText) and every other send to mail.

**Events** (`transitions.ts`). `agent.status.changed` (terminal panes) and every World read (all panes, chats included) feed one detector. It emits Paseo's four hook names:
- working→done/waiting: turn.after
- blocked/waiting→other: permission.after
- missing in 2 consecutive snapshots: close.after
- `isArchived`: archive.after

The first sighting of a pane is never a transition. Events are deduplicated by `paneKey|state|stateStartedAt`. Over-firing is safe because Paseo's drains re-check everything, so the 30 s poll is a complete backstop.

**Coordinator channel** (`shim/*`). `defineAgentTool` definitions register into the shim server. Paseo's `agent.open.before` handlers are evaluated per call with a synthetic request, so tool gating is Paseo's own code. The pipe is `\\.\pipe\orca-coordinator-board-<sha256(userDataPath)[:12]>`. It is computable from `ORCA_USER_DATA_PATH` alone, so chats with no launch hook can still reach it. The launch hook adds `CB_PIPE/CB_BIN/CB_NODE`. It prepends `CB_BIN` only to an **existing** PATH key, found case-insensitively (`Path` on Windows), joined with `path.delimiter`. The charter uses the absolute shim path anyway. Two shims ship: `bin/coordinator-board.cmd` (PowerShell/cmd agents, e.g. Codex) and `bin/coordinator-board` (sh, for Claude's Git-Bash tool). Both run `dist/cli.cjs` with `ELECTRON_RUN_AS_NODE=1` via `CB_NODE` or else `ORCA_AGENT_HOOK_NODE` (observed in agent env). JSON input goes through `--input-file`/stdin, never argv. Caller identity is resolved by paneKey → handle → session id. It is then proven once per connection by exec'ing `orca status` in the caller's shell and matching `caller.orcaSessionId`.

**CLI layer** (`cli.ts`):
- It is a closed set of typed verbs; argv and the `{id, ok, result|error, _meta}` envelope never leave `src/orca` (per boundary-discipline).
- `orca.exe` is found in this order: setting, then `dirname(execPath)/resources/bin`, then `%LOCALAPPDATA%\Programs\orca\resources\bin` (rebuilt from `USERPROFILE`), then `where`. It is always the `.exe`.
- Env: `commandEnv` plus `APPDATA/LOCALAPPDATA/HOME/ORCA_USER_DATA_PATH`.
- Concurrency: a 4-process semaphore and single-flight per read argv. Mutating verbs are serialized per target and never aborted once spawned.
- Timeouts: ps 15 s, read 10 s, send 20 s, launch 90 s, accounts 3 s (Paseo's usage deadline).
- zod parsing happens at the boundary, and a shape drift throws `CliShapeError`.

**Port cost (the count asked for).** Of the 28 `P/server` files, **3 need body changes**:
- `lifecycle.ts`: Orca cannot take a caller-chosen agent id, open a plugin-owned directory as a workspace, pin, or report `currentModeId`. It is rewritten over `Launcher`.
- `dispatch.ts`: `workspace.agents.create` becomes `Launcher.launch`, and mode verification reads the launch journal.
- `project-icons.ts`: the icon comes from `repoIcon` instead of `$PASEO_HOME/projects/icons`.

The other **25 are byte-identical** behind the import alias. `P/index.server.ts` becomes `src/worker.ts` with about 5 changed lines. Under a domain port, 19 files would need body changes: every file that touches `paseo.*` or `defineAgentTool`.

**What it deliberately does not do:**
- It does not pretend a capability exists: `setPinned` throws, which Paseo already maps to `pinFailed`.
- It never replays `--retry-request`.
- It never adds a fresh launch after an uncertain one.
- It does not use `terminal.read` screens as evidence.
- It does not read Claude `.jsonl` files.

## Synthesis decision

*(Filled in by arena.)*

## Tradeoffs accepted

- We accept a facade that **projects** Paseo fields (`pendingPermissions` from `toolName`, `requiresAttention` from `unread`, `messageId` from a trailer) in exchange for 25 of 28 server files staying byte-identical. Every projection sits in one table, so a wrong mapping is fixed in one place.
- We accept one ps spawn (~0.7 s) per guard `refresh()`, coalesced by single-flight, in exchange for guards that compare values from the same source as the listing.
- We accept a visible trailer line in every board message, in exchange for real reconciliation by id. Orca has no message ids.
- We accept 100 as the reconciliation window (Paseo uses 128). Older pending receipts stay "unconfirmed", which is the safe failure.
- We accept caching `agent read` by stamp with no 60 s TTL (a 10-minute safety TTL remains), in exchange for zero transcript spawns in steady state. This diverges from Paseo's cache internally but not in behavior.
- We accept a plugin-owned idle "Coordinator Board" terminal as the mail `--from` identity. Orca mail needs a sender handle.
- We accept that human replies to terminal agents are typed, against Orca's "never type into an agent's input" note. Paseo's semantics are a plain user turn, and `terminal send --enter` bracket-pastes into recognized agents and reports submission.

## Alternatives considered

- **Domain port** (`Sessions.list/read/deliver/launch`, callers rewritten). It has a smaller and more honest interface. But 19 files of carefully raced guard code would be rewritten, and every rewrite is a chance to diverge from Paseo, which is the opposite of the goal. The Orca-to-Paseo meaning would be spread across those callers instead of one table.
- **Thin per-call SDK shim** (each `ref().refresh()` → `agent show`, `list` → `agent list` + `terminal list` + host `agents.list` per workspace). It has the same surface as this design but no World. It needs 4+N spawns per snapshot, joins three id formats on every call, and lets `updatedAt` come from different sources in list and refresh. That would silently break Paseo's `activityAt` guard.
- **Mail-only transport** (every send via `orchestration send`). It is one path with built-in provenance. But it needs a sender terminal even for human replies, puts a From header on every human answer, and gives no submission receipt for terminals. Kept for chats, board and agent sends only.

## Open questions and risks

- Is `orca terminal send` bound to the focused workspace like host `sendText`? The design assumes no and keeps a `typed-host` fallback. This is the first thing to test in step 2.
- Does a 20 KB board message typed into Claude Code reach its transcript verbatim (so `hash(text)` matches), or as `[Pasted text #1]`? The outbox canonicalization covers either case, but which is it?
- Does `--from` accept a plugin-created plain shell terminal, and which `--type` should human replies to chats use (`status` vs `handoff`)? `question` would make the chat answer by mail.
- Do Claude and Codex TUIs queue `terminal send --enter` while a turn runs (our "steer")? If not, Courier should refuse with `Busy` and the request is queued as for workers.
- Should the designated coordinator follow its pane across `/clear` (`successorOf`), or be released as in Paseo?
- What is `worktree ps --limit`'s maximum, and does ps list sleeping terminal agents exactly as `agent list` does? Today both show 34.
- Should done+unread map to review (`requiresAttention`)? This mirrors Paseo's "finished, not yet looked at", but it means opening a session tab moves its row.
- The `toolName/toolInput` content for `blocked` rows was not observable (no blocked agent existed during the probe).

## Next implementation step

Build `cli.ts` + `world.ts` + `paseoAgentView` and run the verbatim `discovery.ts` + `conversation.ts` through `board.snapshot` via `orca plugin dev request`. Done when a session whose last turn is a plain-text question shows `lane:"human"`.

---

### Appendix: observed shapes (Orca 1.4.277, Windows, read-only probes; personal values redacted)

```text
worktree ps --json  -> result { worktrees[], hostScope{hostIds,omittedHostIds,omittedHostSelectors[{hostId,selector}]}, totalCount, truncated, installationId }
  worktree: workspaceKind(git|folder-workspace) worktreeId repoId hostId repo path branch isArchived isMainWorktree displayName
            workspaceStatus lastActivityAt linkedPR linkedGitLabMR comment isPinned isActive unread liveTerminalCount status
            address{environment, worktree:"identity:wt2:local:<uuid>", line} environment{id,name} parent agents[]
  agent:    paneKey address("term_<uuid>" | "orca_session_id:<uuid>") orcaSessionId parentPaneKey state agentType prompt taskTitle
            displayName conversationName lastAssistantMessage toolName toolInput interrupted
            mainAgent{state,outcome?,stateStartedAt} stateStartedAt updatedAt subagents[{id,state,startedAt,agentType,description}]
            hasLivePty programStatus subagentObservation activity{listed,status,unread,clearable,sortAt,title}
agent list --json   -> result { agents[{orcaSessionId,kind,agent,state,worktreeId,workspace,repo?,hostId,paneKey,title,lastAssistantMessage,updatedAt}], truncated, hostScope }
terminal list --json-> result { terminals[{handle,ptyId,incarnationId,orphaned,worktreeId,worktreePath,branch,tabId,leafId,title,connected,writable,lastOutputAt,preview,executionHostId,agentIdentity?}], hostScope, topologyRevisions, totalCount, truncated }
agent read <id> --limit n --json -> result { orcaSessionId, kind, agent, source:"transcript"|"chat", entries[], limited, state? }
  entries: {kind:"message",role:"user"|"assistant",text,tools?:[{name}]} | {kind:"tool",name,state}   (no timestamps / ids)
  chat mail arrives as a user message: "──── From: <name> (<addr>) (<type>) ────\nSubject: …\n…"
repo list --json    -> result { repos[{id,path,displayName,kind,repoIcon{type,src(data:),source,label}?,gitRemoteIdentity{canonicalKey,remoteName,remoteUrl}?,…}] }
account list --json -> result { rateLimits{<provider>{provider,session|null,weekly|null,monthly?,<x>Weekly?,updatedAt,error,status,planType?}}, <agent>{accounts[],activeAccountId}… }
                       window = {usedPercent,windowMinutes,resetsAt,resetDescription}
host list --json    -> result { hosts[{kind:local|ssh|environment,name,id,selector,machineName?,platform?,connected?}] }
envelope            -> { id, ok, result, _meta{runtimeId} }
agent env           -> ORCA_PANE_KEY, ORCA_TERMINAL_HANDLE, ORCA_WORKTREE_ID(=<repoId>::<path>), ORCA_USER_DATA_PATH(%APPDATA%\orca),
                       ORCA_AGENT_HOOK_NODE(<…>\Orca.exe), ORCA_CLAUDE_CONFIG_DIR, ORCA_TAB_ID
timings (spawn+parse): agent list 558 ms, terminal list 611, worktree ps 677, status 583, account list 634, agent read(48) 541
```
