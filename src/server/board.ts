// Adapted from paseo-coordinator-board index.server.ts @ 2e9d128: the snapshot, decision count, readiness
// and scope, board facts, the tracked decision ledger and its queue, and the session sends
// (board.send-decision, board.ask-clarification, tracked replies) through fleet.deliver. Paseo's hooks
// are Orca signals (src/orca/signals.ts) that the worker passes to signal(). Merge notices come later.
import { join } from "node:path";
import type { Fleet, PluginHandlerContext, PluginServerContext } from "../orca";
import type { ReplyEntry } from "../paseo/shared/reply-history";
import { boardReadiness } from "../paseo/shared/readiness";
import { decisionCount } from "../paseo/shared/decision-count";
import { sendDecision } from "../paseo/shared/decision-actions";
import { askClarification, sourceQuestion } from "../paseo/shared/clarifications";
import { boardDecisionCount, boardScope, boardSnapshot } from "../paseo/shared/contract";
import { SnapshotReads } from "../paseo/server/snapshot-reads";
import { NoteStore } from "../paseo/server/notes";
import { isManagedCoordinator, setCoordinator, PreferenceStore } from "../paseo/server/preferences";
import { catalogProjects, discoverSessions, liveSelection } from "./discovery";
import { ConversationReader, excerpt } from "./conversation";
import { decorateDecision, DecisionSender } from "./decisions";
import { ClarificationSender, clarificationHistory, restoreClarifiedDecision } from "./clarifications";
import { isCurrentMembership, managedSessions, releaseUnmanagedCoordinator } from "./session-links";
import { ProjectPullRequests } from "./prs";
import type { Command } from "../channel/names";
import { coordinatorCommands, runCommand } from "./coordinator";
import { BoardFacts } from "./board-facts";
import { TrackedDecisionStore } from "./tracked-decisions";
import { readProjectDecisionSources } from "../paseo/server/project-decision-sources";
import { trackedRecipient, usesSourceCoordinator } from "../paseo/shared/tracked-decisions";
import { canReceiveBoardInput } from "./discovery";
import type { Signal } from "../orca/signals";
import { BOARD_PREFIX, registerOperations, type OperationDeps } from "./operations";
import { translator } from "../i18n";
import { createHash } from "node:crypto";
import type { SessionId } from "../orca";

type Sdk = PluginHandlerContext["paseo"];

export type PullDeps = ConstructorParameters<typeof ProjectPullRequests>[1];

const NO_HOST: OperationDeps = { t: () => translator("en"), bin: "", focusedWorkspace: async () => null };

export function contribute(server: PluginServerContext, fleet: Fleet, dataDir: string, pulls?: PullDeps, host: OperationDeps = NO_HOST) {
  const notes = new NoteStore(join(dataDir, "notes.json"));
  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const reader = new ConversationReader();
  const prs = new ProjectPullRequests(prefs, pulls);
  const decisions = new DecisionSender(prefs, notes, reader, fleet);
  const facts = new BoardFacts(prefs, notes, reader, fleet);
  facts.register(server);
  const commands = coordinatorCommands(prefs, reader, notes, { fact: facts.tool });
  const lifecycle = registerOperations(server, prefs, fleet, decisions, dataDir, host, facts);
  // A chat gets no launch environment: it learns the CLI's path and its own id from one board message.
  async function introduceChatCoordinator(sessionId: string) {
    const session = (await fleet.view({ maxAgeMs: 0 })).sessions.get(sessionId as SessionId);
    if (session?.surface !== "chat") return;
    const t = host.t();
    const cli = host.bin ? host.bin.replace(/[\\/]$/, "") + (process.platform === "win32" ? "\\coordinator-board.cmd" : "/coordinator-board") : "coordinator-board";
    const text = BOARD_PREFIX + "\n" + t(
      "이 채팅이 Coordinator Board의 코디네이터로 지정되었습니다. 채팅에서는 보드 명령 가운데 report만 쓸 수 있습니다. 사람이 결정할 일이나 확인할 결과는 셸에서 다음처럼 보고하세요. 글은 표준 입력으로 넘깁니다.\n",
      "This chat is now the Coordinator Board's coordinator. From a chat only the report command works. Report a decision for the person, or a result to check, from a shell like this, with the text on standard input:\n",
    ) + JSON.stringify(cli) + " report --as " + sessionId + " --kind question --text-file -";
    const messageId = createHash("sha256").update("coordinator-board/chat-coordinator/" + sessionId).digest("hex");
    const id = [messageId.slice(0, 8), messageId.slice(8, 12), "4" + messageId.slice(13, 16), "8" + messageId.slice(17, 20), messageId.slice(20, 32)].join("-");
    await fleet.deliver({ messageId: id, to: sessionId as SessionId, text, subject: "Coordinator Board", from: { kind: "person" }, whenWorking: "refuse" });
  }
  const tracked = new TrackedDecisionStore(join(dataDir, "tracked-decisions.json"),
    selected => {
      let partial = false;
      const items = readProjectDecisionSources(join(dataDir, "tracked-sources.json"), selected, () => { partial = true; });
      return {items,partial};
    });

  server.handle(boardReadiness, async () => {
    const scope = prefs.read();
    return { configured: scope.projects.length > 0, coordinator: scope.coordinator, decisionTitles: tracked.previewTitles(new Set(scope.projects)) };
  });
  async function buildSnapshot(paseo: Sdk, refreshPulls=false) {
    // GitHub can take seconds even when Orca already knows the current sessions.
    // Start both paths together, and consume both rejections via Promise.all.
    const catalogRead = paseo.projects.list();
    const [sessionView, fetched] = await Promise.all([
      (async () => {
        const catalog = await catalogRead;
        const rows = await discoverSessions(paseo, catalogProjects(catalog) ?? undefined);
        return buildSessionView(paseo, catalog, rows);
      })(),
      catalogRead.then(({ projects }) => prs.read(paseo, { projects, refresh:refreshPulls })),
    ]);
    const { choices, sessions, evidence, coordinatorRow } = sessionView;
    const latest = prefs.read();
    const visible = sessions.filter(row => isCurrentMembership(row, latest));
    const visibleNotes = notes.visible(new Set(visible.map(s => s.id)));
    facts.decorate(visible, evidence, visibleNotes);
    for (const row of visible) {
      decorateDecision(row, visibleNotes[row.id], latest, evidence.get(row.id));
      restoreClarifiedDecision(row, visibleNotes[row.id], latest, evidence.get(row.id));
    }
    // A deleted project stays in the saved selection so it returns if restored, but shows nothing meanwhile.
    const selected = liveSelection(latest.projects, catalogProjects(await catalogRead) && new Set(choices.keys()));
    const pullRequests = {
      projects: fetched.projects.filter(p => selected.has(p.projectId)),
      items: fetched.items.map(pr => ({ ...pr, projectIds: pr.projectIds.filter(id => selected.has(id)) })).filter(pr => pr.projectIds.length),
    };
    const targets = new Map(visible.map(row => [row.id, row]));
    if (coordinatorRow && coordinatorRow.id === latest.coordinator) targets.set(coordinatorRow.id, coordinatorRow);
    for (const id of evidence.keys()) if (!targets.has(id)) evidence.delete(id);
    const {history = [], ...trackedDecisions} = tracked.read(selected, visible, pullRequests, evidence);
    if (tracked.hasWaitingReplies()) {
      void resumeReplies({paseo}).catch(()=>console.warn("Could not check waiting board replies."));
    }
    const activity: ReplyEntry[] = [...history];
    for (const [key, receipt] of Object.entries(latest.pullMergeHistory)) {
      if (selected.has(receipt.projectId)) activity.push({...receipt, key, status:"recorded"});
    }
    const updates = new Map<string,string>();
    for (const [id, receipt] of Object.entries(latest.decisionReceipts)) {
      const detail = receipt.activity;
      if (!detail?.projectId || !selected.has(detail.projectId) || (receipt.messageId && receipt.messageId !== id)) continue;
      const reply = detail.recipientId && receipt.status === "sent" ? evidence.get(detail.recipientId)?.replies?.get(id) : undefined;
      if (reply && reply !== receipt.response) updates.set(id, reply);
      activity.push({...detail, origin:detail.origin ?? {sessionId:receipt.sessionId, cardId:receipt.sessionId, revision:receipt.version, questions:[{id:receipt.version}]}, key:id, status:receipt.status, messageId:id, response:reply ?? receipt.response});
    }
    if (updates.size) prefs.change(current => {
      for (const [id,text] of updates) if (current.decisionReceipts[id]) current.decisionReceipts[id].response = text;
    });
    for (const entry of activity) {
      const id = entry.recipientId ?? entry.pullMerge?.notification?.recipientId;
      const target = id && targets.get(id);
      if (!target) { delete entry.response; continue; }
      entry.canOpen = true;
      entry.recipientTitle = target.title;
      entry.recipientState = target.lane === "running" ? "running" : target.status === "idle" || target.status === "closed" || target.status === "error" ? target.status : "unknown";
    }
    const replyHistory = activity.sort((a,b) => b.at.localeCompare(a.at));
    const clarifications = clarificationHistory(prefs, targets, evidence);
    return { sessions: visible, notes: visibleNotes, pullRequests, trackedDecisions, replyHistory, ...(clarifications.length ? { clarifications } : {}),
      projects: [...choices.values()].map(p => ({ ...p, selected: selected.has(p.id) })), coordinator: latest.coordinator };
  }
  async function buildSessionView(paseo: Sdk, catalog: Awaited<ReturnType<Sdk["projects"]["list"]>>,
    rows: Awaited<ReturnType<typeof discoverSessions>>) {
    const scope = prefs.read();
    const choices = new Map(catalog.projects.map(p => {
      const id = p.projectId;
      return [id, { id, title: p.projectCustomName || p.projectDisplayName, path: p.projectRootPath, selected: scope.projects.includes(id), icon: p.icon }] as const;
    }));
    for (const row of rows) {
      if (!choices.has(row.projectId)) choices.set(row.projectId, { id: row.projectId, title: row.projectTitle, path: "", selected: scope.projects.includes(row.projectId), icon: undefined });
    }
    const titles = new Map([...choices].map(([id, p]) => [id, p.title]));
    const sessions = managedSessions(rows, scope, titles);
    const evidence = await reader.decorate(paseo, sessions, scope);
    const coordinatorRow = rows.find(row => row.id === scope.coordinator);
    if (coordinatorRow && !sessions.some(row => row.id === coordinatorRow.id)) {
      const observed = await reader.read(paseo, coordinatorRow).catch(() => null);
      if (observed) evidence.set(coordinatorRow.id, observed);
    }
    const clarifying = new Set(Object.values(scope.clarifications).flatMap(entry => {
      if (entry.status === "pending" && (entry.card.projectId === null ? scope.projects.length : scope.projects.includes(entry.card.projectId))) {
        return [entry.recipientId];
      }
      const original = sourceQuestion(entry.card);
      return original && entry.savedDecision && original.version !== scope.answers[original.sessionId]?.version
        ? [entry.recipientId] : [];
    }));
    // A running recipient may already have accepted a clarification, even
    // though the regular reader skips its timeline until the turn finishes.
    for (const row of sessions) {
      if (!clarifying.has(row.id) || evidence.has(row.id) || row.nativePending || row.status === "closed") continue;
      try {
        const page = await paseo.agents.ref(row.id).timeline.refetch({ direction: "tail", projection: "projected", limit: 48 });
        evidence.set(row.id, excerpt(page));
      } catch {
        // Fall back to Orca's current state when the transcript is unavailable.
      }
    }
    return { choices, sessions, evidence, coordinatorRow };
  }
  const reads = new SnapshotReads<Awaited<ReturnType<typeof buildSnapshot>>>(() => {
    const { projects, sessionLinks, coordinator, projectRepositories } = prefs.read();
    return JSON.stringify([projects, sessionLinks, coordinator, projectRepositories]);
  }, decisionCount);
  const invalidateCount = () => reads.invalidate();
  server.handle(sendDecision, async (input, { paseo }) => {
    const result = await decisions.send(paseo, input);
    invalidateCount();
    return result;
  });
  const clarifications = new ClarificationSender(prefs, fleet, (sdk, card) => buildSnapshot(sdk, card.kind === "pull"), (card, view) => {
    const original = sourceQuestion(card);
    if (original) {
      const latest = notes.visible(new Set([original.sessionId]))[original.sessionId];
      if (latest?.revision !== view.notes[original.sessionId]?.revision) return false;
    }
    if (card.kind !== "tracked") return true;
    const scope = prefs.read();
    const records = tracked.read(new Set(scope.projects), [], { items: [], projects: [] });
    const sameCard = (item:{source:string;projectId:string|null;id:string;fingerprint:string}) =>
      item.source === card.source && item.projectId === card.projectId && item.id === card.id && item.fingerprint === card.fingerprint;
    const before = view.trackedDecisions?.items.find(sameCard);
    const now = records.items.find(sameCard);
    return !!before && !!now && now.sourceCoordinatorId === before.sourceCoordinatorId;
  });
  server.handle(askClarification, async (input, { paseo }) => {
    try {
      return await clarifications.send(paseo, input);
    } finally {
      invalidateCount();
    }
  });
  // Orca cannot steer a running turn, so a queued reply waits for an idle recipient, coordinator included.
  const resumeReplies = tracked.register(server, () => new Set(prefs.read().projects), invalidateCount, async (item,targetId,{paseo}) => {
    let rows = await discoverSessions(paseo);
    const owned = usesSourceCoordinator(item);
    const current = () => {
      const scope = prefs.read();
      const managed = managedSessions(rows,scope);
      if (!scope.projects.length || (item.projectId && !scope.projects.includes(item.projectId))) return false;
      if (trackedRecipient(item,scope.coordinator,managed) !== targetId) return false;
      return !owned || managed.some(row => row.id === targetId) ||
        (isManagedCoordinator(scope,targetId) && targetId === scope.coordinator && rows.some(row => row.id === targetId));
    };
    if (!current()) return null;
    const handle=paseo.agents.ref(targetId);
    if (owned) rows = await discoverSessions(paseo);
    const agent=(await handle.refresh())?.agent;
    if (!current() || !agent || agent.id!==targetId || agent.internal || agent.archivedAt || agent.status==="closed" || agent.status==="error") return null;
    return {
      stillCurrent:current,
      send:async (answer,messageId)=>{
        const outcome = await fleet.deliver({ messageId, to: targetId as SessionId, text: answer, subject: "Coordinator Board", from: { kind: "person" }, whenWorking: "refuse" });
        if (outcome.status !== "delivered") throw new Error("not delivered: " + (outcome.status === "refused" ? outcome.reason : outcome.status));
      },
      accepted:async (_answer,messageId)=>(await fleet.reconcile(messageId))?.status === "delivered",
      ready:canReceiveBoardInput(agent,false),
    };
  }, input => {
    if (input.recipientId && input.images?.length) {
      throw new Error(host.t()("사진 첨부는 아직 보낼 수 없습니다. 글로만 보내 주세요.", "Photos cannot be sent yet. Send text only."));
    }
  });
  async function recipientAvailable(id: string) {
    if (!tracked.hasWaitingReplies(id)) return;
    await resumeReplies({ paseo: fleet.paseo }, id);
    // A status event can precede the state a fresh read reports.
    if (tracked.hasWaitingReplies(id)) {
      await new Promise(resolve => setTimeout(resolve, 250));
      fleet.invalidate();
      await resumeReplies({ paseo: fleet.paseo }, id);
    }
  }
  server.handle(boardSnapshot, (input, { paseo }) => {
    if (input.fresh) fleet.invalidate();
    return reads.read(() => buildSnapshot(paseo), input.fresh);
  });
  server.handle(boardDecisionCount, async (_input, { paseo }) => ({
    count: await reads.count(() => buildSnapshot(paseo)),
  }));
  server.handle(boardScope, async (change, { paseo }) => {
    const rows = await discoverSessions(paseo);
    if (change.kind === "project") {
      if (change.enabled && !rows.some(r => r.projectId === change.projectId)) {
        const catalog = await paseo.projects.list();
        if (!catalog.projects.some(p => p.projectId === change.projectId)) throw new Error("이 호스트에서 프로젝트를 찾을 수 없습니다.");
      }
      prefs.change(scope => {
        if (scope.projects.includes(change.projectId) !== change.enabled) delete scope.factCycle;
        scope.projects = scope.projects.filter(id => id !== change.projectId);
        if (change.enabled) scope.projects.push(change.projectId);
        else {
          for (const link of Object.values(scope.sessionLinks)) {
            if (link.targetProjectId === change.projectId) delete scope.sessionLinks[link.sessionId];
          }
          releaseUnmanagedCoordinator(rows, scope);
          for (const [id, d] of Object.entries(scope.judgments)) if (d.projectId === change.projectId) delete scope.judgments[id];
        }
        reader.retain(new Set(managedSessions(rows, scope).map(r => r.id)));
      });
    } else {
      prefs.change(scope => {
        if (change.sessionId && !managedSessions(rows, scope).some(r => r.id === change.sessionId)) throw new Error("관리할 프로젝트의 세션을 선택해 주세요.");
        setCoordinator(scope, change.sessionId);
      });
      if (change.sessionId) await introduceChatCoordinator(change.sessionId).catch(() => undefined);
    }
    invalidateCount();
    return { ok: true };
  });
  return {
    /** A session may take a queued board message now (src/orca/signals.ts). */
    async signal(signal: Signal) {
      if (signal.kind === "gone") await resumeReplies({ paseo: fleet.paseo }, signal.session);
      else await recipientAvailable(signal.session);
    },
    /** Retries every queue; the poll's catch-all for transitions no event reported. */
    async resumeWaiting(): Promise<boolean> {
      if (!tracked.hasWaitingReplies()) return false;
      await resumeReplies({ paseo: fleet.paseo });
      return true;
    },
    /** Orca reported a change: the next read sees it. */
    invalidate() { fleet.invalidate(); invalidateCount(); },
    count: () => reads.count(() => buildSnapshot(fleet.paseo)),
    configured: () => prefs.read().projects.length > 0,
    coordinator: () => prefs.read().coordinator,
    /** The coordinator launch the agent.launch.before hook should give its permission mode. */
    pendingLaunch: () => lifecycle.pendingLaunch(),
    /** Names the started coordinator once its terminal reports a session. */
    adoptCoordinator: () => lifecycle.adopt(),
    /** Who may run a coordinator-board command: only the designated coordinator, or any session on the board. */
    audience: (command: Command) => commands[command].audience,
    /** A coordinator-board command from the session the channel verified. */
    async command(command: Command, input: unknown, agentId: string) {
      const result = await runCommand(commands, command, input, { paseo: fleet.paseo, agent: { id: agentId } });
      if (command !== "read") invalidateCount();
      return result;
    },
    /** Version 0.1 kept the chosen projects in plugin storage. Take them once, only into an empty choice. */
    adoptLegacySelection(projectIds: readonly unknown[]): boolean {
      const ids = [...new Set(projectIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
      if (!ids.length || prefs.read().projects.length) return false;
      prefs.change(scope => { if (!scope.projects.length) scope.projects = ids; });
      invalidateCount();
      return true;
    },
  };
}
