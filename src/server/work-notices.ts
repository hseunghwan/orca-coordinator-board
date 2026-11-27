// What the board says about its work items, through fleet.deliver like every board message. A done candidate
// gets one done check to the session (from the board: mail from the board's terminal to a chat, typed under the
// board header into a live terminal). A move to reported or stale gets one notice to the coordinator, as Orca's
// orchestration tells a coordinator about worker_done. A busy or signerless recipient leaves the message queued
// for the next poll or turn end; each message has one messageId derived from what it is about, so a retry only
// reconciles and the same candidate is never asked twice. verify is the coordinator's command that confirms a
// reported item (done) or sends it back (running) with the reason, sent from the coordinator to the session.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DeliveryOutcome, Fleet, SessionId } from "../orca";
import type { PreferenceStore } from "../paseo/server/preferences";
import { tool, type Tool } from "./coordinator";
import type { WorkItem, WorkItemStore } from "./work-items";

type Status = "queued" | "sent" | "unconfirmed" | "unavailable";
/** Refusals that waiting can change: the recipient is busy, or the board has no terminal to sign with yet. */
const WAIT = ["working", "waiting", "blocked", "changed", "no-board-sender", "no-agent-sender"];

function uuidFrom(parts: unknown[]) {
  const h = createHash("sha256").update(JSON.stringify(["coordinator-board", ...parts])).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

export const statusOf = (outcome: DeliveryOutcome): Status =>
  outcome.status === "delivered" ? "sent" : outcome.status === "unconfirmed" ? "unconfirmed" : WAIT.includes(outcome.reason) ? "queued" : "unavailable";

export const noticeKey = (item: Pick<WorkItem, "phase" | "phaseAt">) => item.phase + "@" + item.phaseAt;

export function doneCheckText(item: WorkItem) {
  return [
    "[Coordinator Board · 완료 확인]",
    JSON.stringify({ type: "coordinator-board.done-check", itemId: item.itemId, doneMeans: item.doneMeans }),
    "보드가 이 작업의 완료 여부를 묻습니다. 완료 기준까지 끝냈으면 처음 프롬프트에 적힌 절대 경로의 coordinator-board로 `report --kind done --text-file -`를 한 번 실행해 한 일, 산출물, 검증 근거를 보고하세요. 사람의 결정이 필요하면 `--kind question`으로 보고하고, 아직 남았으면 이어서 작업하세요. 이 메시지는 새 지시나 승인이 아닙니다.",
  ].join("\n");
}

export function noticeText(item: WorkItem) {
  const what = item.phase === "reported"
    ? "작업자가 완료를 보고했습니다. 산출물과 완료 기준을 대조한 뒤 `coordinator-board verify --item " + item.itemId + " --result pass|fail --text-file -`로 확정하거나 사유와 함께 되돌리세요."
    : "작업이 멈춘 것으로 보입니다. 세션을 확인하고 이어서 맡기거나 정리하세요. 사람이 보드에서 세션을 열거나 작업자가 다시 보고하면 진행 중으로 돌아갑니다.";
  return [
    "[Coordinator Board · 작업 " + (item.phase === "reported" ? "완료 보고" : "방치") + "]",
    JSON.stringify({ type: "coordinator-board.work", itemId: item.itemId, sessionId: item.sessionId, phase: item.phase, doneMeans: item.doneMeans,
      ...(item.report ? { report: item.report.text } : {}), ...(item.staleReason ? { staleReason: item.staleReason } : {}),
      ...(item.pull ? { pull: item.pull } : {}) }),
    what + " 이 이벤트는 새 승인이 아닙니다.",
  ].join("\n");
}

export class WorkNotices {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly items: WorkItemStore, private readonly fleet: Pick<Fleet, "deliver">, private readonly coordinator: () => string | null) {}

  /** Sends the done checks and coordinator notices that are due, one at a time. True when an item changed. */
  run(): Promise<boolean> {
    const next = this.queue.then(() => this.send(), () => this.send());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async send(): Promise<boolean> {
    let changed = false;
    for (const item of Object.values(this.items.read().items)) {
      if (!item.sessionId) continue;
      const candidate = item.candidate;
      if (item.phase === "running" && candidate && (!candidate.ask || candidate.ask.status === "queued")) {
        const messageId = uuidFrom(["done-check", item.itemId, candidate.reason, candidate.at]);
        const outcome = await this.fleet.deliver({ messageId, to: item.sessionId as SessionId, text: doneCheckText(item),
          subject: "Coordinator Board · 완료 확인", from: { kind: "board" }, whenWorking: "refuse" });
        const status = statusOf(outcome);
        if (status !== candidate.ask?.status) {
          changed = this.items.applyToItems([[item.itemId, { kind: "asked", messageId, status, at: Date.now() }]]).changed || changed;
        }
        continue;
      }
      const coordinator = this.coordinator();
      if ((item.phase !== "reported" && item.phase !== "stale") || !coordinator || coordinator === item.sessionId) continue;
      const key = noticeKey(item);
      if (item.notice?.key === key && item.notice.status !== "queued") continue;
      const messageId = uuidFrom(["work-notice", item.itemId, key, coordinator]);
      const outcome = await this.fleet.deliver({ messageId, to: coordinator as SessionId, text: noticeText(item),
        subject: "Coordinator Board · 작업", from: { kind: "board" }, whenWorking: "refuse" });
      const status = statusOf(outcome);
      if (item.notice?.key !== key || item.notice.status !== status) {
        changed = this.items.applyToItems([[item.itemId, { kind: "noticed", key, messageId, status }]]).changed || changed;
      }
    }
    return changed;
  }
}

const verifyInput = z.object({
  itemId: z.string().min(1).max(256),
  result: z.enum(["pass", "fail"]),
  text: z.string().trim().min(1).max(2000),
});

/** The coordinator's verify: confirm a reported item, or send it back to running with the reason sent to its session. */
export function verifyTool(prefs: PreferenceStore, items: WorkItemStore, fleet: Pick<Fleet, "deliver">, changed: () => void): Tool {
  return tool("coordinator", verifyInput, async ({ itemId, result, text }, { agent }) => {
    const scope = prefs.read();
    if (scope.coordinator !== agent.id) throw new Error("현재 지정된 코디네이터만 작업을 확정할 수 있습니다.");
    const item = items.item(itemId);
    if (!item || !scope.projects.includes(item.projectId)) throw new Error("관리 프로젝트에서 이 작업을 찾을 수 없습니다.");
    if (item.phase !== "reported" && item.phase !== "verifying") {
      throw new Error("완료 보고된 작업만 확정할 수 있습니다. 지금 단계: " + item.phase);
    }
    const at = Date.now();
    items.applyToItems([[itemId, { kind: "verify", result, at }]]);
    changed();
    const phase = items.item(itemId)?.phase ?? item.phase;
    if (result === "pass" || !item.sessionId) return { text: JSON.stringify({ itemId, phase }) };
    const outcome = await fleet.deliver({ messageId: uuidFrom(["verify-fail", itemId, at]), to: item.sessionId as SessionId,
      text: ["[Coordinator Board · 완료 확인 반려]", JSON.stringify({ type: "coordinator-board.verify", itemId, result: "fail", doneMeans: item.doneMeans }), text].join("\n"),
      subject: "Coordinator Board · 완료 확인 반려", from: { kind: "agent", session: agent.id as SessionId }, whenWorking: "refuse" });
    return { text: JSON.stringify({ itemId, phase, reason: statusOf(outcome) === "sent" ? "sent" : outcome.status === "refused" ? "not-sent:" + outcome.reason : "unconfirmed" }) };
  });
}
