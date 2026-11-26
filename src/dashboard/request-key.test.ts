import { expect, test } from "vitest";
import { decisionRequest } from "../paseo/shared/decision-actions";
import { noRetry, retryKey } from "./request-key";

test("the same payload keeps its key and a changed payload gets a new one", () => {
  const first = retryKey(noRetry, "a", "decision", () => 0.25, 1);
  expect(retryKey(first, "a", "decision", () => 0.75, 2)).toBe(first);
  expect(retryKey(first, "b", "decision", () => 0.75, 2).key).not.toBe(first.key);
});

test("a key fits the request key the contract accepts", () => {
  const { key } = retryKey(noRetry, "a", "decision");
  expect(decisionRequest.shape.requestKey.safeParse(key).success).toBe(true);
});
