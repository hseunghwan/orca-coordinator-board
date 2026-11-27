// The board's work items: one record per piece of work the coordinator hands a session, kept the way Orca's
// orchestration keeps a worker (a dispatch id, what done means, explicit reports and state changes). assign
// creates the item before the launch (./dispatch.ts) and links it to the session once the terminal reports.
// reduceWorkItem is the one place a phase changes. Orca state and the turn-ended signal only mirror
// running and awaiting-input, or leave a done candidate; only the session's own report moves an item to
// reported, and only a person moves it to done. Asking the session about a candidate, verify, the stale rule
// and pull request events come later.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { OrcaState } from "../orca/view";
import { workCandidate, workPhase, type WorkItemView } from "../contract";

const historyEntry = z.object({ phase: workPhase, at: z.number(), by: z.enum(["session", "coordinator", "person", "board"]) });
const workItem = z.object({
  itemId: z.string(), sessionId: z.string().nullable(), projectId: z.string(), workspaceId: z.string(),
  title: z.string(), doneMeans: z.string().nullable(), origin: z.literal("dispatch"),
  phase: workPhase, phaseAt: z.number(), createdAt: z.number(),
  candidate: workCandidate.optional(),
  report: z.object({ text: z.string(), at: z.number() }).optional(),
  history: z.array(historyEntry),
});
const file = z.object({ version: z.literal(1), items: z.record(z.string(), workItem) });
export type WorkItem = z.output<typeof workItem>;
type File = z.output<typeof file>;

export type WorkEvent =
  /** Orca's state for the session, from agent.status.changed or a World read. */
  | { kind: "state"; state: OrcaState; at: number }
  /** working became done or waiting (src/orca/signals.ts). */
  | { kind: "turn-ended"; at: number }
  /** The session's own coordinator-board report. */
  | { kind: "report"; report: "question" | "review" | "done"; text: string; at: number }
  /** A person marked the card done. */
  | { kind: "confirmed"; at: number };

const KEEP = 500;
const HISTORY = 20;
const REPORT_CHARS = 2000;

function move(item: WorkItem, phase: WorkItem["phase"], at: number, by: z.output<typeof historyEntry>["by"], extra: Partial<WorkItem> = {}): WorkItem {
  const { candidate: _dropped, ...rest } = item;
  return { ...rest, ...extra, phase, phaseAt: at, history: [...item.history, { phase, at, by }].slice(-HISTORY) };
}

/** The next item for one event, or the same object when nothing changes (so a poll writes nothing). */
export function reduceWorkItem(item: WorkItem, event: WorkEvent): WorkItem {
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
      return item.phase === "running" && !item.candidate ? { ...item, candidate: { reason: "turn-ended", at: event.at } } : item;
    case "report":
      if (event.report === "done") {
        return move(item, "reported", event.at, "session", { report: { text: event.text.slice(0, REPORT_CHARS), at: event.at } });
      }
      if (event.report === "question" && item.phase === "running") return move(item, "awaiting-input", event.at, "session");
      return item;
    case "confirmed":
      return move(item, "done", event.at, "person");
  }
}

export function workItemView(item: WorkItem): WorkItemView {
  return {
    itemId: item.itemId, phase: item.phase, phaseAt: item.phaseAt, title: item.title, doneMeans: item.doneMeans,
    ...(item.candidate && { candidate: item.candidate }), ...(item.report && { report: item.report }),
  };
}

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
      writeFileSync(temp, JSON.stringify({ version: 1, items: Object.fromEntries(kept.map(item => [item.itemId, item])) }), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
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

  /** Runs each event through the reducer on its session's item; writes once, and only when something changed. */
  apply(events: readonly (readonly [string, WorkEvent])[]): boolean {
    if (!events.length) return false;
    const current = this.read();
    const sessions = this.bySession(current.items);
    if (!sessions.size) return false;
    const items = { ...current.items };
    let changed = false;
    for (const [sessionId, event] of events) {
      const item = sessions.get(sessionId);
      if (!item) continue;
      const next = reduceWorkItem(items[item.itemId], event);
      if (next === items[item.itemId]) continue;
      items[item.itemId] = next;
      changed = true;
    }
    if (changed) this.write({ ...current, items });
    return changed;
  }
}
