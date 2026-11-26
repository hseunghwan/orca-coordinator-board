// What every board view receives (Paseo's client/board-layout.ts). The board renders each card; a
// view only decides where it goes, and keeps it mounted while it may hold a draft.
import type { ReactNode } from "react";
import type { InlineReceipt } from "../paseo/client/decision-receipts";
import type { Card } from "../paseo/client/model";
import type { PullRequestItem } from "../paseo/shared/prs";
import type { TrackedDecision } from "../paseo/shared/tracked-decisions";
import type { DecisionEntry as PaseoEntry } from "../paseo/view-types";
import type { ProjectId } from "./board-model";
import type { OpenSession } from "./cards";

export type DecisionEntry = PaseoEntry & { card: ReactNode };

// Paseo's ProjectBundle without peer hosts: an Orca board only sees the sessions of this device.
export type ProjectBundle = {
  list: readonly { id: string; title: string; cards: Card[] }[];
  hostWide: boolean;
  name: (id: ProjectId) => string;
  records: readonly TrackedDecision[];
  pulls: readonly PullRequestItem[];
  hostLabel: string;
  renderRecord: (item: TrackedDecision) => ReactNode;
  renderPull: (pr: PullRequestItem, projectId: string) => ReactNode;
  open: OpenSession;
};

export type BoardLayoutProps = {
  compact: boolean;
  entries: readonly DecisionEntry[];
  total: number;
  filteredTotal: number;
  filtered: boolean;
  incomplete: boolean;
  renderReceipt: (receipt: InlineReceipt) => ReactNode;
  slots: { filters: ReactNode; notices: ReactNode; operations: ReactNode; history: ReactNode; progress: ReactNode };
  projects: ProjectBundle;
};
