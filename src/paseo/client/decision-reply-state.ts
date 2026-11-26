export function isLongReply(text: string) {
  return text.length > 120 || text.includes("\n");
}

export function sessionReplyDraft(suggestion: string | undefined, edited: string | null, reviewed: string | null, hasPhotos: boolean) {
  const text = edited ?? suggestion ?? "";
  const needsReview = !!suggestion && text === suggestion && isLongReply(suggestion) && reviewed !== suggestion;
  return { text, needsReview, canSend: !needsReview && text.length <= 24000 && (!!text.trim() || hasPhotos) };
}
