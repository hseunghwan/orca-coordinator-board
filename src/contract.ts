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
/** Orca's other hosts (orca host list) and what runs on the paired ones; read only. */
export const hostStatus = z.enum(["online", "offline", "unknown"]);
export const boardHosts = defineRpc({
  name: "board.hosts",
  input: z.object({}),
  output: z.object({
    hosts: z.array(z.object({ id: z.string(), kind: z.enum(["local", "ssh", "environment"]), name: z.string(), status: hostStatus })),
    /** Running sessions on paired environments that answered, matched to a local project when one fits. */
    remoteRunning: z.array(z.object({
      hostId: z.string(), hostName: z.string(), sessionId: z.string(), title: z.string(), projectId: z.string().nullable(),
      repo: z.string().nullable(), workspace: z.string().nullable(), activityAt: z.string().nullable(),
    })),
    checkedAt: z.string().nullable(),
    /** Why remoteRunning is empty, when it is because no paired environment answered. */
    note: z.string().optional(),
  }),
});

export const startCoordinator = defineRpc({
  name: setupCoordinator.name,
  input: setupCoordinator.input.extend({ workspaceId: z.string().min(1).max(256).optional() }),
  output: setupCoordinator.output,
});
