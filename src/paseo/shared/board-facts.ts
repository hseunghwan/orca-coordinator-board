import { defineRpc } from "../plugin-shim";
import { z } from "zod";

export const factSchema = z.object({
  kind: z.enum(["managed", "project", "status", "report"]),
  evidenceId: z.string(), recipientId: z.string(), projectId: z.string(), sourceProjectId: z.string(),
  answer: z.string(), source: z.string(), recordedAt: z.string(),
  delivery: z.enum(["recorded", "pending", "sent", "unconfirmed"]),
  senderId: z.string().optional(), messageId: z.string().optional(),
});
export type BoardFact = z.output<typeof factSchema>;

export const factReplySettings = defineRpc({
  name: "board.fact-reply-settings", input: z.strictObject({}), output: z.object({ enabled: z.boolean() }),
});
export const setFactAutoReply = defineRpc({
  name: "board.set-fact-auto-reply", input: z.strictObject({ enabled: z.boolean() }), output: z.object({ ok: z.literal(true) }),
});
