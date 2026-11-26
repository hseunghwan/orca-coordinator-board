import { expect, test } from "vitest";
import { SnapshotReads } from "../server/snapshot-reads";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes,no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("cold badge, screen and another screen share one full read in either arrival order", async () => {
  for (const screenFirst of [true, false]) {
    const reads = new SnapshotReads(() => "p", (s: number) => s);
    const slow = deferred<number>();
    let calls = 0;
    const load = () => { calls++; return slow.promise; };
    const first = screenFirst ? reads.read(load) : reads.count(load);
    const results = [first, reads.read(load), reads.count(load)];
    await Promise.resolve();
    expect(calls).toBe(1);
    slow.resolve(8);
    expect(await Promise.all(results)).toEqual([8,8,8]);
    expect(await reads.count(() => Promise.reject(Error("rebuilding known count")))).toBe(8);
    expect(await reads.read(async () => 11)).toBe(11);
  }
});

test("new project scope never returns an old count or an old read that was already in flight", async () => {
  let scope = "studio";
  const old = deferred<string>();
  const reads = new SnapshotReads(() => scope, (text: string) => text.length);
  const load = () => scope === "studio" ? old.promise : Promise.resolve("new");
  const pending = reads.read(load);
  await Promise.resolve();
  scope = "news";
  expect(await reads.count(load)).toBe(3);
  old.resolve("private-timeline-from-previous-scope");
  expect(await pending).toBe("new");
});

test("manual refresh and a mutation supersede an older fetch; failed cold calls can be retried", async () => {
  const reads = new SnapshotReads(() => "p", (s: number) => s);
  await expect(reads.count(async () => { throw Error("unavailable"); })).rejects.toThrow("unavailable");
  const old = deferred<number>();
  let value = 7;
  const pending = reads.read(() => old.promise);
  await Promise.resolve();
  const current = deferred<number>();
  const fresh = reads.read(() => current.promise,true);
  old.resolve(99);
  current.resolve(value);
  expect(await Promise.all([pending,fresh])).toEqual([7,7]);
  reads.invalidate();
  value = 8;
  expect(await reads.count(async () => value)).toBe(8);
});

test("a count expires without retaining a reusable full snapshot", async () => {
  let now = 0;
  const reads = new SnapshotReads(() => "p", (s: number) => s, () => now);
  expect(await reads.read(async () => 4)).toBe(4);
  now = 14_999;
  expect(await reads.count(async () => 0)).toBe(4);
  now = 15_000;
  expect(await reads.count(async () => 5)).toBe(5);
});
