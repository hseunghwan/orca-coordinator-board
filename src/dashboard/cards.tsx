/** @jsxImportSource react */
// Read-only decision cards. The session card follows Paseo's DecisionActions (client/decision-actions.tsx)
// up to its reply composer; the record and pull request cards show their header and title.
import { useState, type ReactNode } from "react";
import { decisionSummary } from "../paseo/client/decision-summary";
import type { Card } from "../paseo/client/model";
import type { PullRequestItem } from "../paseo/shared/prs";
import type { TrackedDecision } from "../paseo/shared/tracked-decisions";
import { column, Disclose, ProjectText, row, SessionChip, space } from "./ui/controls";
import { useBoardLanguage } from "./ui/language";
import { Markdown } from "./ui/markdown";

export type OpenSession = (sessionId: string) => void;

export function DecisionCard({ card, hostLabel, priorityLabel, open, embedded = false }: {
  card: Card; hostLabel: string; priorityLabel?: string; open: OpenSession; embedded?: boolean;
}) {
  const { t } = useBoardLanguage();
  const { session } = card;
  const decision = session.decision;
  const [showEvidence, setShowEvidence] = useState(false);
  const { headline, formal, evidence } = decisionSummary(card, t);
  const marker = [session.projectTitle, session.title, hostLabel && t(`실행 호스트 · ${hostLabel}`, `Host · ${hostLabel}`),
    session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`)].filter(Boolean).join(" · ");
  const sourceExcerpts = evidence.filter(text => text !== headline);
  const hasEvidence = !!decision?.recommendationReason || sourceExcerpts.length > 0;
  return <div style={{ ...column, gap: 7, ...(embedded && { paddingTop: 10, borderTop: "1px solid var(--border)" }) }}>
    <Markdown source={headline} heading />
    <div style={{ ...row, gap: 6 }}>
      <ProjectText projectId={session.projectId} projects={[session.projectTitle]} className="muted sm">{[marker, priorityLabel].filter(Boolean).join(" · ")}</ProjectText>
      <SessionChip label={t("담당 세션", "Assigned session")} accessibilityLabel={`${session.title} · ${t("담당 세션 열기", "Open assigned session")}`} onPress={() => open(session.id)} />
    </div>
    {formal ? <p className="muted">{t("승인 요청은 담당 세션에서 확인해 주세요.", "Review the approval request in the assigned session.")}</p>
      : !!decision?.needsInput && decision.needsInput !== headline && <Markdown source={decision.needsInput} />}
    {hasEvidence && <div style={{ ...column, alignItems: "flex-start", gap: 4 }}>
      <Disclose label={showEvidence ? t("근거 접기", "Hide source") : t("근거 보기", "View source")} expanded={showEvidence} onPress={() => setShowEvidence(v => !v)} />
      {showEvidence && decision?.recommendationReason && <div style={{ ...column, gap: 3 }}>
        <p className="muted sm">{t("추천 이유", "Reason for recommendation")}</p>
        <Markdown source={decision.recommendationReason} />
      </div>}
      {showEvidence && sourceExcerpts.map(text => <Markdown key={text} source={text} muted />)}
    </div>}
  </div>;
}

const kinds = {
  check: ["확인", "Check"], answer: ["질문", "Question"], merge: ["병합 검토", "Merge review"],
  approve: ["승인 검토", "Approval review"], cleanup: ["정리", "Follow-up"], other: ["결정", "Decision"],
} as const;

export function RecordCard({ item, priorityLabel, linkedSession, open, children }: {
  item: TrackedDecision; priorityLabel?: string; linkedSession: string | null; open: OpenSession; children?: ReactNode;
}) {
  const { t } = useBoardLanguage();
  const isMerge = item.kind === "merge";
  const source = item.projectTitle || item.projectId;
  const where = item.where === "human" ? t("직접 처리", "Your action")
    : item.where === "session" ? t("담당 세션", "Assigned session")
    : item.where === "manager" ? t("코디네이터", "Coordinator") : null;
  const [ko, en] = kinds[item.kind];
  const headline = item.ask[0];
  const recommend = item.recommend.filter(line => line !== headline && line !== item.howToAnswer);
  return <div style={{ ...column, gap: 7 }}>
    <div style={{ ...row, gap: 6 }}>
      <ProjectText projectId={item.projectId ?? undefined} projects={item.projectId && source ? [source] : []} className="muted sm">
        {[source || t("보드 공통", "Board-wide"), t(ko, en), where, item.owner, priorityLabel].filter(Boolean).join(" · ")}
      </ProjectText>
      {linkedSession && <SessionChip label={t("연결 세션", "Linked session")} accessibilityLabel={`${item.title} · ${t("연결 세션 열기", "Open linked session")}`} onPress={() => open(linkedSession)} />}
    </div>
    <Markdown source={isMerge ? t("PR 병합", "PR merge") : item.title} heading />
    {!!headline && headline !== item.title && <Markdown source={headline} />}
    {children}
    {!isMerge && recommend.length > 0 && <div style={{ ...column, gap: 3 }}>
      <p className="muted sm">{t("추천", "Recommendation")}</p>
      {recommend.map(line => <Markdown key={line} source={line} />)}
    </div>}
  </div>;
}

const pullStatus = {
  ready: ["병합 검토 가능", "Ready for merge review"], draft: ["초안", "Draft"],
  conflict: ["충돌 해결 필요", "Conflicts to resolve"], "checks-failed": ["검사 실패", "Checks failed"],
  "checks-pending": ["검사 중", "Checks pending"], "changes-requested": ["수정 요청", "Changes requested"],
  blocked: ["병합 조건 대기", "Merge requirements pending"], unknown: ["상태 미확인", "Status unknown"],
  "auto-merge": ["자동 병합 대기", "Auto-merge enabled"],
} as const;

export function PullCard({ pr, priorityLabel }: { pr: PullRequestItem; priorityLabel?: string }) {
  const { t } = useBoardLanguage();
  const [ko, en] = pullStatus[pr.reason];
  return <div style={{ ...column, gap: 7 }}>
    <div style={{ ...row, gap: 6 }}>
      <a className="link" style={{ fontSize: 13 }} href={pr.url} onClick={event => { event.preventDefault(); void orca.shell?.openExternal(pr.url).catch(() => undefined); }}>{pr.repo} #{pr.number}</a>
      <span className="muted sm">· {[t(ko, en), priorityLabel].filter(Boolean).join(" · ")}</span>
    </div>
    <p style={{ fontSize: 15, lineHeight: "21px", fontWeight: 600, overflowWrap: "anywhere" }}>{pr.title}</p>
  </div>;
}
