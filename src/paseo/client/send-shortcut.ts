export function sendModifier(platform: string) {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "Meta" : "Control";
}

type SendKey = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">;

export function isSendShortcut(event: SendKey, modifier: ReturnType<typeof sendModifier>) {
  // Some IMEs report 229 on the final Enter after isComposing has already cleared.
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return false;
  return modifier === "Meta" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}
