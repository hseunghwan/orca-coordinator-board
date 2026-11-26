import type { Card } from "./model";
import type { MergeNotification, PullRequestItem } from "../shared/prs";
import type { TrackedDecision } from "../shared/tracked-decisions";

export const pullRowKey = (pr: Pick<PullRequestItem, "repo" | "number">) => JSON.stringify(["pull", pr.repo, pr.number]);
export const recordRowKey = (item: TrackedDecision) => JSON.stringify(["record", item.key, item.fingerprint]);
export const sessionRowKey = (card: Card) => JSON.stringify(["session", card.session.projectId, card.session.id, card.session.decision?.version]);

export type CompletedAction = {
  actionKey: string;
  rowKey: string;
  projectIds: (string | null)[];
  status: "merged" | "already-merged" | "sent" | "saved" | "reviewed" | "already-closed";
  title: string;
  detail?: string;
  recipientId?: string;
  mergeProjectId?: string;
  notification?: MergeNotification;
};
export type InlineReceipt = CompletedAction & { order: readonly string[]; hidden?: boolean };

// Reinsert removed rows beside the same neighbors, even when two actions finish out of order.
// A revision is part of the row key, so a new question can coexist with its earlier receipt.
export function withReceiptPositions(active: readonly string[], receipts: readonly InlineReceipt[]) {
  const rows = [...active];
  for (const { rowKey, order, hidden } of receipts) {
    if (hidden || rows.includes(rowKey)) continue;
    const index = order.indexOf(rowKey);
    const next = order.slice(index + 1).find(key => rows.includes(key));
    const previous = order.slice(0, Math.max(0, index)).reverse().find(key => rows.includes(key));
    const nextIndex = next === undefined ? -1 : rows.indexOf(next);
    const previousIndex = previous === undefined ? -1 : rows.indexOf(previous);
    // Fresh priorities can reverse the neighbors when the finished editor releases its position.
    let position = Math.min(Math.max(0, index), rows.length);
    if (nextIndex > previousIndex) position = nextIndex;
    else if (nextIndex < 0 && previousIndex >= 0) position = previousIndex + 1;
    rows.splice(position, 0, rowKey);
  }
  return rows;
}
