// What every board view receives (Paseo's client/board-layout.ts). The board renders each card; a
// view only decides where it goes, and keeps it mounted while it may hold a draft.
import type { ReactNode } from "react";
import type { InlineReceipt } from "../paseo/client/decision-receipts";
import type { DecisionEntry as PaseoEntry } from "../paseo/view-types";
import type { ProjectId } from "./board-model";

export type DecisionEntry = PaseoEntry & { card: ReactNode };

export type BoardLayoutProps = {
  compact: boolean;
  entries: readonly DecisionEntry[];
  total: number;
  filteredTotal: number;
  filtered: boolean;
  incomplete: boolean;
  renderReceipt: (receipt: InlineReceipt) => ReactNode;
  slots: { filters: ReactNode; notices: ReactNode; operations: ReactNode; history: ReactNode; progress: ReactNode };
  projects: { name: (id: ProjectId) => string };
};
