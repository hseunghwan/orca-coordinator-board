// Adapted from Better Paseo's client/tasks/board/navigation.ts (0168adb), via
// the coordinator board. MIT, Copyright (c) 2026 ABorakati. See third-party/.
const MIN_WIDTH = 212;
const NARROW_WIDTH = 200;
const MAX_WIDTH = 340;
export const COLUMN_GAP = 8;

export function columnWidth(viewport: number, columns: number): number {
  if (!columns || !viewport) return MIN_WIDTH;
  const visible = Math.min(2, columns);
  const minimum = Math.max(NARROW_WIDTH, Math.min(MIN_WIDTH, (viewport - (visible - 1) * COLUMN_GAP) / visible));
  const share = (viewport - (columns - 1) * COLUMN_GAP) / columns;
  if (share >= minimum) return Math.min(share, MAX_WIDTH);
  return Math.max(NARROW_WIDTH, Math.min(minimum, viewport));
}
