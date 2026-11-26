/** @jsxImportSource react */
// Paseo's SendTextInput and SendButton (client/send-input.tsx): Cmd+Enter on Apple devices and Ctrl+Enter
// elsewhere press the send button, and hovering or keyboard-focusing that button shows the shortcut.
import { useEffect, useId, useState, type TextareaHTMLAttributes } from "react";
import { isSendShortcut, sendModifier } from "../paseo/client/send-shortcut";
import { Button, type ButtonProps } from "./ui/controls";

export type SendAction = { disabled: boolean; onPress: () => void };

const modifier = sendModifier(typeof navigator === "undefined" ? "" : navigator.platform);

export function SendTextInput({ send, className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { send: SendAction }) {
  return <textarea {...props} className={["textarea", className].filter(Boolean).join(" ")} onKeyDownCapture={event => {
    if (event.defaultPrevented || !isSendShortcut(event.nativeEvent, modifier)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !send.disabled) send.onPress();
  }} />;
}

export function SendButton({ send, ...props }: Omit<ButtonProps, "onPress" | "disabled" | "describedBy"> & { send: SendAction }) {
  const hintId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const showHint = hovered || focused;
  useEffect(() => {
    if (!showHint) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setHovered(false); setFocused(false); }
    };
    document.addEventListener("keydown", dismiss, true);
    return () => document.removeEventListener("keydown", dismiss, true);
  }, [showHint]);
  return <span className="send-wrap"
    onPointerEnter={event => setHovered(event.pointerType === "mouse" || event.pointerType === "pen")}
    onPointerLeave={() => setHovered(false)}
    onFocus={event => setFocused(event.target.matches(":focus-visible"))}
    onBlur={() => setFocused(false)}>
    <Button {...props} disabled={send.disabled} onPress={send.onPress} describedBy={hintId} />
    <span id={hintId} role="tooltip" className="tooltip" hidden={!showHint}>{modifier === "Meta" ? "⌘+Enter" : "Ctrl+Enter"}</span>
  </span>;
}
