import { z } from "zod";
import { defineRpc } from "../plugin-shim";
import { pullMergeEvidence } from "./prs";
import { MAX_WORK_IMAGES, workImage } from "./work-images";

export const replyOrigin = z.object({
  sessionId: z.string().nullable(), sessionHost: z.string().optional(), sessionProjectId: z.string().optional(),
  cardId: z.string(), revision: z.string(), questions: z.array(z.object({id:z.string(),index:z.number().int().nonnegative().optional()})).max(128),
});

export const replyDetails = z.object({
  origin: replyOrigin.optional(),
  title: z.string(), projectId: z.string().nullable(), answer: z.string().optional(),
  reviewedBy: z.string().optional(), reviewReason: z.string().optional(),
  imageCount: z.number().int().positive().max(MAX_WORK_IMAGES).optional(), localPhotos: z.boolean().optional(),
  at: z.string().datetime(), recipientId: z.string().optional(), coordinator: z.boolean().optional(),
});

export const replyEntry = replyDetails.extend({
  pullMerge: pullMergeEvidence.optional(),
  key: z.string(), status: z.enum(["sent", "pending", "recorded", "closed", "unsent"]),
  messageId: z.string().optional(), response: z.string().optional(),
  recipientTitle: z.string().optional(), recipientState: z.enum(["running","idle","closed","error","unknown"]).optional(),
  canOpen: z.boolean().optional(),
});
export type ReplyEntry = z.output<typeof replyEntry>;

// Photo bytes are requested explicitly from a visible local history entry.
export const readReplyPhoto = defineRpc({
  name: "board.read-reply-photo",
  input: z.strictObject({key: z.string().min(1).max(60000), index: z.number().int().min(0).max(MAX_WORK_IMAGES - 1)}),
  output: z.object({image: workImage.nullable()}),
});
