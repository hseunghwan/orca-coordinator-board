type PageRequest = { limit: number; cursor?: string };
type Page<T> = { entries: T[]; pageInfo: { hasMore: boolean; nextCursor: string | null } };

// Cursor order must remain stable when a session starts or finishes between pages.
export async function readPages<T>(read: (page: PageRequest) => Promise<Page<T>>): Promise<T[]> {
  const entries: T[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await read(cursor ? { limit: 100, cursor } : { limit: 100 });
    entries.push(...page.entries);
    if (!page.pageInfo.hasMore) return entries;
    const next = page.pageInfo.nextCursor;
    if (!next || visited.has(next)) throw new Error("Paseo가 다음 목록 페이지를 반환하지 않았습니다. 새로 고쳐 주세요.");
    visited.add(next);
    cursor = next;
  }
}
