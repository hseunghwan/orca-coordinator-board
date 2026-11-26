import { z } from "zod";

export const WORK_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_WORK_IMAGES = 4;
export const MAX_WORK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_WORK_IMAGES_BYTES = 12 * 1024 * 1024;
export const workImage = z.strictObject({
  mimeType: z.enum(WORK_IMAGE_MIME_TYPES),
  data: z.string().min(4).max(4 * Math.ceil(MAX_WORK_IMAGE_BYTES / 3)),
});
export type WorkImage = z.infer<typeof workImage>;

function decodedLength(data: string) {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

export const workImages = z.array(workImage).max(MAX_WORK_IMAGES).refine(images => {
  const sizes = images.map(image => decodedLength(image.data));
  return sizes.every(size => size <= MAX_WORK_IMAGE_BYTES) && sizes.reduce((a,b) => a + b, 0) <= MAX_WORK_IMAGES_BYTES;
}, "Photo size exceeds the request limit.");
