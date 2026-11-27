// Adapted from paseo-coordinator-board index.server.ts @ 2e9d128: the snapshot, decision count, readiness
// and scope, board facts, the tracked decision ledger and its queue, and the session sends
// (board.send-decision, board.ask-clarification, tracked replies) through fleet.deliver. Paseo's hooks
// are Orca signals (src/orca/signals.ts) that the worker passes to signal(). Pull request mapping,
// lifecycle, merge and merge notices are ./prs.ts and ./merge-notifications.ts. Notes and the reporting
// flag (./reporting.ts, as Orca has no agent metadata) are saved as Paseo saves them. The coordinator
// home's project is never a project choice; its coordinator stays known as the board's coordinator.
// board.focus-cards (Orca only) gives the sidebar panel the Focus queue as cards (../focus-cards.ts).
import { join } from "node:path";
import type { Fleet, PluginHandlerContext, PluginServerContext } from "../orca";
import type { ReplyEntry } from "../paseo/shared/reply-history";
import { boardReadiness } from "../paseo/shared/readiness";
import { decisionCount } from "../paseo/shared/decision-count";
import { sendDecision } from "../paseo/shared/decision-actions";
import { askClarification, sourceQuestion } from "../paseo/shared/clarifications";
import { boardDecisionCount, boardScope, boardSnapshot, saveNote, setReporting } from "../paseo/shared/contract";
import { ReportingStore } from "./reporting";
import { SnapshotReads } from "../paseo/server/snapshot-reads";
import { NoteStore } from "../paseo/server/notes";
import { isManagedCoordinator, setCoordinator, PreferenceStore } from "../paseo/server/preferences";
import { catalogProjects, discoverSessions, liveSelection } from "./discovery";
import { ConversationReader, excerpt } from "./conversation";
import { decorateDecision, DecisionSender } from "./decisions";
import { ClarificationSender, clarificationHistory, restoreClarifiedDecision } from "./clarifications";
import { isCurrentMembership, managedSessions, registerSessionLinks, releaseUnmanagedCoordinator } from "./session-links";
import { ProjectPullRequests } from "./prs";
import { MergeNotifications } from "./merge-notifications";
import type { Command } from "../channel/names";
import { coordinatorCommands, runCommand } from "./coordinator";
import { dispatchCommands, WorkerJournal } from "./dispatch";
import { BoardFacts } from "./board-facts";
import { trackedReviewTool } from "./tracked-review";
import { NotSent, TrackedDecisionStore } from "./tracked-decisions";
import { photoFiles } from "./photo-files";
import { ProjectIcons } from "./project-icons";
import { HostWatch } from "./hosts";
import { boardHosts, boardWorkItems, boardWorkSettings, focusCards as boardFocusCards, setWorkSettings } from "../contract";
import { WorkItemStore, workItemView, type WorkEvent } from "./work-items";
import { verifyTool, WorkNotices } from "./work-notices";
import { focusCards } from "../focus-cards";
import { readProjectDecisionSources } from "../paseo/server/project-decision-sources";
import { trackedRecipient, usesSourceCoordinator } from "../paseo/shared/tracked-decisions";
import { canReceiveBoardInput } from "./discovery";
import type { Signal } from "../orca/signals";
import type { OrcaState } from "../orca/view";
import { BOARD_PREFIX, registerOperations, type OperationDeps } from "./operations";
import { cliPath } from "../channel/hook";
import { translator } from "../i18n";
import { createHash } from "node:crypto";
import type { SessionId, World } from "../orca";
import type { OrcaCli } from "../orca/cli";

type Sdk = PluginHandlerContext["paseo"];

export type PullDeps = ConstructorParameters<typeof ProjectPullRequests>[1];

const NO_HOST: OperationDeps = { t: () => translator("en"), bin: "", focusedWorkspace: async () => null };

export function contribute(server: PluginServerContext, fleet: Fleet, dataDir: string, pulls?: PullDeps, host: OperationDeps = NO_HOST) {
  const notes = new NoteStore(join(dataDir, "notes.json"));
  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const reader = new ConversationReader();
  const projectIcons = new ProjectIcons();
  const prs = new ProjectPullRequests(prefs, pulls);
  const decisions = new DecisionSender(prefs, notes, reader, fleet);
  const tracked = new TrackedDecisionStore(join(dataDir, "tracked-decisions.json"),
    selected => {
      let partial = false;
      const items = readProjectDecisionSources(join(dataDir, "tracked-sources.json"), selected, () => { partial = true; });
      return {items,partial};
    });
  const facts = new BoardFacts(prefs, notes, reader, fleet);
  facts.register(server);
  registerSessionLinks(server, prefs);
  const hosts = new HostWatch(fleet.cli, () => fleet.view());
  server.handle(boardHosts, () => hosts.read(host.t()));
  const workers = new WorkerJournal(join(dataDir, "workers.json"));
  const items = new WorkItemStore(join(dataDir, "work-items.json"));
  const notices = new WorkNotices(items, fleet, () => prefs.read().coordinator);
  /** Done checks and coordinator notices go out after any change, and again on each poll and turn end. */
  const runNotices = () => void notices.run().then(changed => { if (changed) invalidateCount(); },
    (error: unknown) => console.warn("Could not send work notices: " + (error instanceof Error ? error.message : String(error))));
  const work = {
    view: (sessionId: string) => { const item = items.bySession().get(sessionId); return item && workItemView(item); },
    reported: (sessionId: string, report: { kind: "question" | "review" | "done"; text: string }) => {
      if (items.apply([[sessionId, { kind: "report", report: report.kind, text: report.text, at: Date.now() }]]).changed) runNotices();
    },
  };
  /** When each linked pull request was last asked about: GitHub is read at most every PULL_CHECK_MS per item. */
  const pullChecked = new Map<string, number>();
  const PULL_CHECK_MS = 2 * 60_000;
  server.handle(boardWorkItems, async () => ({ items: Object.fromEntries([...items.bySession()].map(([id, item]) => [id, workItemView(item)])) }));
  server.handle(boardWorkSettings, async () => items.settings());
  server.handle(setWorkSettings, async input => items.setSettings(input));
  const reporting = new ReportingStore(join(dataDir, "reporting.json"), id => workers.worker(id)?.reports === true);
  const commands = coordinatorCommands(prefs, reader, notes, { fact: facts.tool, review: trackedReviewTool(prefs, tracked, prs, reader, () => invalidateCount()),
    verify: verifyTool(prefs, items, fleet, () => invalidateCount()),
    ...dispatchCommands(prefs, { fleet, journal: workers, items, bin: host.bin }) }, id => reporting.enabled(id), work);
  const lifecycle = registerOperations(server, prefs, fleet, decisions, dataDir, host, facts);
  // A chat gets no launch environment: it learns the CLI's path and its own id from one board message.
  async function introduceChatCoordinator(sessionId: string) {
    const session = (await fleet.view({ maxAgeMs: 0 })).sessions.get(sessionId as SessionId);
    if (session?.surface !== "chat") return;
    const t = host.t();
    const cli = host.bin ? cliPath(host.bin) : "coordinator-board";
    const text = BOARD_PREFIX + "\n" + t(
      "이 채팅이 Coordinator Board의 코디네이터로 지정되었습니다. 채팅에서는 보드 명령 가운데 report만 쓸 수 있습니다. 사람이 결정할 일이나 확인할 결과는 셸에서 다음처럼 보고하세요. 글은 표준 입력으로 넘깁니다.\n",
      "This chat is now the Coordinator Board's coordinator. From a chat only the report command works. Report a decision for the person, or a result to check, from a shell like this, with the text on standard input:\n",
    ) + JSON.stringify(cli) + " report --as " + sessionId + " --kind question --text-file -";
    const messageId = createHash("sha256").update("coordinator-board/chat-coordinator/" + sessionId).digest("hex");
    const id = [messageId.slice(0, 8), messageId.slice(8, 12), "4" + messageId.slice(13, 16), "8" + messageId.slice(17, 20), messageId.slice(20, 32)].join("-");
    await fleet.deliver({ messageId: id, to: sessionId as SessionId, text, subject: "Coordinator Board", from: { kind: "person" }, whenWorking: "refuse" });
  }

  const mergeNotifications = new MergeNotifications(prefs,(target,coordinator)=>tracked.mergeRecipient(target,coordinator),
    (sdk,target)=>prs.mergeScope(sdk,target), fleet);

  // The coordinator home holds the board's own coordinator, never managed work (src/orca/home.ts).
  const homeProject = async () => fleet.home?.project(await fleet.view()) ?? null;
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
    // Loading the board should not wait on an idle check or a provider turn.
    if (Object.values(latest.pullMergeHistory).some(entry => entry.pullMerge.notification?.status === "queued")) {
      void mergeNotifications.resume(paseo).catch(() => console.warn("Could not resume queued merge notifications."));
    }
    const visible = sessions.filter(row => isCurrentMembership(row, latest));
    for (const row of visible) {
      if (reporting.enabled(row.id)) row.reporting = true;
      else delete row.reporting;
    }
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
    const home = await homeProject();
    const icons = await Promise.all(catalog.projects.map(p => projectIcons.read(p.projectRootPath, p.icon)));
    const choices = new Map(catalog.projects.map((p, i) => {
      const id = p.projectId;
      return [id, { id, title: p.projectCustomName || p.projectDisplayName, path: p.projectRootPath, selected: scope.projects.includes(id), icon: icons[i] }] as const;
    }));
    for (const row of rows) {
      if (!choices.has(row.projectId) && row.projectId !== home) choices.set(row.projectId, { id: row.projectId, title: row.projectTitle, path: "", selected: scope.projects.includes(row.projectId), icon: undefined });
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
  /**
   * A session that left Orca takes its board records with it: the coordinator's judgment, the card's note and the
   * worker metadata (its work item stays, as stale, for the record). Checked against a fresh read first, so an
   * Orca restart that briefly lists nothing clears nothing.
   */
  async function forget(sessionId: SessionId) {
    const world = await fleet.view({ maxAgeMs: 0 });
    if (!world.sessions.size || world.sessions.has(sessionId)) return;
    prefs.change(scope => { delete scope.judgments[sessionId]; });
    const note = notes.visible(new Set([sessionId]))[sessionId];
    if (note && note.kind !== "clear") notes.update({ sessionId, kind: "clear", text: "", expectedRevision: note.revision }, note.origin ?? "person");
    workers.forget(sessionId);
    invalidateCount();
  }
  server.handle(saveNote, async (input, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === input.sessionId)) {
      throw new Error("이 호스트에서 해당 세션을 찾지 못했습니다. 보드를 새로 고쳐 주세요.");
    }
    const outcome = notes.update(input);
    if (outcome.ok) invalidateCount();
    // A person's done is the one confirmation the board takes for now (the coordinator's verify comes later).
    if (outcome.ok && input.kind === "done") items.apply([[input.sessionId, { kind: "confirmed", at: Date.now() }]]);
    return outcome;
  });
  server.handle(setReporting, async ({ sessionId, enabled }, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === sessionId)) throw new Error("세션을 찾지 못했습니다.");
    reporting.set(sessionId, enabled);
    invalidateCount();
    return { ok: true };
  });
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
      send:async (answer,messageId,images)=>{
        const photos = images?.length ? photoFiles(join(dataDir, "session-photos"), targetId, messageId, images) : [];
        const outcome = await fleet.deliver({ messageId, to: targetId as SessionId, text: answer, subject: "Coordinator Board", from: { kind: "person" }, whenWorking: "refuse", photos });
        if (outcome.status === "refused") throw new NotSent(outcome.reason);
        if (outcome.status !== "delivered") throw new Error("not delivered: " + outcome.status);
      },
      accepted:async (_answer,messageId)=>(await fleet.reconcile(messageId))?.status === "delivered",
      ready:canReceiveBoardInput(agent,false),
    };
  });
  prs.register(server, invalidateCount, mergeNotifications);
  async function recipientAvailable(id: string) {
    if (tracked.hasWaitingReplies(id)) {
      await resumeReplies({ paseo: fleet.paseo }, id);
      // A status event can precede the state a fresh read reports.
      if (tracked.hasWaitingReplies(id)) {
        await new Promise(resolve => setTimeout(resolve, 250));
        fleet.invalidate();
        await resumeReplies({ paseo: fleet.paseo }, id);
      }
    }
    await mergeNotifications.resume(fleet.paseo, id);
  }
  server.handle(boardSnapshot, (input, { paseo }) => {
    if (input.fresh) fleet.invalidate();
    return reads.read(() => buildSnapshot(paseo), input.fresh);
  });
  // Parsed as the dashboard parses board.snapshot, so both rank the same rows.
  server.handle(boardFocusCards, async (_input, { paseo }) =>
    focusCards(boardSnapshot.output.parse(await reads.read(() => buildSnapshot(paseo))), host.t()));
  server.handle(boardDecisionCount, async (_input, { paseo }) => ({
    count: await reads.count(() => buildSnapshot(paseo)),
  }));
  server.handle(boardScope, async (change, { paseo }) => {
    const rows = await discoverSessions(paseo);
    if (change.kind === "project") {
      if (change.enabled && change.projectId === await homeProject()) throw new Error("코디네이터 운영 폴더는 관리 프로젝트로 고를 수 없습니다.");
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
      if (signal.kind === "gone") {
        await resumeReplies({ paseo: fleet.paseo }, signal.session);
        await forget(signal.session);
      } else {
        await recipientAvailable(signal.session);
        runNotices();
      }
    },
    /**
     * Moves the work items by what Orca reported: each session's state, and a turn that ended without a report
     * as a done candidate (./work-items.ts). True when an item changed.
     */
    track(states: readonly (readonly [string, OrcaState])[], signals: readonly Signal[]): boolean {
      const at = Date.now();
      const events: [string, WorkEvent][] = states.map(([id, state]) => [id, { kind: "state", state, at }]);
      for (const signal of signals) {
        if (signal.kind === "turn-ended" || signal.kind === "gone") events.push([signal.session, { kind: signal.kind, at }]);
      }
      const applied = items.apply(events);
      if (applied.changed) runNotices();
      return applied.changed;
    },
    /**
     * The poll's part in tracked work: the stale clock for each session in this World, the state of linked pull
     * requests, and any done check or coordinator notice still waiting. True when an item changed.
     */
    async watchWork(world: World): Promise<boolean> {
      const at = Date.now();
      const settings = items.settings();
      const tracked = items.bySession();
      const events: [string, WorkEvent][] = [];
      for (const [sessionId] of tracked) {
        const session = world.sessions.get(sessionId as SessionId);
        if (session) events.push([sessionId, { kind: "tick", at, state: session.state, idleSince: session.state === "working" ? null : session.stateStartedAt, settings }]);
      }
      let changed = items.apply(events).changed;
      const scope = prefs.read();
      for (const item of tracked.values()) {
        if (!item.pull || !["running", "reported", "verifying"].includes(item.phase) || !scope.projects.includes(item.projectId)) continue;
        if (at - (pullChecked.get(item.itemId) ?? 0) < PULL_CHECK_MS) continue;
        pullChecked.set(item.itemId, at);
        const state = await prs.lifecycle(fleet.paseo, { projectId: item.projectId, repo: item.pull.repo, number: item.pull.number });
        if (state !== "UNKNOWN") changed = items.applyToItems([[item.itemId, { kind: "pull", state, at: Date.now() }]]).changed || changed;
      }
      return (await notices.run()) || changed;
    },
    /** A person opened the session from the board: stale work is back in progress. */
    reopened(sessionId: string): boolean {
      return items.apply([[sessionId, { kind: "reopened", at: Date.now() }]]).changed;
    },
    /** Retries every queue; the poll's catch-all for transitions no event reported. */
    async resumeWaiting(): Promise<boolean> {
      const merges = Object.values(prefs.read().pullMergeHistory).some(entry => entry.pullMerge.notification?.status === "queued");
      if (!tracked.hasWaitingReplies() && !merges) return false;
      if (tracked.hasWaitingReplies()) await resumeReplies({ paseo: fleet.paseo });
      if (merges) await mergeNotifications.resume(fleet.paseo);
      return true;
    },
    /** Orca reported a change: the next read sees it. */
    invalidate() { fleet.invalidate(); invalidateCount(); },
    count: () => reads.count(() => buildSnapshot(fleet.paseo)),
    configured: () => prefs.read().projects.length > 0,
    coordinator: () => prefs.read().coordinator,
    /** The coordinator and worker launches the agent.launch.before hook should give their permission mode. */
    pendingLaunches: () => [...[lifecycle.pendingLaunch()].filter(l => !!l), ...workers.pending()],
    /** Names the started coordinator and workers once their terminals report a session. */
    async adoptCoordinator() {
      const coordinator = await lifecycle.adopt();
      const adopted = workers.adopt(await fleet.view());
      const linked = items.link(Object.values(workers.read().launches).flatMap(l => l.sessionId ? [[l.requestKey, l.sessionId] as const] : []));
      return adopted || linked || coordinator;
    },
    /** Paseo's metadata of a worker the coordinator started through the board. */
    worker: (sessionId: string) => workers.worker(sessionId),
    /** Who may run a coordinator-board command: only the designated coordinator, or any session on the board. */
    audience: (command: Command) => commands[command].audience,
    /** A coordinator-board command from the session the channel verified. */
    async command(command: Command, input: unknown, agentId: string, caller: OrcaCli | null = null) {
      const result = await runCommand(commands, command, input, { paseo: fleet.paseo, agent: { id: agentId }, caller });
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
