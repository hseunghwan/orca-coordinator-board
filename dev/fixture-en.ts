// English text for the invented board, used when a harness page asks for lang=en (listing screenshots).
// Whole strings are swapped; workspace names derived from a title follow the translated title.
const en: Record<string, string> = {
  "깨진 링크 12개를 고쳤고 검사 스크립트를 CI에 넣었습니다.": "Fixed 12 broken links and added the link check to CI.",
  "웹훅 안정화": "Webhook hardening",
  "재시도 3회에서 실패율이 0.8%입니다. 5회로 늘리면 0.1%까지 내려가지만, 중복 결제 방지 키의 유효 시간(`IDEMPOTENCY_TTL=24h`)을 넘기지 않는지 확인해야 합니다.":
    "With 3 retries the failure rate is 0.8%. Raising it to 5 brings it down to 0.1%, but the retries must stay within the idempotency key lifetime (`IDEMPOTENCY_TTL=24h`).",
  "결제 웹훅 재시도를 5회로 늘릴까요?": "Raise payment webhook retries to 5?",
  "결제 웹훅 재시도를 5회로 늘릴까요?\n\n재시도 3회에서 실패율이 0.8%입니다. 5회로 늘리면 0.1%까지 내려가지만, 중복 결제 방지 키의 유효 시간(`IDEMPOTENCY_TTL=24h`)을 넘기지 않는지 확인해야 합니다.\n마지막 재시도 간격은 6시간입니다.":
    "Raise payment webhook retries to 5?\n\nWith 3 retries the failure rate is 0.8%. Raising it to 5 brings it down to 0.1%, but the retries must stay within the idempotency key lifetime (`IDEMPOTENCY_TTL=24h`).\nThe last retry interval is 6 hours.",
  "5회로 늘리고 TTL을 48시간으로 올려 주세요.": "Go to 5 retries and raise the TTL to 48 hours.",
  "5회 + TTL 48시간": "5 retries + 48h TTL",
  "재시도를 5회로 늘려 주세요.\n중복 결제 방지 키의 TTL은 48시간으로 올리고, 정산 배치 시간과 겹치지 않는지 배포 전에 한 번 더 확인해 주세요.":
    "Please raise retries to 5.\nRaise the idempotency key TTL to 48 hours, and check once more before deploying that it does not overlap the settlement batch.",
  "3회 유지": "Keep 3",
  "3회를 유지하고 실패 건은 수동으로 다시 보내 주세요.": "Keep 3 retries and resend the failures by hand.",
  "5회로 늘리고 TTL을 48시간으로 함께 올리는 쪽을 권합니다. 회계 정산 배치와 겹치지 않습니다.":
    "Raising retries to 5 together with a 48-hour TTL is recommended. It does not overlap the settlement batch.",
  "DB 마이그레이션": "DB migration",
  "응답을 기다리는 요청 1건": "1 request awaiting a response",
  "자막 검수": "Caption review",
  "자막 오탈자 23건을 찾았습니다. 결정 필요: 자막 오탈자 23건을 자동 수정할까요? 근거: 사전 대조 결과입니다.":
    "Found 23 caption typos. Decision needed: Auto-fix the 23 caption typos? Evidence: dictionary check.",
  "결정 필요: 자막 오탈자 23건을 자동 수정할까요? 근거: 사전 대조 결과입니다.": "Decision needed: Auto-fix the 23 caption typos? Evidence: dictionary check.",
  "고칠 범위(전체 또는 제목만)를 알려 주세요.": "Tell me the scope (everything, or titles only).",
  "검색 색인": "Search index",
  "검색 색인 재생성은 30분 걸립니다. 언제 돌릴까요?": "Rebuilding the search index takes 30 minutes. When should it run?",
  "검색 색인 재생성을 언제 돌릴까요?": "When should the search index rebuild run?",
  "결제 대시보드 리팩터링": "Billing dashboard refactor",
  "작업 중": "Working",
  "환불 API 문서": "Refund API docs",
  "다음 요청 대기": "Waiting for the next request",
  "번들 크기 줄이기": "Shrink the bundle",
  "세션 결과 확인 필요": "Session result needs review",
  "링크 검사": "Link check",
  "검색 UI": "Search UI",
  "정산 배치는 몇 시에 도나요?": "When does the settlement batch run?",
  "매일 02:00에 돕니다. 마지막 재시도 간격(6시간)과 겹칠 수 있습니다.": "Daily at 02:00. It can overlap the last retry interval (6 hours).",
  "TTL을 올리면 저장소 용량은 얼마나 늘어나요?": "How much storage does a longer TTL add?",
  "환불 API 문서에 오류 코드 표를 넣을까요?": "Add an error code table to the refund API docs?",
  "네, 넣어 주세요. 오류 코드마다 다시 시도해도 되는지 한 줄씩 적어 주세요.\n\n- 4xx는 다시 시도하지 않는다고 적어 주세요.\n- 5xx는 지수 백오프로 세 번까지라고 적어 주세요.\n- 429는 Retry-After 헤더를 따르라고 적어 주세요.":
    "Yes, please. Add one line per error code on whether it is safe to retry.\n\n- 4xx: do not retry.\n- 5xx: up to three times with exponential backoff.\n- 429: follow the Retry-After header.",
  "표를 넣었습니다. 오류 코드 14개에 재시도 여부와 예시 응답을 붙였고, 문서 빌드를 통과했습니다.":
    "Added the table: 14 error codes with retry guidance and sample responses. The docs build passes.",
  "결제 실패 화면 문구를 바꿀까요?": "Change the payment failure screen copy?",
  "첨부한 두 화면처럼 버튼 문구를 \"다시 결제\"로 바꿔 주세요.": "Change the button to \"Pay again\" as in the two attached screens.",
  "자막 오탈자 사전에 고유명사를 더할까요?": "Add proper nouns to the caption dictionary?",
  "고유명사 목록은 제품 팀 문서에서 가져와 주세요.": "Take the proper noun list from the product team's doc.",
  "깨진 외부 링크를 지울까요?": "Delete the broken external links?",
  "지우지 말고 보관 링크로 바꿔 주세요.": "Don't delete them; point them at archived copies.",
  "환불 API v2 전환 시점을 정해 주세요": "Pick the cutover date for refund API v2",
  "v1 호출이 아직 하루 1,200건 있습니다. 전환을 다음 주로 미룰지 정해 주세요.": "v1 still gets 1,200 calls a day. Decide whether to push the cutover to next week.",
  "다음 주 화요일로 미루고 v1 경고 응답을 먼저 켭니다.": "Move it to next Tuesday and turn on v1 deprecation warnings first.",
  "새 기기 로그인 승인 정책": "New-device sign-in approval policy",
  "설치 안내를 플러그인 페이지로 이동": "Move install guide to the plugin page",
  "검색 결과 강조 색 바꾸기": "Change search highlight color",
  "미리보기 캐시 정책을 정해 주세요": "Set the preview cache policy",
  "미리보기 캐시가 하루 3GB씩 늘어납니다.": "The preview cache grows 3 GB a day.",
  "지난주 디스크 경보가 두 번 울렸습니다.": "The disk alarm fired twice last week.",
  "캐시를 줄이면 첫 미리보기가 2초 느려집니다.": "A smaller cache makes the first preview 2 seconds slower.",
  "정책 결정": "Decide the policy",
  "설정 반영": "Apply the setting",
  "하루 지켜보기": "Watch for a day",
  "지금 캐시 크기는 얼마인가요?": "How big is the cache now?",
  "41GB입니다.": "41 GB.",
  "캐시 보관 기간을 어떻게 할까요?": "How long should the cache keep previews?",
  "7일": "7 days",
  "대부분의 문서는 사흘 안에 다시 열립니다.": "Most documents are reopened within three days.",
  "7일 지난 미리보기를 지웁니다.": "Deletes previews older than 7 days.",
  "디스크가 일정하게 유지됩니다.": "Disk use stays flat.",
  "오래된 문서는 처음 열 때 느립니다.": "Old documents are slow to open the first time.",
  "30일": "30 days",
  "30일 지난 미리보기를 지웁니다.": "Deletes previews older than 30 days.",
  "다시 만들 일이 거의 없습니다.": "Previews rarely need rebuilding.",
  "디스크 경보가 계속 날 수 있습니다.": "The disk alarm may keep firing.",
  "캐시에서 뺄 형식을 골라 주세요": "Pick the formats to leave out of the cache",
  "동영상": "Video",
  "RAW 사진": "RAW photos",
  "번들 분석 결과를 어디에 남길까요?": "Where should the bundle analysis go?",
  "분석 결과는 PR 설명에 표로 남겨 주세요.": "Put the analysis in the PR description as a table.",
  "검색 색인 로그를 지울까요?": "Delete the search index logs?",
  "30일 지난 로그만 지워 주세요.": "Delete only logs older than 30 days.",
  "설치 안내 이동 PR을 병합할까요?": "Merge the install guide PR?",
  "https://github.com/acme/docs-site/pull/142 을 병합해 주세요.": "Please merge https://github.com/acme/docs-site/pull/142.",
  "squash로 병합하고 배포 확인을 맡깁니다.": "Squash-merge it and hand off the deploy check.",
  "검사 4건이 모두 통과했습니다.": "All 4 checks passed.",
  "결제 재시도 PR 병합 확인": "Confirm the payment retry PR merge",
  "보안 게이트를 통과하면 병합해 주세요.": "Merge once the security gate passes.",
  "배포된 문서 첫 화면을 직접 확인해 주세요": "Check the deployed docs home page yourself",
  "모바일에서 메뉴가 겹치지 않는지 봐 주세요.": "Make sure the menu does not overlap on mobile.",
  "정산 배치 시간을 알려 주세요": "Tell me the settlement batch time",
  "정산 배치는 <시각>에 돌려 주세요.": "Run the settlement batch at <time>.",
  "환불 한도 상향 승인": "Approve a higher refund limit",
  "한도를 건당 50만 원으로 올릴지 정해 주세요.": "Decide whether to raise the limit to $400 per refund.",
  "오프라인 동기화": "Offline sync",
  "푸시 알림 문구": "Push notification copy",
  "충돌 보고 정리": "Crash report cleanup",
  "예전 빌드 실험": "Old build experiment",
  "코디네이터": "Coordinator",
  "자동 승인": "Auto approve",
  "자동 검토": "Auto review",
  "기본": "Default",
  "권한 건너뛰기": "Skip permissions",
  "읽기 전용": "Read only",
  "5시간 한도": "5-hour limit",
  "주간 한도": "Weekly limit",
  "크레딧": "Credits",
};

const slug = (text: string) => text.toLowerCase().replace(/\s+/g, "-");
const slugs = new Map(Object.entries(en).map(([ko, english]) => [slug(ko), slug(english)]));

function swap(text: string): string {
  if (en[text]) return en[text];
  if (slugs.has(text)) return slugs.get(text)!;
  const polish = /^화면 다듬기 (\d+)$/.exec(text);
  return polish ? `UI polish ${polish[1]}` : text;
}

export function localize<T>(value: T): T {
  if (typeof value === "string") return swap(value) as T;
  if (Array.isArray(value)) return value.map(localize) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, localize(item)])) as T;
  return value;
}
