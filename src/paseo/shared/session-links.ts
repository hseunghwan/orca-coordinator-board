import { defineRpc } from "../plugin-shim";
import { z } from "zod";

const projectId = z.string().min(1).max(4096);
const sessionId = z.string().min(1).max(256);

export const sessionLinkSchema = z.object({
  sessionId, sourceProjectId: projectId, targetProjectId: projectId,
  title: z.string(), workspaceTitle: z.string(), sourceProjectTitle: z.string(), targetProjectTitle: z.string(),
});
export const listSessionLinks = defineRpc({
  name: "board.session-links", input: z.strictObject({}),
  output: z.object({ sessions: z.array(sessionLinkSchema.omit({ targetProjectTitle: true }).extend({
    targetProjectId: projectId.nullable(), available: z.boolean(),
  })) }),
});
export const linkSession = defineRpc({
  name: "board.link-session",
  input: z.strictObject({ sessionId, sourceProjectId: projectId, targetProjectId: projectId.nullable(), expectedTargetProjectId: projectId.nullable() }),
  output: z.object({ ok: z.literal(true) }),
});
export type SessionLink = z.output<typeof sessionLinkSchema>;
