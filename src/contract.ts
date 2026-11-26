// Orca-only additions to Paseo's worker contract, shared by the worker and the dashboard frame.
import { z } from "zod";
import { defineRpc } from "./paseo/plugin-shim";
import { workspaceChoiceSchema } from "./paseo/shared/dispatch";
import { operationState, setupCoordinator } from "./paseo/shared/operations";

/** A terminal session is focused, a chat session's workspace is opened. */
export const openSession = defineRpc({
  name: "board.open-session",
  input: z.object({ sessionId: z.string().min(1).max(256) }),
  output: z.object({ opened: z.boolean() }),
});

/** Orca has no plugin-owned folder, so a new coordinator starts in a workspace the person picks. */
export const coordinatorWorkspace = workspaceChoiceSchema.extend({ focused: z.boolean().optional() });
export const operations = defineRpc({
  name: operationState.name,
  input: operationState.input,
  output: operationState.output.extend({ workspaces: z.array(coordinatorWorkspace).optional() }),
});
export const startCoordinator = defineRpc({
  name: setupCoordinator.name,
  input: setupCoordinator.input.extend({ workspaceId: z.string().min(1).max(256).optional() }),
  output: setupCoordinator.output,
});
