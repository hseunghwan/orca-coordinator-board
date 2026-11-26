/** @jsxImportSource react */
// Paseo's InlineDecisionReceipt (client/inline-receipt.tsx): what a handled decision leaves in its place.
import type { InlineReceipt } from "../paseo/client/decision-receipts";
import { mergeNotificationLabel } from "../paseo/client/merge-notification";
import type { OpenSession } from "./cards";
import { column, row, SessionChip } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";

const statusLabel = {
  merged: ["병합 완료", "Merged"],
  "already-merged": ["이미 병합됨", "Already merged"],
  sent: ["답장 보냄", "Reply sent"],
  saved: ["보드에 저장함", "Saved on board"],
  reviewed: ["확인했어요", "Reviewed"],
  "already-closed": ["이미 처리됨", "Already handled"],
} as const;

export function InlineDecisionReceipt({ receipt, onOpen, onDismiss }: { receipt: InlineReceipt; onOpen?: OpenSession; onDismiss: () => void }) {
  const { t } = useBoardLanguage();
  const [ko, en] = statusLabel[receipt.status];
  const delivery = mergeNotificationLabel(receipt.notification, t);
  const recipientId = receipt.status === "sent" && receipt.recipientId;
  const openLabel = t("받은 세션 열기", "Open receiving session");
  return <div style={{ ...row, gap: 8, padding: "5px 0" }}>
    <div role="status" style={{ ...column, flex: "1 1 200px", minWidth: 0, gap: 2 }}>
      <p style={{ overflowWrap: "anywhere" }}><span className="ok" style={{ fontWeight: 600 }}>✓ {t(ko, en)}</span>{"  "}{receipt.title}</p>
      {(!!receipt.detail || !!delivery) && <p className={"muted sm " + (delivery ? "clamp2" : "ellipsis")}>{[delivery, receipt.detail].filter(Boolean).join(" · ")}</p>}
    </div>
    <div style={{ ...row, flexWrap: "nowrap", gap: 4 }}>
      {recipientId && onOpen && <SessionChip label={openLabel} accessibilityLabel={receipt.title + " · " + openLabel} onPress={() => onOpen(recipientId)} />}
      <button type="button" className="btn btn-ghost btn-sm" aria-label={t("결과 숨기기", "Hide result") + " · " + receipt.title} onClick={onDismiss}>{t("숨기기", "Hide")}</button>
    </div>
  </div>;
}
