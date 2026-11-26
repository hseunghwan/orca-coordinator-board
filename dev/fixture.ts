// An invented board for the dev harness. Times are minutes before the page loads.
const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const fingerprint = (seed: string) => seed.repeat(64).slice(0, 64);

const projects = [
  { id: "billing", title: "billing-api", path: "/w/billing-api", selected: true },
  { id: "editor", title: "editor-app", path: "/w/editor-app", selected: true },
  { id: "docs", title: "docs-site", path: "/w/docs-site", selected: true },
  { id: "mobile", title: "mobile", path: "/w/mobile", selected: false },
];

const base = (id: string, projectId: string, title: string) => {
  const project = projects.find(p => p.id === projectId)!;
  return { id, title, projectId, projectTitle: project.title, workspaceTitle: title.toLowerCase().replace(/\s+/g, "-"), model: "claude", provider: "claude" };
};

export function fixtureSnapshot() {
  return {
    projects,
    coordinator: null,
    notes: {
      "s-links": { sessionId: "s-links", kind: "done", origin: "agent", text: "깨진 링크 12개를 고쳤고 검사 스크립트를 CI에 넣었습니다.", revision: 1, evidenceId: "e1" },
    },
    sessions: [
      { ...base("s-webhook", "billing", "웹훅 안정화"), lane: "human", status: "idle", decisionRequestedAt: minutes(124), activityAt: minutes(124),
        detail: "재시도 3회에서 실패율이 0.8%입니다. 5회로 늘리면 0.1%까지 내려가지만, 중복 결제 방지 키의 유효 시간(`IDEMPOTENCY_TTL=24h`)을 넘기지 않는지 확인해야 합니다.",
        decision: { source: "conversation", version: "v3", question: "결제 웹훅 재시도를 5회로 늘릴까요?",
          questionMarkdown: "결제 웹훅 재시도를 5회로 늘릴까요?\n\n재시도 3회에서 실패율이 0.8%입니다. 5회로 늘리면 0.1%까지 내려가지만, 중복 결제 방지 키의 유효 시간(`IDEMPOTENCY_TTL=24h`)을 넘기지 않는지 확인해야 합니다.\n마지막 재시도 간격은 6시간입니다.",
          recommendation: "5회로 늘리고 TTL을 48시간으로 올려 주세요.",
          options: [
            { label: "5회 + TTL 48시간", reply: "재시도를 5회로 늘려 주세요.\n중복 결제 방지 키의 TTL은 48시간으로 올리고, 정산 배치 시간과 겹치지 않는지 배포 전에 한 번 더 확인해 주세요." },
            { label: "3회 유지", reply: "3회를 유지하고 실패 건은 수동으로 다시 보내 주세요." },
          ],
          recommendationReason: "5회로 늘리고 TTL을 48시간으로 함께 올리는 쪽을 권합니다. 회계 정산 배치와 겹치지 않습니다." } },
      { ...base("s-migrate", "editor", "DB 마이그레이션"), lane: "human", status: "running", nativePending: true, decisionRequestedAt: minutes(12), activityAt: minutes(12),
        detail: "응답을 기다리는 요청 1건", decision: { source: "permission", version: "p1", question: "응답을 기다리는 요청 1건" } },
      { ...base("s-captions", "editor", "자막 검수"), lane: "human", status: "idle", decisionRequestedAt: minutes(40), activityAt: minutes(40),
        detail: "자막 오탈자 23건을 찾았습니다. 결정 필요: 자막 오탈자 23건을 자동 수정할까요? 근거: 사전 대조 결과입니다.",
        decision: { source: "coordinator", version: "c2", question: "결정 필요: 자막 오탈자 23건을 자동 수정할까요? 근거: 사전 대조 결과입니다.", needsInput: "고칠 범위(전체 또는 제목만)를 알려 주세요." } },
      { ...base("s-index", "docs", "검색 색인"), lane: "human", status: "running", activityAt: minutes(5),
        detail: "검색 색인 재생성은 30분 걸립니다. 언제 돌릴까요?", decision: { source: "coordinator", version: "i1", question: "검색 색인 재생성을 언제 돌릴까요?" } },
      { ...base("s-dashboard", "billing", "결제 대시보드 리팩터링"), lane: "running", status: "running", activityAt: minutes(1), detail: "작업 중" },
      { ...base("s-refund", "billing", "환불 API 문서"), lane: "idle", status: "idle", activityAt: minutes(300), detail: "다음 요청 대기" },
      { ...base("s-bundle", "editor", "번들 크기 줄이기"), lane: "review", status: "idle", activityAt: minutes(25), detail: "세션 결과 확인 필요" },
      { ...base("s-links", "docs", "링크 검사"), lane: "idle", status: "idle", evidenceId: "e1", activityAt: minutes(60), detail: "다음 요청 대기" },
      { ...base("s-search", "docs", "검색 UI"), lane: "running", status: "running", activityAt: minutes(3), detail: "작업 중" },
    ],
    clarifications: [
      { cardKey: JSON.stringify(["session", "billing", "s-webhook", "v3"]), messageId: "00000000-0000-4000-8000-000000000001", recipientId: "s-webhook",
        question: "정산 배치는 몇 시에 도나요?", at: minutes(30), status: "sent", response: "매일 02:00에 돕니다. 마지막 재시도 간격(6시간)과 겹칠 수 있습니다." },
      { cardKey: JSON.stringify(["session", "billing", "s-webhook", "v3"]), messageId: "00000000-0000-4000-8000-000000000002", recipientId: "s-webhook",
        question: "TTL을 올리면 저장소 용량은 얼마나 늘어나요?", at: minutes(8), status: "sent" },
    ],
    replyHistory: [
      { key: "h-refund-doc", status: "sent", title: "환불 API 문서에 오류 코드 표를 넣을까요?", projectId: "billing", at: minutes(50),
        recipientId: "s-refund", recipientTitle: "환불 API 문서", recipientState: "idle", canOpen: true,
        answer: "네, 넣어 주세요. 오류 코드마다 다시 시도해도 되는지 한 줄씩 적어 주세요.\n\n- 4xx는 다시 시도하지 않는다고 적어 주세요.\n- 5xx는 지수 백오프로 세 번까지라고 적어 주세요.\n- 429는 Retry-After 헤더를 따르라고 적어 주세요.",
        response: "표를 넣었습니다. 오류 코드 14개에 재시도 여부와 예시 응답을 붙였고, 문서 빌드를 통과했습니다.",
        origin: { sessionId: "s-refund", cardId: "s-refund", revision: "r7", questions: [] } },
      { key: "h-captions", status: "pending", title: "자막 오탈자 사전에 고유명사를 더할까요?", projectId: "editor", at: minutes(130),
        recipientId: "s-captions", answer: "고유명사 목록은 제품 팀 문서에서 가져와 주세요." },
      { key: "h-links", status: "unsent", title: "깨진 외부 링크를 지울까요?", projectId: "docs", at: minutes(200),
        recipientId: "s-gone", answer: "지우지 말고 보관 링크로 바꿔 주세요." },
    ],
    trackedDecisions: {
      status: "ok",
      items: [
        { source: "coordinator", projectId: "billing", id: "r-refund", key: "r-refund", fingerprint: fingerprint("a"), matchedSessionId: null, matchedPull: null,
          title: "환불 API v2 전환 시점을 정해 주세요", projectTitle: "billing-api", kind: "answer", where: "human", dueAt: minutes(60 * 26), since: minutes(60 * 30),
          ask: ["v1 호출이 아직 하루 1,200건 있습니다. 전환을 다음 주로 미룰지 정해 주세요."], recommend: ["다음 주 화요일로 미루고 v1 경고 응답을 먼저 켭니다."] },
        { source: "coordinator", projectId: null, id: "r-login", key: "r-login", fingerprint: fingerprint("b"), matchedSessionId: null, matchedPull: null,
          title: "새 기기 로그인 승인 정책", kind: "approve", where: "human", urgency: "week", since: minutes(60 * 20) },
      ],
    },
    pullRequests: {
      projects: [{ projectId: "docs", repo: "acme/docs-site", mode: "auto", status: "ok" }],
      items: [
        { repo: "acme/docs-site", number: 142, title: "설치 안내를 플러그인 페이지로 이동", url: "https://github.com/acme/docs-site/pull/142",
          projectIds: ["docs"], lane: "review", reason: "ready", updatedAt: minutes(90) },
        { repo: "acme/docs-site", number: 145, title: "검색 결과 강조 색 바꾸기", url: "https://github.com/acme/docs-site/pull/145",
          projectIds: ["docs"], lane: "progress", reason: "checks-pending", updatedAt: minutes(15) },
      ],
    },
  };
}
