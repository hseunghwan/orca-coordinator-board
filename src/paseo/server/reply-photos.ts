import { boardPhotoMessageId } from "../shared/session-photos";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_WORK_IMAGE_BYTES, workImages, type WorkImage } from "../shared/work-images";

export function photoDigest({data, mimeType}: WorkImage) {
  // Buffer's base64 decoder accepts malformed input. Require the original canonical
  // encoding, then identify the file bytes independently of the picker-supplied MIME.
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("사진의 Base64 데이터를 확인해 주세요.");
  const pngHeader = "89504e470d0a1a0a0000000d49484452";
  const valid = mimeType === "image/png" ? bytes.length >= 33 && bytes.toString("hex", 0, 16) === pngHeader
    : mimeType === "image/jpeg" ? bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : bytes.length >= 20 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("latin1", 12, 16));
  if (!valid) throw new Error("사진 데이터와 파일 형식이 일치하는지 확인해 주세요.");
  return createHash("sha256").update(bytes).digest("hex");
}

export type PhotoReference = { mimeType: WorkImage["mimeType"]; digest: string };

export function describePhotos(images: WorkImage[] = []): PhotoReference[] {
  workImages.parse(images);
  return images.map(image => ({mimeType:image.mimeType, digest:photoDigest(image)}));
}

function photoFile(directory:string, receiptKey:string, index:number) {
  // File names are independent of project paths, file names, or any caller-provided path.
  const key = createHash("sha256").update(receiptKey).digest("hex");
  return join(directory, key + "-" + index);
}

// The caller holds the synchronous local receipt transaction. Each immutable
// receipt has at most four file slots, even after an interrupted first write.
export function saveLocalPhotos(directory:string, receiptKey:string, images: WorkImage[], commit:()=>boolean) {
  if (!images.length) return commit();
  const paths:string[] = [];
  try {
    mkdirSync(directory, {recursive:true, mode:0o700});
    for (const [index,image] of images.entries()) {
      const path = photoFile(directory, receiptKey, index);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
      paths.push(path);
      try { writeFileSync(fd, Buffer.from(image.data, "base64")); }
      finally { closeSync(fd); }
    }
    if (commit()) return true;
  } catch { /* An incomplete local record must remain open. */ }
  for (const path of paths) {
    try { rmSync(path, {force:true}); } catch { /* The same slot is reused on retry. */ }
  }
  return false;
}

export function removeLocalPhotos(directory:string, key:string, count:number) {
  for (let index=0; index<count; index++) {
    try { rmSync(photoFile(directory,key,index),{force:true}); } catch { /* Best-effort cleanup after the receipt commit. */ }
  }
}

export function readLocalPhoto(directory:string, receiptKey:string, index:number, ref:PhotoReference): WorkImage|null {
  let fd:number|undefined;
  try {
    fd = openSync(photoFile(directory, receiptKey, index), constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_WORK_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (!count) return null;
      offset += count;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== ref.digest) return null;
    return {mimeType:ref.mimeType, data:bytes.toString("base64")};
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

// Keep using an existing receipt's wire ID, including requests from older releases
// or a retry that incorrectly reuses a key with a different payload.
export function photoReceiptId(uuid: string, hasPhotos: boolean, receipts: Record<string, unknown>) {
  if (Object.hasOwn(receipts, uuid)) return uuid;
  const photoId = boardPhotoMessageId(uuid);
  return hasPhotos || Object.hasOwn(receipts, photoId) ? photoId : uuid;
}
