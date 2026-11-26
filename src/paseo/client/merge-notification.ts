import type { MergeNotification } from "../shared/prs";
import type { Translate } from "../view-types";

const labels = {
  sent: ["코디네이터에 전달됨", "Delivered to coordinator"],
  queued: ["코디네이터 전달 대기", "Queued for coordinator"],
  unavailable: ["코디네이터 전달 불가", "Could not notify coordinator"],
  unconfirmed: ["코디네이터 전달 미확인", "Delivery to coordinator unconfirmed"],
} as const;

export function mergeNotificationLabel(notification: MergeNotification | undefined, t: Translate) {
  if (!notification) return null;
  const [ko, en] = labels[notification.status];
  return t(ko, en);
}

// A poll can still contain the queued snapshot from before the RPC completed.
export function latestMergeNotification(current: MergeNotification | undefined, stored: MergeNotification | undefined) {
  if (!stored || current?.status === "sent") return current;
  if (!current) return stored;
  if (current.recipientId && stored.recipientId !== current.recipientId) return current;
  if (current.status === stored.status && current.recipientId === stored.recipientId) return current;
  return current.status === "queued" || stored.status === "sent" ? stored : current;
}
