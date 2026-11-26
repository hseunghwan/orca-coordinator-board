// Adapted from paseo-coordinator-board index.server.ts @ 2e9d128: the read RPCs only (snapshot, decision
// count, readiness, scope). Clarifications, board facts, tracked decisions, merge notices, coordinator
// tools and every send come with sending, so their parts of the snapshot are left out for now.
import { join } from "node:path";
import type { Fleet, PluginHandlerContext, PluginServerContext } from "../orca";
import type { ReplyEntry } from "../paseo/shared/reply-history";
import { boardReadiness } from "../paseo/shared/readiness";
import { decisionCount, displayLane } from "../paseo/shared/decision-count";
import { boardDecisionCount, boardScope, boardSnapshot, type Note, type SessionRow } from "../paseo/shared/contract";
import { SnapshotReads } from "../paseo/server/snapshot-reads";
import { NoteStore } from "../paseo/server/notes";
import { setCoordinator, PreferenceStore } from "../paseo/server/preferences";
import { catalogProjects, discoverSessions, liveSelection } from "./discovery";
import { ConversationReader } from "./conversation";
import { decorateDecision } from "./decisions";
import { isCurrentMembership, managedSessions, releaseUnmanagedCoordinator } from "./session-links";
import { ProjectPullRequests } from "./prs";

type Sdk = PluginHandlerContext["paseo"];

/** Paseo previews tracked decisions here; until those are read, the snapshot's own human-lane sessions stand in. */
function previewTitles(sessions: SessionRow[], notes: Record<string, Note>) {
  return sessions.filter(row => displayLane(row, notes[row.id]) === "human")
    .sort((a, b) => (a.decisionRequestedAt ?? a.activityAt ?? "").localeCompare(b.decisionRequestedAt ?? b.activityAt ?? ""))
    .slice(0, 3).map(row => row.title);
}

export function contribute(server: PluginServerContext, fleet: Fleet, dataDir: string) {
  const notes = new NoteStore(join(dataDir, "notes.json"));
  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const reader = new ConversationReader();
  const prs = new ProjectPullRequests(prefs);
  let decisionTitles: string[] = [];

  server.handle(boardReadiness, async () => {
    const scope = prefs.read();
    return { configured: scope.projects.length > 0, coordinator: scope.coordinator, decisionTitles: scope.projects.length ? decisionTitles : [] };
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
    for (const row of visible) decorateDecision(row, visibleNotes[row.id], latest, evidence.get(row.id));
    // A deleted project stays in the saved selection so it returns if restored, but shows nothing meanwhile.
    const selected = liveSelection(latest.projects, catalogProjects(await catalogRead) && new Set(choices.keys()));
    const pullRequests = {
      projects: fetched.projects.filter(p => selected.has(p.projectId)),
      items: fetched.items.map(pr => ({ ...pr, projectIds: pr.projectIds.filter(id => selected.has(id)) })).filter(pr => pr.projectIds.length),
    };
    const targets = new Map(visible.map(row => [row.id, row]));
    if (coordinatorRow && coordinatorRow.id === latest.coordinator) targets.set(coordinatorRow.id, coordinatorRow);
    for (const id of evidence.keys()) if (!targets.has(id)) evidence.delete(id);
    const activity: ReplyEntry[] = [];
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
    decisionTitles = previewTitles(visible, visibleNotes);
    return { sessions: visible, notes: visibleNotes, pullRequests, replyHistory,
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
    return { choices, sessions, evidence, coordinatorRow };
  }
  const reads = new SnapshotReads<Awaited<ReturnType<typeof buildSnapshot>>>(() => {
    const { projects, sessionLinks, coordinator, projectRepositories } = prefs.read();
    return JSON.stringify([projects, sessionLinks, coordinator, projectRepositories]);
  }, decisionCount);
  const invalidateCount = () => reads.invalidate();
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
    }
    invalidateCount();
    return { ok: true };
  });
  return {
    /** Orca reported a change: the next read sees it. */
    invalidate() { fleet.invalidate(); invalidateCount(); },
    count: () => reads.count(() => buildSnapshot(fleet.paseo)),
    configured: () => prefs.read().projects.length > 0,
  };
}
