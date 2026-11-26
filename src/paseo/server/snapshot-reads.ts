// Full snapshots include private question text and live permissions. Only share
// an outstanding read. After it finishes, retain just the short-lived count.
export class SnapshotReads<T> {
  private pending?: { scope: string; promise: Promise<T> };
  private recent?: { scope: string; value: number; at: number };
  private revision = 0;
  constructor(private readonly scope: () => string, private readonly countOf: (snapshot: T) => number,
    private readonly now: () => number = Date.now) {}

  invalidate() {
    this.revision++;
    this.pending = undefined;
    this.recent = undefined;
  }

  read(load: () => Promise<T>, fresh = false): Promise<T> {
    if (fresh) this.invalidate();
    const scope = this.scope();
    if (this.pending?.scope === scope) return this.pending.promise;
    const revision = this.revision;
    const request = Promise.resolve().then(load).then(snapshot => {
      if (revision !== this.revision || this.scope() !== scope) {
        // The slow response was built for an earlier project selection or edit.
        return this.read(load);
      }
      this.recent = { scope, value: this.countOf(snapshot), at: this.now() };
      return snapshot;
    }).finally(() => {
      if (this.pending?.promise === request) this.pending = undefined;
    });
    this.pending = { scope, promise: request };
    return request;
  }

  async count(load: () => Promise<T>): Promise<number> {
    if (this.recent?.scope === this.scope() && this.now() - this.recent.at < 15_000) return this.recent.value;
    return this.countOf(await this.read(load));
  }
}
