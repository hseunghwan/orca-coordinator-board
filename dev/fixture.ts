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
      { key: "h-photos", status: "sent", title: "결제 실패 화면 문구를 바꿀까요?", projectId: "billing", at: minutes(35),
        recipientId: "s-webhook", recipientTitle: "웹훅 안정화", recipientState: "idle", canOpen: true, imageCount: 2, localPhotos: true,
        answer: "첨부한 두 화면처럼 버튼 문구를 \"다시 결제\"로 바꿔 주세요." },
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

// Phase 5 ledger records, added when a harness page asks with ledger=1: questions, a queued reply, merge
// records, a personal check, a reply template and a ledger owned by a coordinator this board does not list.
export function fixtureLedger() {
  const record = (id: string, seed: string, fields: Record<string, unknown>) =>
    ({ source: "coordinator", id, key: id, fingerprint: fingerprint(seed), matchedSessionId: null, matchedPull: null, since: minutes(90), ...fields });
  return {
    records: [
      record("r-cache", "c", { projectId: "editor", projectTitle: "editor-app", title: "미리보기 캐시 정책을 정해 주세요", kind: "answer", where: "manager", urgency: "today",
        ask: ["미리보기 캐시가 하루 3GB씩 늘어납니다."], why: ["지난주 디스크 경보가 두 번 울렸습니다."], risk: ["캐시를 줄이면 첫 미리보기가 2초 느려집니다."], steps: ["정책 결정", "설정 반영", "하루 지켜보기"],
        qa: [{ q: "지금 캐시 크기는 얼마인가요?", a: "41GB입니다.", askedAt: minutes(80), answeredAt: minutes(75) }],
        questions: [
          { id: "q1", text: "캐시 보관 기간을 어떻게 할까요?", options: [
            { key: "A", text: "7일", recommended: true, note: "대부분의 문서는 사흘 안에 다시 열립니다.", does: "7일 지난 미리보기를 지웁니다.", pros: "디스크가 일정하게 유지됩니다.", cons: "오래된 문서는 처음 열 때 느립니다." },
            { key: "B", text: "30일", does: "30일 지난 미리보기를 지웁니다.", pros: "다시 만들 일이 거의 없습니다.", cons: "디스크 경보가 계속 날 수 있습니다." },
          ] },
          { id: "q2", text: "캐시에서 뺄 형식을 골라 주세요", multi: true, options: [
            { key: "pdf", text: "PDF" }, { key: "video", text: "동영상", recommended: true }, { key: "raw", text: "RAW 사진" },
          ] },
        ] }),
      record("r-queued", "d", { projectId: "editor", projectTitle: "editor-app", title: "번들 분석 결과를 어디에 남길까요?", kind: "answer", where: "session", sessionId: "s-bundle", urgency: "week",
        queuedReply: { messageId: "00000000-0000-4000-8000-000000000011", recipientId: "s-bundle", answer: "분석 결과는 PR 설명에 표로 남겨 주세요.", imageCount: 0, stopped: false } }),
      record("r-stopped", "e", { projectId: "docs", projectTitle: "docs-site", title: "검색 색인 로그를 지울까요?", kind: "cleanup", where: "session", sessionId: "s-search",
        queuedReply: { messageId: "00000000-0000-4000-8000-000000000012", recipientId: "s-search", answer: "30일 지난 로그만 지워 주세요.", imageCount: 0, stopped: true } }),
      record("r-merge", "f", { projectId: "docs", projectTitle: "docs-site", title: "설치 안내 이동 PR을 병합할까요?", kind: "merge", where: "human", urgency: "now",
        mergeTarget: { repo: "acme/docs-site", number: 142 }, matchedPull: { repo: "acme/docs-site", number: 142 },
        ask: ["https://github.com/acme/docs-site/pull/142 을 병합해 주세요."], recommend: ["squash로 병합하고 배포 확인을 맡깁니다."], why: ["검사 4건이 모두 통과했습니다."] }),
      record("r-lifecycle", "0", { projectId: "billing", projectTitle: "billing-api", title: "결제 재시도 PR 병합 확인", kind: "merge", where: "manager",
        mergeTarget: { repo: "acme/billing-api", number: 77 }, ask: ["보안 게이트를 통과하면 병합해 주세요."] }),
      record("r-check", "1", { projectId: "docs", projectTitle: "docs-site", title: "배포된 문서 첫 화면을 직접 확인해 주세요", kind: "check", where: "human",
        ask: ["모바일에서 메뉴가 겹치지 않는지 봐 주세요."] }),
      record("r-template", "2", { projectId: "billing", projectTitle: "billing-api", title: "정산 배치 시간을 알려 주세요", kind: "other", where: "human",
        howToAnswer: "정산 배치는 <시각>에 돌려 주세요." }),
      record("r-owner", "3", { projectId: "billing", projectTitle: "billing-api", title: "환불 한도 상향 승인", kind: "approve", where: "manager", sourceCoordinatorId: "s-old-coord",
        ask: ["한도를 건당 50만 원으로 올릴지 정해 주세요."] }),
    ],
    repositories: [
      { projectId: "billing", repo: "acme/billing-api", mode: "manual", status: "unavailable" },
      { projectId: "editor", repo: null, mode: "auto", status: "unmapped" },
    ],
    history: { key: "h-merge", status: "sent", title: "검색 결과 강조 색 바꾸기", projectId: "docs", at: minutes(20), recipientId: "s-coord",
      pullMerge: { repo: "acme/docs-site", number: 139, status: "merged", mergeSha: "0123456789abcdef0123456789abcdef01234567", notification: { status: "queued", recipientId: "s-coord" } } },
  };
}

// Sessions the link picker lists: a few from the unmanaged mobile project, one already linked and one whose session is gone.
export function fixtureSessionLinks() {
  const entry = (sessionId: string, title: string, sourceProjectId: string, workspaceTitle: string, targetProjectId: string | null = null, available = true) => {
    const source = projects.find(p => p.id === sourceProjectId)!;
    return { sessionId, title, sourceProjectId, sourceProjectTitle: source.title, workspaceTitle, targetProjectId, available };
  };
  return [
    entry("m-sync", "오프라인 동기화", "mobile", "feat-sync"),
    entry("m-push", "푸시 알림 문구", "mobile", "main", "billing"),
    entry("m-crash", "충돌 보고 정리", "mobile", "fix-crash"),
    entry("m-gone", "예전 빌드 실험", "mobile", "exp-build", "editor", false),
    ...Array.from({ length: 11 }, (_, i) => entry(`m-ui-${i + 1}`, `화면 다듬기 ${i + 1}`, "mobile", `ui-${i + 1}`)),
    entry("s-refund", "환불 API 문서", "billing", "환불-api-문서"),
  ];
}

// The coordinator joins the board only when a harness page asks for one.
export const coordinatorSession = { ...base("s-coord", "billing", "코디네이터"), lane: "idle" as const, status: "idle", activityAt: minutes(2), detail: "다음 요청 대기" };

export function fixtureOperations() {
  const later = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
  const auto = { id: "auto", label: "자동 승인" };
  return {
    catalog: [
      { provider: "claude", model: "opus", label: "Claude Opus", efforts: ["high", "xhigh"], isDefault: true, coordinatorMode: auto },
      { provider: "claude", model: "sonnet", label: "Claude Sonnet", efforts: ["medium", "high"], isDefault: false, coordinatorMode: auto },
      { provider: "claude", model: "haiku", label: "Claude Haiku", efforts: [], isDefault: false, coordinatorMode: auto },
      { provider: "codex", model: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high"], isDefault: true, coordinatorMode: { id: "auto-review", label: "자동 검토" } },
      { provider: "codex", model: "gpt-5.5-mini", label: "GPT-5.5 mini", efforts: ["low", "medium"], isDefault: false, coordinatorMode: { id: "auto-review", label: "자동 검토" } },
      { provider: "opencode", model: "qwen-coder", label: "Qwen Coder", efforts: [], isDefault: true, coordinatorMode: null },
    ],
    providers: [
      { id: "claude", label: "Claude Code", available: true, included: true, status: "ready", modelCount: 3,
        workerModes: [{ id: "default", label: "기본" }, { id: "auto", label: "자동 승인" }, { id: "bypassPermissions", label: "권한 건너뛰기" }] },
      { id: "codex", label: "Codex", available: true, included: true, status: "ready", modelCount: 2,
        workerModes: [{ id: "read-only", label: "읽기 전용" }, { id: "auto-review", label: "자동 검토" }, { id: "full-access", label: "Full Access" }] },
      { id: "opencode", label: "OpenCode", available: true, included: false, status: "ready", modelCount: null },
      { id: "gemini", label: "Gemini CLI", available: false, included: true, status: "unavailable", modelCount: null },
    ],
    workerModeOverrides: { codex: "full-access" } as Record<string, string>,
    usage: [
      { providerId: "claude", label: "Claude Code", plan: "Max", fetchedAt: minutes(3), status: "available",
        windows: [{ id: "5h", label: "5시간 한도", remainingPct: 62, resetsAt: later(140), summary: true },
          { id: "week", label: "주간 한도", remainingPct: 8, resetsAt: later(60 * 50), summary: false }], balances: [] },
      { providerId: "codex", label: "Codex", plan: "Pro", fetchedAt: minutes(120), status: "available",
        windows: [{ id: "5h", label: "5시간 한도", remainingPct: 40, resetsAt: minutes(10), summary: true },
          { id: "week", label: "주간 한도", remainingPct: 71, resetsAt: later(60 * 90), summary: false }], balances: [] },
      { providerId: "gemini", label: "Gemini CLI", plan: null, fetchedAt: null, status: "error", issue: "login", windows: [], balances: [] },
    ],
    displayUsage: [
      { providerId: "opencode", label: "OpenCode", plan: null, fetchedAt: minutes(5), status: "available", windows: [],
        balances: [{ id: "credit", label: "크레딧", remaining: 18.5, limit: 50, unit: "USD", resetsAt: null }] },
    ],
    usageRouting: true,
    coordinatorMode: auto,
    routing: { B: [{ provider: "claude", model: "sonnet", effort: "high" }, { provider: "codex", model: "gpt-5.5", effort: "medium" }, { provider: "gemini", model: "pro", effort: null }] } as Record<string, { provider: string; model: string; effort: string | null }[]>,
    revision: 1,
    workspaces: [
      { id: "w-coordinator-home", projectId: "coordinator-home", title: "Coordinator home", home: true },
      { id: "w-billing-main", projectId: "billing", title: "main", focused: true },
      { id: "w-editor-main", projectId: "editor", title: "main" },
      { id: "w-docs-search", projectId: "docs", title: "feat-search" },
    ],
  };
}
