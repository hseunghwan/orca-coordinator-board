import { defineRpc } from "../plugin-shim";
import { z } from "zod";
import { MAX_WORK_IMAGES, workImage } from "./work-images";

// A custom UUIDv8 namespace lets Paseo identify board photo prompts at render time
// without changing the user's text or querying the host for ordinary chat messages.
export function boardPhotoMessageId(uuid: string) {
  return "c0bdf070" + uuid.slice(8, 14) + "8" + uuid.slice(15);
}
export function isBoardPhotoMessage(id: string | undefined) {
  return !!id && /^c0bdf070-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

export const boardPhotoMessageSchema = z.object({ messageId: z.string().uuid(), text: z.string() });
export const readSessionPhoto = defineRpc({
  name: "board.read-session-photo",
  input: z.strictObject({ sessionId: z.string().min(1).max(256), messageId: z.string().uuid(), index: z.number().int().min(0).max(MAX_WORK_IMAGES - 1) }),
  output: z.object({ count: z.number().int().min(0).max(MAX_WORK_IMAGES), image: workImage.nullable() }),
});
