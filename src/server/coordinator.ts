// Adapted from paseo-coordinator-board server/coordinator.ts and server/reporting.ts @ 2e9d128. Orca
// plugins cannot give an agent MCP tools, so each tool is a coordinator-board command answered over the
// channel (src/channel/), and the agent is the session the channel verified. The tool bodies are
// Paseo's. report needs the caller on the board instead of Paseo's reporting metadata, which Orca
// sessions lack. fact and review are served from ./board-facts.ts and ./tracked-review.ts; plan and assign come later.
import { z } from "zod";
import type { PluginHandlerContext } from "../orca";
import type { Command } from "../channel/names";
import type { NoteStore } from "../paseo/server/notes";
import { isManagedCoordinator, judgment, type PreferenceStore } from "../paseo/server/preferences";
import { ConversationReader } from "./conversation";
import { discoverSessions } from "./discovery";
import { isCurrentMembership, managedSessions } from "./session-links";

type Sdk = PluginHandlerContext["paseo"];
export type ToolContext = { paseo: Sdk; agent: { id: string } };
export type ToolResult = { text: string; isError?: boolean };
export type Tool = { audience: "coordinator" | "session"; input: z.ZodType; execute(input: never, context: ToolContext): Promise<ToolResult> };

export const notYet = "이 버전의 보드에는 아직 없는 명령입니다. 사람에게 보드에서 직접 처리해 달라고 알리세요.";

export async function managedRowsForCoordinator(paseo: Sdk, prefs: PreferenceStore, caller: string) {
  const rows = await discoverSessions(paseo);
  const scope = prefs.read();
  const managed = managedSessions(rows, scope);
  if (scope.coordinator !== caller || !(managed.some(r => r.id === caller) || (isManagedCoordinator(scope, caller) && rows.some(r => r.id === caller)))) {
    throw new Error("코디네이터 지정이 해제되었습니다.");
  }
  return managed;
}

const reportInput = z.object({
  kind: z.enum(["question", "review"]),
  text: z.string().trim().min(1).max(2000),
});

export function recordReport(store: NoteStore, sessionId: string, report: z.infer<typeof reportInput>) {
  const current = store.visible(new Set([sessionId]))[sessionId];
  if (current && current.kind !== "clear" && current.origin !== "agent") {
    return { isError: true, text: "A person has a record on this card. Leave your update in the session." };
  }
  const result = store.update({
    sessionId, ...report, expectedRevision: current?.revision ?? 0,
  }, "agent");
  return result.ok ? { text: "Reported on your own Coordinator Board card." } :
    { isError: true, text: "The card changed. Leave your update in the session." };
}

export function tool<I extends z.ZodType>(audience: Tool["audience"], input: I, execute: (input: z.output<I>, context: ToolContext) => Promise<ToolResult>): Tool {
  return { audience, input, execute: execute as Tool["execute"] };
}

const later = tool("coordinator", z.unknown(), async () => { throw new Error(notYet); });

export function coordinatorCommands(prefs: PreferenceStore, reader: ConversationReader, notes: NoteStore, served: Partial<Record<Command, Tool>> = {}): Record<Command, Tool> {
  const read = tool("coordinator", z.object({ sessionId: z.string().optional() }), async ({ sessionId }, { paseo, agent }) => {
    const rows = await managedRowsForCoordinator(paseo, prefs, agent.id);
    if (!sessionId) {
      const listing = [];
      const current = prefs.read();
      for (const r of rows) {
        if (!isCurrentMembership(r,current)) continue;
        const j = current.judgments[r.id];
        const incomplete = j?.projectId === r.projectId && j.kind === "question" && !j.content?.recommendation && !j.content?.needsInput;
        let needsRecommendation = false;
        if (incomplete && r.status === "idle" && !r.nativePending) {
          const evidence = await reader.read(paseo,r).catch(() => null);
          needsRecommendation = j.evidenceId === evidence?.id;
        }
        listing.push({ id:r.id, projectId:r.projectId, sourceProjectId:r.sourceProjectId, project:r.projectTitle, title:r.title,
          status:r.status, activityAt:r.activityAt, ...(needsRecommendation ? {needsRecommendation:true}:{}),
          ...(current.factCycle?.coordinator === agent.id && current.factCycle.expires > Date.now() && current.factCycle.candidates[r.id] ? {factCandidate:true} : {}) });
      }
      const final = prefs.read();
      if (final.coordinator !== agent.id) throw new Error("코디네이터 지정이 해제되었습니다.");
      const included = new Set(rows.filter(r => isCurrentMembership(r,final)).map(r => r.id));
      return { text: JSON.stringify(listing.filter(r => included.has(r.id))) };
    }
    const target = rows.find(r => r.id === sessionId);
    if (!target) throw new Error("관리 대상 세션을 찾을 수 없습니다.");
    const data = await reader.read(paseo, target, true);
    const scope = prefs.read();
    if (scope.coordinator !== agent.id || !isCurrentMembership(target, scope)) throw new Error("관리 범위가 바뀌었습니다.");
    return { text: JSON.stringify(data ? { sessionId, evidenceId: data.id, turns: data.turns } : { sessionId, status: target.status, turns: [] }) };
  });
  const classify = tool("coordinator", judgment.extend({ sessionId: z.string() }), async (input, { paseo, agent }) => {
    const rows = await managedRowsForCoordinator(paseo, prefs, agent.id);
    const row = rows.find(r => r.id === input.sessionId);
    if (!row || row.status !== "idle" || row.nativePending || row.lane === "running") throw new Error("대기 중인 관리 세션을 확인해 주세요.");
    const latest = await reader.read(paseo, row, true);
    if (!latest?.turns.length || latest.id !== input.evidenceId) throw new Error("대화가 바뀌었습니다. 최신 발췌를 다시 확인하세요.");
    prefs.change(scope => {
      if (scope.coordinator !== agent.id || !isCurrentMembership(row, scope)) throw new Error("관리 범위가 바뀌었습니다.");
      const previous = scope.judgments[row.id];
      const previousQuestion = previous?.kind === "question" && previous.evidenceId === input.evidenceId && previous.projectId === row.projectId;
      scope.judgments[row.id] = { ...judgment.parse(input), projectId: row.projectId,
        ...(input.kind === "question" ? { requestedAt:previousQuestion ? previous.requestedAt : new Date().toISOString() } : {}) };
    });
    return { text: "판단을 해당 세션 카드에 기록했습니다." };
  });
  const report = tool("session", reportInput, async (input, { paseo, agent }) => {
    const rows = await discoverSessions(paseo);
    const scope = prefs.read();
    if (scope.coordinator !== agent.id && !managedSessions(rows, scope).some(r => r.id === agent.id)) {
      return { isError: true, text: "Board reporting is disabled for this session." };
    }
    return recordReport(notes, agent.id, input);
  });
  return { read, classify, report, plan: later, assign: later, fact: later, review: later, ...served };
}

/** Parses the input the way Paseo's tool host does, and runs the tool's body. */
export async function runCommand(table: Record<Command, Tool>, command: Command, input: unknown, context: ToolContext): Promise<ToolResult> {
  const entry = table[command];
  const parsed = entry.input.safeParse(input);
  if (!parsed.success) throw new Error("입력이 맞지 않습니다: " + parsed.error.issues.map(i => (i.path.join(".") || "input") + " " + i.message).join("; "));
  return entry.execute(parsed.data as never, context);
}
