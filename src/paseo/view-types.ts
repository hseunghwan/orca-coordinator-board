// Types the ported files take from upstream's React Native view files (client/language.tsx,
// client/board-layout.ts, client/remote-running.tsx), which are not ported.
import type { BoardHost } from "./shared/hosts";
import type { RankedDecision } from "./client/decision-priority";
import type { InlineReceipt } from "./client/decision-receipts";
import type { DecisionRowSummary } from "./client/decision-row";
import type { RemoteSession } from "./client/remote-sessions";

export type Translate = (korean: string, english: string) => string;

export type DecisionEntry = {
  key: string;
  row: RankedDecision | null;
  summary: DecisionRowSummary | null;
  label: string | null;
  card: unknown;
  receipts: readonly InlineReceipt[];
};

export type RemoteGroup = { host: BoardHost; rows: RemoteSession[]; failed: boolean };
