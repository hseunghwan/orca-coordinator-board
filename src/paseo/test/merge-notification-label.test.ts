import { expect, test } from "vitest";
import { latestMergeNotification, mergeNotificationLabel } from "../client/merge-notification";

test("distinguishes coordinator delivery from the GitHub merge outcome", () => {
  const korean = (ko: string) => ko;
  expect(mergeNotificationLabel(undefined, korean)).toBeNull();
  expect(mergeNotificationLabel({status: "queued"}, korean)).toBe("코디네이터 전달 대기");
  expect(mergeNotificationLabel({status: "sent"}, korean)).toBe("코디네이터에 전달됨");
  expect(mergeNotificationLabel({status: "unavailable"}, korean)).toBe("코디네이터 전달 불가");
  expect(mergeNotificationLabel({status: "unconfirmed"}, korean)).toBe("코디네이터 전달 미확인");
});

test("an inline queued receipt follows durable progress and a stale poll never downgrades confirmed delivery", () => {
  const queued = {status: "queued", recipientId: "owner"} as const;
  const sent = {status: "sent", recipientId: "owner"} as const;
  const uncertain = {status: "unconfirmed", recipientId: "owner"} as const;
  expect(latestMergeNotification(queued, sent)).toEqual(sent);
  expect(latestMergeNotification(queued, uncertain)).toEqual(uncertain);
  expect(latestMergeNotification(sent, queued)).toEqual(sent);
  expect(latestMergeNotification(uncertain, queued)).toEqual(uncertain);
  expect(latestMergeNotification(undefined, sent)).toEqual(sent);
  expect(latestMergeNotification(queued, {status: "sent", recipientId: "another-owner"})).toEqual(queued);
  expect(latestMergeNotification(sent, undefined)).toEqual(sent);
});
