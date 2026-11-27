// The tracked work (board.work-items) by session id, read beside the snapshot and given to every card.
import { createContext } from "react";
import type { WorkItems } from "./board-model";

export const WorkItemsContext = createContext<WorkItems>(new Map());
