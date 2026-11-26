import { afterEach, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPhotoStore } from "../server/session-photos";
import { boardPhotoMessageId, isBoardPhotoMessage } from "../shared/session-photos";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const photo = {mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC"};

test("only board photo IDs identify the attachment renderer", () => {
  const original = randomUUID();
  const tagged = boardPhotoMessageId(original);
  expect(isBoardPhotoMessage(tagged)).toBe(true);
  expect(isBoardPhotoMessage(original)).toBe(false);
  expect(isBoardPhotoMessage(undefined)).toBe(false);
  expect(isBoardPhotoMessage(tagged + "-suffix")).toBe(false);
});

test("images survive a reload, stay scoped to their receiving session and have bounded retention", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-session-photos-"));
  dirs.push(dir);
  const store = new SessionPhotoStore(dir);
  const ids = Array.from({length: 21}, () => boardPhotoMessageId(randomUUID()));
  for (const id of ids) store.save("session", id, [photo]);
  const reloaded = new SessionPhotoStore(dir);
  const newest = ids.at(-1)!;
  expect(readdirSync(dir)).toHaveLength(20);
  expect(reloaded.read("session", newest, 0)).toEqual({count: 1, image: photo});
  expect(reloaded.read("other-session", newest, 0)).toEqual({count: 0, image: null});
  expect(ids.filter(id => reloaded.read("session", id, 0).image === null)).toHaveLength(1);
  reloaded.save("session", newest, [photo]);
  expect(readdirSync(dir)).toHaveLength(20);
});

test("a changed file cannot be shown in place of the attached photo", () => {
  const dir = mkdtempSync(join(tmpdir(), "board-session-photos-"));
  dirs.push(dir);
  const store = new SessionPhotoStore(dir);
  const id = boardPhotoMessageId(randomUUID());
  store.save("session", id, [photo]);
  const folder = join(dir, readdirSync(dir)[0]);
  const file = readdirSync(folder).find(name => name !== "photos.json")!;
  writeFileSync(join(folder, file), "damaged");
  expect(store.read("session", id, 0)).toEqual({count: 1, image: null});
});
