// The images of one board message as files an agent can open by path. Orca cannot attach an image to a
// message (src/orca/conversation.ts photoLines), and SessionPhotoStore's own copies have no extension, which
// an agent's image reader needs. The copies go into the message's SessionPhotoStore folder, so its retention
// removes them too; save there first.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkImage } from "../paseo/shared/work-images";

const EXTENSION: Readonly<Record<WorkImage["mimeType"], string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The absolute path of each image, written once. directory is the SessionPhotoStore folder. */
export function photoFiles(directory: string, sessionId: string, messageId: string, images: readonly WorkImage[]): string[] {
  // SessionPhotoStore's folder name for this session and message.
  const folder = join(directory, createHash("sha256").update(JSON.stringify([sessionId, messageId])).digest("hex"));
  return images.map((image, i) => {
    const path = join(folder, `photo-${i + 1}.${EXTENSION[image.mimeType]}`);
    try {
      writeFileSync(path, Buffer.from(image.data, "base64"), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return path;
  });
}
