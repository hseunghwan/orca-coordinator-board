import { expect, test } from "vitest";
import { sessionReplyDraft } from "../client/decision-reply-state";

test("the editable reply is the submitted text, including a cleared recommendation and photos alone", () => {
  const proposed = "결과 이미지는 보관해 주세요.";
  expect(sessionReplyDraft(proposed, null, null, false)).toEqual({ text: proposed, needsReview: false, canSend: true });
  expect(sessionReplyDraft(proposed, "  수정한 답장  ", null, false).text).toBe("  수정한 답장  ");
  expect(sessionReplyDraft(proposed, "", null, false).canSend).toBe(false);
  expect(sessionReplyDraft(proposed, "", null, true)).toEqual({ text: "", needsReview: false, canSend: true });
  expect(sessionReplyDraft(undefined, " \n ", null, false).canSend).toBe(false);
  expect(sessionReplyDraft(undefined, "a".repeat(24001), null, true).canSend).toBe(false);
});

test("the full suggested reply is reviewed for each long selection and the edited reply has its own wording", () => {
  const one = "첫째 줄\n둘째 줄";
  const two = "가".repeat(121);
  expect(sessionReplyDraft(one, null, null, true).canSend).toBe(false);
  expect(sessionReplyDraft(one, null, one, false).canSend).toBe(true);
  expect(sessionReplyDraft(two, null, one, false).needsReview).toBe(true);
  expect(sessionReplyDraft(two, "직접 쓴 답변", null, false).canSend).toBe(true);
  expect(sessionReplyDraft(two, two, null, false).needsReview).toBe(true);
  expect(sessionReplyDraft("가".repeat(120), null, null, false).canSend).toBe(true);
});
