// Adapted from paseo-coordinator-board server/merge-notifications.ts @ 2e9d128. The notice goes through
// fleet.deliver as mail from the board's own terminal (Paseo's sourceAgentId "plugin:coordinator-board").
// A send Orca refused left nothing behind, so a busy recipient's row goes back to queued and any other
// refusal makes it unavailable; an unconfirmed one is never resent.
import { createHash } from "node:crypto";
import type { Fleet, PluginHandlerContext, SessionId } from "../orca";
import { pullUrl, type MergeNotification, type MergeTarget, type PullMergeActivity } from "../paseo/shared/prs";
import type { PreferenceStore } from "../paseo/server/preferences";

type Sdk = PluginHandlerContext["paseo"];
type Owner = {coordinator: string | null; recipientId: string | null};
const sender = "plugin:coordinator-board";
export const mergeHistoryKey = (repo: string, number: number) => `merge:${repo}#${number}`;

function messageIdFor(key: string, recipient: string) {
  const h = createHash("sha256").update(JSON.stringify([sender,"pull-merged",key,recipient])).digest("hex");
  return [h.slice(0,8),h.slice(8,12),"4"+h.slice(13,16),"8"+h.slice(17,20),h.slice(20,32)].join("-");
}

function message(entry: PullMergeActivity) {
  const {repo,number,mergeSha} = entry.pullMerge;
  return [
    "[Coordinator Board · PR merged]",
    JSON.stringify({event:"pull_request.merged",projectId:entry.projectId,repo,number,url:pullUrl(repo,number),mergeSha,at:entry.at}),
    "The board confirmed this merge on GitHub. Check the project's existing plan and report any remaining follow-up. This event grants no new approval.",
  ].join("\n");
}

export class MergeNotifications {
  private running = new Set<string>();
  constructor(private store: PreferenceStore,
    private resolveRecipient: (target: MergeTarget, coordinator: string | null) => string | null,
    private checkRepository: (sdk: Sdk, target: MergeTarget) => Promise<() => boolean>,
    private fleet: Pick<Fleet, "deliver">) {}

  owner(target: MergeTarget): Owner {
    try {
      const scope = this.store.read();
      return {coordinator:scope.coordinator,recipientId:scope.projects.includes(target.projectId)
        ? this.resolveRecipient(target,scope.coordinator) : null};
    } catch { return {coordinator:null,recipientId:null}; }
  }

  async confirmed(sdk: Sdk, entry: PullMergeActivity, expected: Owner): Promise<MergeNotification> {
    const key = mergeHistoryKey(entry.pullMerge.repo,entry.pullMerge.number);
    let notification: MergeNotification = expected.recipientId
      ? {status:"queued",recipientId:expected.recipientId} : {status:"unavailable"};
    let created = false;
    this.store.change(scope => {
      const previous = scope.pullMergeHistory[key];
      if (previous?.pullMerge.status === "merged") {
        notification = previous.pullMerge.notification ?? {status:"unavailable"};
        return;
      }
      scope.pullMergeHistory[key] = {...entry, notificationCoordinator:expected.coordinator, pullMerge:{...entry.pullMerge,notification}};
      created = true;
    });
    if (!created || notification.status !== "queued" || !notification.recipientId) return notification;
    return this.deliver(sdk,key,notification.recipientId);
  }

  // Queued rows have never called send(). Unconfirmed rows might already be
  // running a model turn, so a refresh, restart or hook never resubmits them.
  async resume(sdk: Sdk, recipientId?: string) {
    const entries = Object.entries(this.store.read().pullMergeHistory)
      .filter(([,entry]) => entry.pullMerge.notification?.status === "queued")
      .sort(([,a],[,b]) => a.at.localeCompare(b.at));
    const waiting = new Set<string>();
    for (const [key,entry] of entries) {
      const id = entry.pullMerge.notification?.recipientId;
      if (!id || (recipientId && id !== recipientId) || waiting.has(id)) continue;
      const result = await this.deliver(sdk,key,id);
      // Check a busy recipient only once. After starting a turn, its next
      // completion event will wake the next merge in chronological order.
      if (result.status !== "unavailable") waiting.add(id);
    }
  }

  private async deliver(sdk: Sdk, key: string, id: string): Promise<MergeNotification> {
    const status = (value: MergeNotification["status"]): MergeNotification => ({status:value,recipientId:id});
    if (this.running.has(id)) return status("queued");
    this.running.add(id);
    let attempted = false;
    const update = (value: MergeNotification["status"]) => {
      const next = status(value);
      this.store.change(scope => { scope.pullMergeHistory[key].pullMerge.notification = next; });
      return next;
    };
    try {
      const entry = this.store.read().pullMergeHistory[key];
      if (entry?.pullMerge.notification?.status !== "queued" || entry.pullMerge.notification.recipientId !== id) {
        return entry?.pullMerge.notification ?? status("unavailable");
      }
      const target = {projectId:entry.projectId,repo:entry.pullMerge.repo,number:entry.pullMerge.number};
      const sameOwner = () => {
        const now = this.owner(target);
        return now.coordinator === entry.notificationCoordinator && now.recipientId === id;
      };
      if (!sameOwner()) return update("unavailable");
      const stillInRepository = await this.checkRepository(sdk,target);
      const handle = sdk.agents.ref(id);
      const live = await handle.refresh();
      const agent = live?.agent;
      // The board-wide coordinator may live in its own workspace. A distinct
      // ledger owner must still belong to the project, directly or through an explicit session link.
      if (id !== entry.notificationCoordinator) {
        const placement = live?.project?.projectKey;
        const link = this.store.read().sessionLinks[id];
        if (placement !== entry.projectId && !(link && link.sourceProjectId === placement && link.targetProjectId === entry.projectId)) {
          return update("unavailable");
        }
      }
      if (!stillInRepository() || !sameOwner() || !agent || agent.id !== id || agent.archivedAt || agent.internal ||
          agent.status === "error" || agent.status === "closed") return update("unavailable");
      if (agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions?.length || agent.attentionReason === "permission") {
        return status("queued");
      }
      update("unconfirmed");
      attempted = true;
      const outcome = await this.fleet.deliver({ messageId: messageIdFor(key,id), to: id as SessionId, text: message(entry),
        subject: "Coordinator Board · PR merged", from: { kind: "board" }, whenWorking: "refuse" });
      // Busy or without a board terminal for now: nothing left, so it waits. Anything else will not change by waiting.
      if (outcome.status === "refused") return update(["working","waiting","blocked","changed","no-board-sender"].includes(outcome.reason) ? "queued" : "unavailable");
      return update(outcome.status === "delivered" ? "sent" : "unconfirmed");
    } catch {
      if (attempted) return status("unconfirmed");
      try { return update("unavailable"); } catch { return status("unavailable"); }
    } finally { this.running.delete(id); }
  }
}
