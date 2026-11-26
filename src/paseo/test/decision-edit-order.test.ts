import { expect, test } from "vitest";
import { keepEditingPositions } from "../client/decision-edit-order";

test("keeps a focused card and the siblings preceding its input stable even outside a new first page", () => {
  const ranks = ["urgent", "b", "a", "ready", "edit", "old"];
  const positions = new Map([["edit", ["a", "b", "edit"]]]);
  expect(keepEditingPositions(ranks, positions)).toEqual(["a", "b", "edit", "urgent", "ready", "old"]);
  expect(keepEditingPositions(ranks, new Map())).toEqual(ranks);
});

test("fills a vanished predecessor's place from the current queue without restoring stale cards", () => {
  const positions = new Map([["edit", ["closed", "edit"]]]);
  expect(keepEditingPositions(["new", "later", "edit"], positions)).toEqual(["new", "edit", "later"]);
  expect(keepEditingPositions(["edit"], positions)).toEqual(["edit"]);
});

test("stale revisions, filtered-out projects and already resolved drafts never re-enter the queue", () => {
  const positions = new Map([["edit:v1", ["other", "edit:v1"]]]);
  expect(keepEditingPositions(["edit:v2", "other"], positions)).toEqual(["edit:v2", "other"]);
  expect(keepEditingPositions([], positions)).toEqual([]);
});

test("concurrent edits keep all edited rows in place; releasing the deeper one restores the next priorities", () => {
  const ranks = ["urgent", "three", "two", "one", "four"];
  const positions = new Map([["one", ["one"]], ["three", ["one", "two", "three"]]]);
  expect(keepEditingPositions(ranks, positions)).toEqual(["one", "two", "three", "urgent", "four"]);
  positions.delete("three");
  expect(keepEditingPositions(ranks, positions)).toEqual(["one", "urgent", "three", "two", "four"]);
});
