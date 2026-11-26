import type { TrackedDecision } from "../shared/tracked-decisions";

export function trackedSessionTargets(item: TrackedDecision, coordinator: string | null, hostId?: string) {
  // Older board-owned records predate the explicit ledger owner.
  const ownerId = item.sourceCoordinatorId === undefined && (item.where === "manager" || item.where === "human")
    ? coordinator : item.sourceCoordinatorId;
  const sourceId = item.matchedSessionId || item.sessionId;
  const sameSession = !!ownerId && ownerId === sourceId && (!item.sessionHost || item.sessionHost === hostId);
  return { ownerId, sameSession };
}
