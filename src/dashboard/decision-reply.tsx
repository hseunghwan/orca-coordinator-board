/** @jsxImportSource react */
// Paseo's DecisionReplyInput (client/decision-reply.tsx). A long reply gets a toggle that opens the whole
// text, and opening it is how a person reviews a long suggestion before it can be sent.
import { useState } from "react";
import { isLongReply } from "../paseo/client/decision-reply-state";
import { SendTextInput, type SendAction } from "./send-input";
import { Button, column } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

export function DecisionReplyInput({ send, value, onChangeText, accessibilityLabel, placeholder, maxLength, disabled, onFocus, onBlur, reviewRequired = false, onReview }: {
  send: SendAction; value: string; onChangeText: (value: string) => void; accessibilityLabel: string; placeholder: string;
  maxLength: number; disabled: boolean; onFocus: () => void; onBlur: () => void; reviewRequired?: boolean; onReview?: () => void;
}) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  const long = isLongReply(value);
  const showFull = long && expanded && !reviewRequired;
  const toggleLabel = showFull ? t("입력창 접기", "Collapse editor") : t("답장 전문 보기", "View full reply");
  return <div style={{ ...column, gap: 4 }}>
    <SendTextInput send={send} value={value} onChange={event => onChangeText(event.target.value)} disabled={disabled} maxLength={maxLength}
      aria-label={accessibilityLabel} placeholder={placeholder} onFocus={onFocus} onBlur={onBlur}
      style={{ height: showFull ? Math.max(168, Math.min(480, window.innerHeight * 0.48)) : undefined }} />
    {long && <div style={{ alignSelf: "flex-start" }}>
      <Button size="sm" label={toggleLabel} accessibilityLabel={accessibilityLabel + " · " + toggleLabel} expanded={showFull} disabled={disabled}
        onPress={() => {
          setExpanded(!showFull);
          if (!showFull) onReview?.();
        }} />
    </div>}
  </div>;
}
