import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MAX_WORK_IMAGES, WORK_IMAGE_MIME_TYPES, type WorkImage } from "../shared/work-images";
import { describePhotos, readLocalPhoto, saveLocalPhotos } from "./reply-photos";

const manifest = z.array(z.object({
  mimeType: z.enum(WORK_IMAGE_MIME_TYPES), digest: z.string().regex(/^[a-f0-9]{64}$/),
})).min(1).max(MAX_WORK_IMAGES);
const retainedRequests = 20;

export class SessionPhotoStore {
  constructor(private directory: string) {}

  private key(sessionId: string, messageId: string) {
    return createHash("sha256").update(JSON.stringify([sessionId, messageId])).digest("hex");
  }

  save(sessionId: string, messageId: string, images: WorkImage[]) {
    const refs = describePhotos(images);
    if (!refs.length) return;
    const key = this.key(sessionId, messageId);
    const dest = join(this.directory, key);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (existsSync(dest)) {
      const prior = this.references(dest);
      if (JSON.stringify(prior) !== JSON.stringify(refs)) throw Error("첨부 사진이 이전 요청과 다릅니다.");
      return;
    }
    const staging = mkdtempSync(join(this.directory, ".pending-"));
    try {
      if (!saveLocalPhotos(staging, key, images, () => {
        writeFileSync(join(staging, "photos.json"), JSON.stringify(refs), { mode: 0o600 });
        return true;
      })) throw Error("세션에 표시할 사진을 저장하지 못했습니다.");
      renameSync(staging, dest);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    // Only our completed immutable directories count toward the preview cache.
    const older = readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== key && /^[a-f0-9]{64}$/.test(entry.name))
      .map(entry => { const path = join(this.directory, entry.name); return { path, at: lstatSync(path).mtimeMs }; })
      .sort((a, b) => b.at - a.at);
    for (const entry of older.slice(retainedRequests - 1)) rmSync(entry.path, { recursive: true, force: true });
  }

  private references(directory: string) {
    if (!lstatSync(directory).isDirectory()) throw Error("Invalid photo directory");
    return manifest.parse(JSON.parse(readFileSync(join(directory, "photos.json"), "utf8")));
  }

  read(sessionId: string, messageId: string, index: number) {
    const key = this.key(sessionId, messageId);
    const dest = join(this.directory, key);
    if (!existsSync(dest)) return {count: 0, image: null};
    const refs = this.references(dest);
    const image = refs[index] ? readLocalPhoto(dest, key, index, refs[index]) : null;
    return { count: refs.length, image };
  }
}
