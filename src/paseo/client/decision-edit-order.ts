/** Capture the on-screen order through each edited card (keyed by its exact revision). */
export type EditingPositions = ReadonlyMap<string, readonly string[]>;

export function keepEditingPositions(ranked: readonly string[], positions: EditingPositions): readonly string[] {
  if (!positions.size) return ranked;
  const pending = new Set(ranked);
  let prefix: readonly string[] = [];
  for (const [key, previous] of positions) {
    if (pending.has(key) && previous.length > prefix.length) prefix = previous;
  }
  if (!prefix.length) return ranked;

  // Keeping the preceding siblings in order also keeps React from moving a focused input's DOM node.
  const pinned = new Set(prefix);
  const remaining = ranked.filter(key => !pinned.has(key));
  const ordered: string[] = [];
  let next = 0;
  for (const key of prefix) {
    if (pending.has(key)) ordered.push(key);
    else if (next < remaining.length) ordered.push(remaining[next++]);
  }
  return ordered.concat(remaining.slice(next));
}
