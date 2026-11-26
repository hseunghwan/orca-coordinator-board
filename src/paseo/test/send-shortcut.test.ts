import { describe, expect, test } from "vitest";
import { isSendShortcut, sendModifier } from "../client/send-shortcut";

const enter = { key: "Enter", keyCode: 13, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false };

describe("board composer send shortcut", () => {
  test.each(["MacIntel", "Win32", "Linux x86_64"])("uses the keyboard of the client on %s", platform => {
    const modifier = sendModifier(platform);
    expect(isSendShortcut({ ...enter, metaKey: true }, modifier)).toBe(platform === "MacIntel");
    expect(isSendShortcut({ ...enter, ctrlKey: true }, modifier)).toBe(platform !== "MacIntel");
  });

  test.each(["Meta", "Control"] as const)("leaves line breaks, IME confirmation and other shortcuts alone for %s", modifier => {
    const chord = { ...enter, ctrlKey: modifier === "Control", metaKey: modifier === "Meta" };
    expect(isSendShortcut(enter, modifier)).toBe(false);
    for (const key of [{shiftKey: true}, {altKey: true}, {metaKey: true, ctrlKey: true},
      {isComposing: true}, {keyCode: 229}, {key: "Process"}, {key: "a"}]) {
      expect(isSendShortcut({ ...chord, ...key }, modifier)).toBe(false);
    }
  });
});
