// The board's work items: one record per piece of work the coordinator hands a session, kept the way Orca's
// orchestration keeps a worker (a dispatch id, what done means, explicit reports and state changes). assign
// creates the item before the launch (./dispatch.ts) and links it to the session once the terminal reports.
// reduceWorkItem is the one place a phase changes. Indirect signs (a turn that ended without a report, a pull
// request that merged or closed) only leave a done candidate, which the board asks the session about once
// (./work-notices.ts). Only the session's own report moves an item to reported, and only the coordinator's
// verify or a person moves it to done. The 30 s poll's tick marks work stale when it sits idle too long or
// leaves the done check unanswered; a report, new work or a person opening the session brings it back.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { OrcaState } from "../orca/view";
import { noticeStatus, staleReason, workCandidate, workPhase, workPull, workSettings, type WorkItemView, type WorkSettings } from "../contract";

const historyEntry = z.object({ phase: workPhase, at: z.number(), by: z.enum(["session", "coordinator", "person", "board"]) });
const workItem = z.object({
  itemId: z.string(), sessionId: z.string().nullable(), projectId: z.string(), workspaceId: z.string(),
  title: z.string(), doneMeans: z.string().nullable(), origin: z.literal("dispatch"),
  phase: workPhase, phaseAt: z.number(), createdAt: z.number(),
  candidate: workCandidate.optional(),
  report: z.object({ text: z.string(), at: z.number() }).optional(),
  staleReason: staleReason.optional(),
  pull: workPull.optional(),
  /** The last board message to the coordinator about this item: key is "<phase>@<phaseAt>". */
  notice: z.object({ key: z.string(), messageId: z.string(), status: noticeStatus }).optional(),
  history: z.array(historyEntry),
});
const file = z.object({ version: z.literal(1), items: z.record(z.string(), workItem), settings: workSettings.optional() });
export type WorkItem = z.output<typeof workItem>;
type File = z.output<typeof file>;
type NoticeStatus = z.output<typeof noticeStatus>;
type PullState = NonNullable<z.output<typeof workPull>["state"]>;

export const DEFAULT_WORK_SETTINGS: WorkSettings = { idleMinutes: 60, askMinutes: 30 };

export type WorkEvent =
  /** Orca's state for the session, from agent.status.changed or a World read. */
  | { kind: "state"; state: OrcaState; at: number }
  /** working became done or waiting (src/orca/signals.ts). */
  | { kind: "turn-ended"; at: number }
  /** The session's own coordinator-board report; a pull request URL in it links the item to that pull request. */
  | { kind: "report"; report: "question" | "review" | "done"; text: string; at: number }
  /** A person marked the card done. */
  | { kind: "confirmed"; at: number }
  /** The coordinator's verify. */
  | { kind: "verify"; result: "pass" | "fail"; at: number }
  /** A person opened the session from the board. */
  | { kind: "reopened"; at: number }
  /** The session left Orca (src/orca/signals.ts gone). */
  | { kind: "gone"; at: number }
  /**
   * The poll's clock: the session's Orca state, and idleSince, when it stopped working (null while it works). A
   * running item whose session sits done without a report is a candidate even when no turn-ended was seen: Orca
   * names a worker's session only around its first answer, so that first turn can end before the item is linked.
   */
  | { kind: "tick"; at: number; state: OrcaState; idleSince: number | null; settings: WorkSettings }
  /** The linked pull request's state as GitHub reports it. */
  | { kind: "pull"; state: PullState; at: number }
  /** How the done check went. */
  | { kind: "asked"; messageId: string; status: NoticeStatus; at: number }
  /** How the notice to the coordinator went. */
  | { kind: "noticed"; key: string; messageId: string; status: NoticeStatus };

const KEEP = 500;
const HISTORY = 20;
const REPORT_CHARS = 2000;
const MINUTE = 60_000;
const PULL_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d{1,9})\b/;

/** The first GitHub pull request URL in a report. */
export function pullIn(text: string): z.output<typeof workPull> | undefined {
  const found = PULL_URL.exec(text);
  return found ? { repo: found[1], number: Number(found[2]) } : undefined;
}

type By = z.output<typeof historyEntry>["by"];

function move(item: WorkItem, phase: WorkItem["phase"], at: number, by: By, extra: Partial<WorkItem> = {}): WorkItem {
  const { candidate: _dropped, staleReason: _reason, ...rest } = item;
  return { ...rest, ...extra, phase, phaseAt: at, history: [...item.history, { phase, at, by }].slice(-HISTORY) };
}

function withCandidate(item: WorkItem, reason: z.output<typeof workCandidate>["reason"], at: number): WorkItem {
  return item.candidate?.reason === reason ? item : { ...item, candidate: { reason, at } };
}

const open = (item: WorkItem) => item.phase === "running" || item.phase === "awaiting-input";

/** The next item for one event, or the same object when nothing changes (so a poll writes nothing). */
export function reduceWorkItem(item: WorkItem, event: WorkEvent): WorkItem {
  if (event.kind === "noticed") {
    const same = item.notice?.key === event.key && item.notice.messageId === event.messageId && item.notice.status === event.status;
    return same ? item : { ...item, notice: { key: event.key, messageId: event.messageId, status: event.status } };
  }
  if (item.phase === "done") return item;
  switch (event.kind) {
    case "state":
      if (event.state === "blocked" || event.state === "waiting") {
        return item.phase === "running" ? move(item, "awaiting-input", event.at, "board") : item;
      }
      if (event.state === "working") {
        if (item.phase === "awaiting-input" || item.phase === "stale") return move(item, "running", event.at, "board");
        if (item.phase === "running" && item.candidate) {
          const { candidate: _resumed, ...rest } = item;
          return rest;
        }
      }
      return item;
    case "turn-ended":
      return item.phase === "running" && !item.candidate ? withCandidate(item, "turn-ended", event.at) : item;
    case "report": {
      const pull = item.pull ?? pullIn(event.text);
      const linked = pull && pull !== item.pull ? { pull } : {};
      if (event.report === "done") {
        return move(item, "reported", event.at, "session", { ...linked, report: { text: event.text.slice(0, REPORT_CHARS), at: event.at } });
      }
      if (event.report === "question" && (item.phase === "running" || item.phase === "stale")) return move(item, "awaiting-input", event.at, "session", linked);
      if (item.phase === "stale") return move(item, "running", event.at, "session", linked);
      return pull && pull !== item.pull ? { ...item, pull } : item;
    }
    case "confirmed":
      return move(item, "done", event.at, "person");
    case "verify":
      if (item.phase !== "reported" && item.phase !== "verifying") return item;
      if (event.result === "fail") return move(item, "running", event.at, "coordinator");
      return move(item.phase === "reported" ? move(item, "verifying", event.at, "coordinator") : item, "done", event.at, "coordinator");
    case "reopened":
      return item.phase === "stale" ? move(item, "running", event.at, "person") : item;
    case "gone":
      return open(item) ? move(item, "stale", event.at, "board", { staleReason: "gone" }) : item;
    case "tick": {
      if (!open(item)) return item;
      if (item.phase === "running" && !item.candidate && event.state === "done" && event.idleSince !== null) {
        return withCandidate(item, "turn-ended", event.idleSince);
      }
      const ask = item.candidate?.ask;
      if (ask?.status === "sent" && event.at - ask.at > event.settings.askMinutes * MINUTE) {
        return move(item, "stale", event.at, "board", { staleReason: "no-answer" });
      }
      if (event.idleSince !== null && event.at - Math.max(item.phaseAt, event.idleSince) > event.settings.idleMinutes * MINUTE) {
        return move(item, "stale", event.at, "board", { staleReason: "idle" });
      }
      return item;
    }
    case "pull": {
      if (!item.pull || item.pull.state === event.state) return item;
      const seen = { ...item, pull: { ...item.pull, state: event.state } };
      if (event.state === "MERGED") {
        if (item.phase === "reported") return move(seen, "verifying", event.at, "board");
        return item.phase === "running" ? withCandidate(seen, "pr-merged", event.at) : seen;
      }
      if (event.state === "CLOSED") {
        if (item.phase === "reported" || item.phase === "verifying") return withCandidate(move(seen, "running", event.at, "board"), "pr-closed", event.at);
        return item.phase === "running" ? withCandidate(seen, "pr-closed", event.at) : seen;
      }
      return seen;
    }
    case "asked":
      if (!item.candidate) return item;
      if (item.candidate.ask?.messageId === event.messageId && item.candidate.ask.status === event.status) return item;
      return { ...item, candidate: { ...item.candidate, ask: { messageId: event.messageId, status: event.status, at: event.at } } };
  }
}

export function workItemView(item: WorkItem): WorkItemView {
  return {
    itemId: item.itemId, phase: item.phase, phaseAt: item.phaseAt, title: item.title, doneMeans: item.doneMeans,
    ...(item.candidate && { candidate: item.candidate }), ...(item.report && { report: item.report }),
    ...(item.staleReason && { staleReason: item.staleReason }), ...(item.pull && { pull: item.pull }),
  };
}

export type Applied = { changed: boolean; moved: WorkItem[] };
const NOTHING: Applied = { changed: false, moved: [] };

export type NewWorkItem = Pick<WorkItem, "itemId" | "projectId" | "workspaceId" | "title" | "doneMeans">;

export class WorkItemStore {
  constructor(private readonly path: string) {}

  read(): File {
    try { return file.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, items: {} };
      throw error;
    }
  }

  private write(next: File) {
    const kept = Object.values(next.items).sort((a, b) => b.createdAt - a.createdAt).slice(0, KEEP);
    mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const temp = this.path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, items: Object.fromEntries(kept.map(item => [item.itemId, item])), ...(next.settings && { settings: next.settings }) }), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }

  settings(): WorkSettings {
    return this.read().settings ?? DEFAULT_WORK_SETTINGS;
  }

  setSettings(settings: WorkSettings): WorkSettings {
    this.write({ ...this.read(), settings });
    return settings;
  }

  /** Records a new item once; a retry of the same itemId keeps the first one. */
  create(input: NewWorkItem, at = Date.now()): WorkItem {
    const current = this.read();
    const existing = current.items[input.itemId];
    if (existing) return existing;
    const item: WorkItem = { ...input, sessionId: null, origin: "dispatch", phase: "running", phaseAt: at, createdAt: at,
      history: [{ phase: "running", at, by: "coordinator" }] };
    this.write({ ...current, items: { ...current.items, [item.itemId]: item } });
    return item;
  }

  /** Names the session each item's launch started ([itemId, sessionId] pairs). An item keeps its first session. */
  link(pairs: readonly (readonly [string, string])[]): boolean {
    const current = this.read();
    const items = { ...current.items };
    let changed = false;
    for (const [itemId, sessionId] of pairs) {
      const item = items[itemId];
      if (!item || item.sessionId) continue;
      items[itemId] = { ...item, sessionId };
      changed = true;
    }
    if (changed) this.write({ ...current, items });
    return changed;
  }

  /** The newest item of each session. */
  bySession(items: Record<string, WorkItem> = this.read().items): Map<string, WorkItem> {
    const found = new Map<string, WorkItem>();
    for (const item of Object.values(items)) {
      if (!item.sessionId) continue;
      const seen = found.get(item.sessionId);
      if (!seen || item.createdAt > seen.createdAt) found.set(item.sessionId, item);
    }
    return found;
  }

  item(itemId: string): WorkItem | undefined {
    return this.read().items[itemId];
  }

  /**
   * Runs each event through the reducer on its session's item; writes once, and only when something changed.
   * changed: something was written. moved: the items whose phase changed, so the caller can tell the coordinator.
   */
  apply(events: readonly (readonly [string, WorkEvent])[]): Applied {
    if (!events.length) return NOTHING;
    const current = this.read();
    const sessions = this.bySession(current.items);
    if (!sessions.size) return NOTHING;
    return this.commit(current, events.flatMap(([sessionId, event]) => {
      const item = sessions.get(sessionId);
      return item ? [[item.itemId, event] as const] : [];
    }));
  }

  /** apply() addressed by itemId. */
  applyToItems(events: readonly (readonly [string, WorkEvent])[]): Applied {
    return events.length ? this.commit(this.read(), events) : NOTHING;
  }

  private commit(current: File, events: readonly (readonly [string, WorkEvent])[]): Applied {
    const items = { ...current.items };
    const before = new Map<string, WorkItem["phase"]>();
    let changed = false;
    for (const [itemId, event] of events) {
      const item = items[itemId];
      if (!item) continue;
      const next = reduceWorkItem(item, event);
      if (next === item) continue;
      if (!before.has(itemId)) before.set(itemId, item.phase);
      items[itemId] = next;
      changed = true;
    }
    if (changed) this.write({ ...current, items });
    return { changed, moved: [...before].filter(([id, phase]) => items[id].phase !== phase).map(([id]) => items[id]) };
  }
}
