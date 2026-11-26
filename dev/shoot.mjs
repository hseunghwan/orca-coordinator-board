// Screenshots the harness in a local headless Chrome or Edge over the DevTools protocol, waiting in
// real time so ResizeObserver layouts settle: node dev/shoot.mjs [name pattern]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const browsers = [
  process.env.BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].filter(Boolean);
const browser = browsers.find(path => existsSync(path));
if (!browser) throw new Error("No Chrome or Edge found; set BROWSER to its path.");

const page = pathToFileURL(resolve("dev/out/index.html")).href;
const press = (...labels) => "&press=" + encodeURIComponent(labels.join(","));
const shots = [
  ["inbox-light-wide", "theme=light", 1280, 800],
  ["inbox-dark-wide", "theme=dark", 1280, 800],
  ["inbox-light-narrow", "theme=light", 520, 800],
  ["inbox-dark-narrow", "theme=dark", 520, 800],
  ["inbox-light-narrow-detail", "theme=light" + press("결제 웹훅"), 520, 800],
  ["inbox-dark-narrow-detail", "theme=dark" + press("결제 웹훅"), 520, 800],
  ["inbox-light-evidence", "theme=light" + press("결제 웹훅", "근거 보기"), 1280, 800],
  ["inbox-dark-permission", "theme=dark" + press("응답을 기다리는"), 1280, 800],
  ["progress-light-wide", "theme=light" + press("진행"), 1280, 1000],
  ["progress-dark-wide", "theme=dark" + press("진행"), 1280, 1000],
  ["progress-dark-narrow", "theme=dark" + press("진행"), 520, 1000],
  ["history-dark-wide", "theme=dark" + press("기록"), 1280, 500],
  ["settings-light", "theme=light" + press("설정", "보드에서 관리할"), 1280, 700],
  ["classic-dark-wide", "theme=dark&view=classic", 1280, 1000],
  ["focus-light-wide", "theme=light&view=focus", 1280, 900],
  ["focus-dark-wide", "theme=dark&view=focus", 1280, 900],
  ["focus-light-narrow", "theme=light&view=focus", 520, 1000],
  ["focus-dark-narrow", "theme=dark&view=focus", 520, 1000],
  ["focus-later-dark-wide", "theme=dark&view=focus" + press("나중에"), 1280, 900],
  ["focus-progress-light-wide", "theme=light&view=focus" + press("진행 보기"), 1280, 1400],
  ["focus-empty-light-wide", "theme=light&view=focus&empty=1", 1280, 500],
  ["focus-empty-dark-narrow", "theme=dark&view=focus&empty=1", 520, 600],
  ["focus-handled-light-wide", "theme=light&view=focus&solo=1" + press("담당 세션에 답장 보내기"), 1280, 600],
  ["focus-handled-dark-narrow", "theme=dark&view=focus&solo=1" + press("담당 세션에 답장 보내기"), 520, 700],
  ["matrix-light-wide", "theme=light&view=matrix", 1280, 900],
  ["matrix-dark-wide", "theme=dark&view=matrix", 1280, 900],
  ["matrix-ribbon-light-wide", "theme=light&view=matrix" + press("답변 대기 2시간"), 1280, 1300],
  ["matrix-ribbon-dark-wide", "theme=dark&view=matrix" + press("권한 승인 대기"), 1280, 1100],
  ["matrix-cell-light-wide", "theme=light&view=matrix" + press("결제 대시보드"), 1280, 1100],
  ["matrix-cell-dark-wide", "theme=dark&view=matrix" + press("#editor-app · 내 결정"), 1280, 1300],
  ["matrix-cell-light-medium", "theme=light&view=matrix" + press("#editor-app · 내 결정"), 760, 1700],
  ["matrix-narrow-light", "theme=light&view=matrix", 520, 1000],
  ["matrix-narrow-dark", "theme=dark&view=matrix" + press("#editor-app · 결정", "#editor-app · 내 결정"), 520, 1800],
  ["matrix-narrow-open-light", "theme=light&view=matrix" + press("#docs-site · 결정"), 520, 1200],
  ["inbox-en-dark-wide", "theme=dark&lang=en", 1280, 800],
  ["inbox-empty-light", "theme=light&empty=1", 1280, 500],
  ["reply-draft-tooltip-light-wide", "theme=light" + press("결제 웹훅"), 1280, 800, "담당 세션에 답장 보내기"],
  ["reply-draft-tooltip-dark-narrow", "theme=dark" + press("결제 웹훅"), 520, 900, "담당 세션에 답장 보내기"],
  ["reply-review-gate-light-wide", "theme=light" + press("결제 웹훅", "5회 + TTL"), 1280, 800],
  ["reply-review-open-dark-wide", "theme=dark" + press("결제 웹훅", "5회 + TTL", "답장 전문 보기"), 1280, 900],
  ["reply-sent-light-wide", "theme=light" + press("결제 웹훅", "담당 세션에 답장 보내기"), 1280, 800],
  ["reply-sent-dark-narrow", "theme=dark" + press("결제 웹훅", "담당 세션에 답장 보내기"), 520, 800],
  ["reply-uncertain-dark-wide", "theme=dark&send=1" + press("결제 웹훅", "담당 세션에 답장 보내기"), 1280, 800],
  ["reply-uncertain-light-narrow", "theme=light&send=1" + press("결제 웹훅", "담당 세션에 답장 보내기"), 520, 900],
  ["reply-other-recipient-light-wide", "theme=light&send=2" + press("결제 웹훅", "담당 세션에 답장 보내기"), 1280, 800],
  ["clarification-light-wide", "theme=light" + press("결제 웹훅", "질문하기"), 1280, 900],
  ["clarification-dark-narrow", "theme=dark" + press("결제 웹훅", "질문하기"), 520, 1000],
  ["history-tab-light-wide", "theme=light" + press("기록", "최근 결정 기록", "내용 펼치기"), 1280, 900],
  ["history-tab-dark-narrow", "theme=dark" + press("기록", "최근 결정 기록", "이전 기록 더 보기"), 520, 1200],
  ["classic-history-dark-wide", "theme=dark&view=classic" + press("최근 결정 기록"), 1280, 2200],
  ["coord-setup-light-wide", "theme=light" + press("코디네이터에 요청"), 1280, 800],
  ["coord-setup-dark-narrow", "theme=dark" + press("코디네이터에 요청"), 520, 900],
  ["coord-setup-started-light-wide", "theme=light" + press("코디네이터에 요청", "추천 설정으로 시작"), 1280, 800],
  ["coord-setup-error-dark-wide", "theme=dark&fail=1" + press("코디네이터에 요청", "추천 설정으로 시작"), 1280, 800],
  ["coord-composer-light-wide", "theme=light&coord=1" + press("코디네이터에 요청"), 1280, 800],
  ["coord-composer-dark-narrow", "theme=dark&coord=1" + press("코디네이터에 요청"), 520, 900],
  ["coord-composer-expanded-dark-wide", "theme=dark&coord=1" + press("코디네이터에 요청", "입력창 펼치기"), 1280, 900],
  ["coord-sent-light-wide", "theme=light&coord=1" + press("코디네이터에 요청", "@코디네이터에게 맡길 일=검색 UI 세션에 접근성 점검을 맡겨 주세요", "코디네이터에 요청 보내기"), 1280, 800],
  ["coord-digest-dark-narrow", "theme=dark&coord=1" + press("코디네이터에 요청", "다이제스트 요청"), 520, 900],
  ["coord-error-light-narrow", "theme=light&coord=1&fail=1" + press("코디네이터에 요청", "다이제스트 요청"), 520, 900],
  ["coord-error-dark-wide", "theme=dark&coord=1&fail=1" + press("코디네이터에 요청", "@코디네이터에게 맡길 일=정리해 주세요", "코디네이터에 요청 보내기"), 1280, 800],
  ["coord-en-dark-wide", "theme=dark&coord=1&lang=en" + press("Ask the coordinator"), 1280, 800],
  ["coord-focus-light-wide", "theme=light&coord=1&view=focus" + press("코디네이터에 요청"), 1280, 800],
  ["coord-classic-light-wide", "theme=light&coord=1&view=classic", 1280, 1400],
  ["coord-advice-light-wide", "theme=light&coord=1" + press("검색 색인"), 1280, 800],
  ["coord-advice-sent-dark-wide", "theme=dark&coord=1" + press("검색 색인", "코디네이터에 추천 요청"), 1280, 800],
  ["coord-coordinate-light-wide", "theme=light&coord=1" + press("결제 웹훅", "다른 방법", "코디네이터에 조율 요청"), 1280, 900],
  ["coord-settings-light-wide", "theme=light&coord=1" + press("설정", "기존 세션에서 코디네이터 지정"), 1280, 1700],
  ["coord-settings-replace-dark-wide", "theme=dark&coord=1" + press("설정", "새 코디네이터로 교체"), 1280, 1400],
  ["coord-settings-dark-narrow", "theme=dark" + press("설정", "기존 세션에서 코디네이터 지정"), 520, 1700],
  ["ledger-inbox-light-wide", "theme=light&ledger=1&coord=1", 1280, 900],
  ["ledger-questions-light-wide", "theme=light&ledger=1&coord=1" + press("미리보기 캐시", "근거·이력 보기", "A · 7일", "pdf · PDF", "video"), 1280, 1500],
  ["ledger-questions-dark-narrow", "theme=dark&ledger=1&coord=1" + press("미리보기 캐시", "근거·이력 보기", "A · 7일"), 520, 2000],
  ["ledger-skip-dark-wide", "theme=dark&ledger=1&coord=1" + press("미리보기 캐시", "A · 7일", "이 질문 건너뛰기"), 1280, 1000],
  ["ledger-sent-light-wide", "theme=light&ledger=1&coord=1" + press("미리보기 캐시", "A · 7일", "pdf · PDF", "코디네이터에 답장 보내기"), 1280, 900],
  ["ledger-queued-dark-wide", "theme=dark&ledger=1&coord=1" + press("번들 분석"), 1280, 800],
  ["ledger-queued-light-narrow", "theme=light&ledger=1&coord=1" + press("번들 분석"), 520, 1000],
  ["ledger-stopped-light-wide", "theme=light&ledger=1&coord=1" + press("검색 색인 로그"), 1280, 800],
  ["ledger-cancel-queued-dark-wide", "theme=dark&ledger=1&coord=1" + press("번들 분석", "전송 대기 취소"), 1280, 800],
  ["ledger-resolve-queued-light-wide", "theme=light&ledger=1&coord=1&resolve=queued" + press("@환불 API v2 전환 시점을 정해 주세요 · 답장=다음 주 화요일로 미뤄 주세요", "코디네이터에 답장 보내기"), 1280, 800],
  ["ledger-resolve-busy-dark-wide", "theme=dark&ledger=1&coord=1&resolve=busy" + press("@환불 API v2 전환 시점을 정해 주세요 · 답장=다음 주 화요일로 미뤄 주세요", "코디네이터에 답장 보내기"), 1280, 800],
  ["ledger-resolve-unconfirmed-light-narrow", "theme=light&ledger=1&coord=1&resolve=unconfirmed" + press("환불 API v2", "@환불 API v2 전환 시점을 정해 주세요 · 답장=다음 주 화요일로 미뤄 주세요", "코디네이터에 답장 보내기"), 520, 1000],
  ["ledger-resolve-changed-light-wide", "theme=light&ledger=1&coord=1&resolve=changed" + press("@환불 API v2 전환 시점을 정해 주세요 · 답장=다음 주 화요일로 미뤄 주세요", "코디네이터에 답장 보내기"), 1280, 800],
  ["ledger-merge-light-wide", "theme=light&ledger=1&coord=1" + press("설치 안내 이동"), 1280, 900],
  ["ledger-merge-preview-light-wide", "theme=light&ledger=1&coord=1" + press("설치 안내 이동", "보드에서 병합"), 1280, 1000],
  ["ledger-merge-preview-dark-narrow", "theme=dark&ledger=1&coord=1" + press("설치 안내 이동", "보드에서 병합", "merge"), 520, 1400],
  ["ledger-merge-done-light-wide", "theme=light&ledger=1&coord=1" + press("설치 안내 이동", "보드에서 병합", "병합 확정"), 1280, 900],
  ["ledger-merge-done-dark-narrow", "theme=dark&ledger=1&coord=1" + press("설치 안내 이동", "보드에서 병합", "병합 확정"), 520, 1000],
  ["ledger-merge-unconfirmed-dark-wide", "theme=dark&ledger=1&coord=1&merge=unconfirmed" + press("설치 안내 이동", "보드에서 병합", "병합 확정"), 1280, 900],
  ["ledger-merge-blocked-light-wide", "theme=light&ledger=1&coord=1&merge=blocked" + press("설치 안내 이동", "보드에서 병합"), 1280, 900],
  ["ledger-pull-open-light-wide", "theme=light&ledger=1&coord=1" + press("결제 재시도 PR"), 1280, 800],
  ["ledger-pull-merged-dark-wide", "theme=dark&ledger=1&coord=1&pull=MERGED" + press("결제 재시도 PR"), 1280, 800],
  ["ledger-pull-closed-light-narrow", "theme=light&ledger=1&coord=1&pull=CLOSED" + press("결제 재시도 PR"), 520, 900],
  ["ledger-pull-unknown-dark-narrow", "theme=dark&ledger=1&coord=1&pull=UNKNOWN" + press("결제 재시도 PR"), 520, 900],
  ["ledger-check-light-wide", "theme=light&ledger=1&coord=1" + press("배포된 문서"), 1280, 800],
  ["ledger-checked-dark-wide", "theme=dark&ledger=1&coord=1" + press("배포된 문서", "확인했어요"), 1280, 800],
  ["ledger-template-light-wide", "theme=light&ledger=1&coord=1" + press("정산 배치 시간"), 1280, 800],
  ["ledger-template-loaded-dark-narrow", "theme=dark&ledger=1&coord=1" + press("정산 배치 시간", "답장 양식 불러오기"), 520, 1000],
  ["ledger-owner-verify-light-wide", "theme=light&ledger=1&coord=1" + press("환불 한도", "운영 코디네이터"), 1280, 800],
  ["ledger-close-confirm-dark-wide", "theme=dark&ledger=1&coord=1" + press("정산 배치 시간", "근거·이력 보기", "기록 닫기"), 1280, 900],
  ["ledger-closed-light-wide", "theme=light&ledger=1&coord=1" + press("정산 배치 시간", "근거·이력 보기", "기록 닫기", "기록 닫기 확정"), 1280, 900],
  ["ledger-progress-light-wide", "theme=light&ledger=1&coord=1" + press("진행"), 1280, 1500],
  ["ledger-progress-record-dark-wide", "theme=dark&ledger=1&coord=1" + press("진행", "결제 재시도 PR"), 1280, 1500],
  ["ledger-progress-dark-narrow", "theme=dark&ledger=1&coord=1" + press("진행"), 520, 2400],
  ["ledger-settings-light-wide", "theme=light&ledger=1&coord=1" + press("설정", "프로젝트별 GitHub"), 1280, 1700],
  ["ledger-settings-dark-narrow", "theme=dark&ledger=1&coord=1&repo=fail" + press("설정", "프로젝트별 GitHub", "자동 답장 꺼짐", "저장소 연결"), 520, 2200],
  ["ops-settings-light-wide", "theme=light&coord=1" + press("설정"), 1280, 3000],
  ["ops-settings-dark-wide", "theme=dark&coord=1" + press("설정"), 1280, 3000],
  ["ops-settings-light-narrow", "theme=light&coord=1" + press("설정"), 520, 4600],
  ["ops-settings-dark-narrow", "theme=dark&coord=1" + press("설정"), 520, 4600],
  ["ops-codex-mode-dark-wide", "theme=dark&coord=1" + press("설정", "#codex · 새 작업 세션 권한"), 1280, 3000],
  ["ops-codex-restored-light-narrow", "theme=light&coord=1" + press("설정", "#codex · 새 작업 세션 권한", "권장 모드 복원"), 520, 4600],
  ["ops-route-edit-light-wide", "theme=light&coord=1" + press("설정", "B · 높음", "claude / opus", "xhigh", "후보에 추가"), 1280, 3200],
  ["ops-route-saved-dark-narrow", "theme=dark&coord=1" + press("설정", "B · 높음", "후보 제외", "배정표 저장"), 520, 4600],
  ["ops-conflict-dark-wide", "theme=dark&coord=1&ops=conflict" + press("설정", "사용량 기반 자동 배정"), 1280, 3000],
  ["ops-settings-en-light-wide", "theme=light&coord=1&lang=en" + press("Settings"), 1280, 3000],
  ["photo-reply-light-wide", "theme=light" + press("결제 웹훅", "+2"), 1280, 900],
  ["photo-reply-dark-narrow", "theme=dark" + press("결제 웹훅", "+2"), 520, 1100],
  ["photo-reply-sent-light-wide", "theme=light" + press("결제 웹훅", "+1", "담당 세션에 답장 보내기"), 1280, 900],
  ["photo-count-error-light-wide", "theme=light" + press("결제 웹훅", "+5"), 1280, 900],
  ["photo-format-error-dark-wide", "theme=dark" + press("결제 웹훅", "+bad"), 1280, 900],
  ["photo-clarify-light-wide", "theme=light" + press("결제 웹훅", "질문하기", "+1/2"), 1280, 1100],
  ["photo-clarify-dark-narrow", "theme=dark" + press("결제 웹훅", "질문하기", "+1/2"), 520, 1400],
  ["photo-coord-light-wide", "theme=light&coord=1" + press("코디네이터에 요청", "+2"), 1280, 900],
  ["photo-coord-sent-dark-wide", "theme=dark&coord=1" + press("코디네이터에 요청", "+2", "코디네이터에 요청 보내기"), 1280, 900],
  ["photo-coord-dark-narrow", "theme=dark&coord=1" + press("코디네이터에 요청", "+1"), 520, 1000],
  ["photo-ledger-light-wide", "theme=light&ledger=1&coord=1" + press("미리보기 캐시", "A · 7일", "+1"), 1280, 1300],
  ["photo-ledger-dark-narrow", "theme=dark&ledger=1&coord=1" + press("미리보기 캐시", "A · 7일", "+1"), 520, 1800],
  ["photo-history-light-wide", "theme=light" + press("기록", "최근 결정 기록", "이전 기록 더 보기", "사진 2"), 1280, 1200],
  ["photo-history-dark-narrow", "theme=dark" + press("기록", "최근 결정 기록", "이전 기록 더 보기", "사진 1"), 520, 1400],
  ["photo-history-fail-light-narrow", "theme=light&photo=fail" + press("기록", "최근 결정 기록", "이전 기록 더 보기", "사진 1"), 520, 1400],
  ["links-light-wide", "theme=light" + press("설정", "다른 프로젝트의 세션"), 1280, 1400],
  ["links-dark-narrow", "theme=dark" + press("설정", "다른 프로젝트의 세션"), 520, 2000],
  ["links-pick-light-wide", "theme=light" + press("설정", "다른 프로젝트의 세션", "#오프라인 동기화", "#billing-api"), 1280, 1500],
  ["links-linked-dark-wide", "theme=dark" + press("설정", "다른 프로젝트의 세션", "#오프라인 동기화", "#editor-app", "이 프로젝트에 연결"), 1280, 1500],
  ["links-unlink-light-narrow", "theme=light" + press("설정", "다른 프로젝트의 세션", "#푸시 알림 문구", "프로젝트 연결 해제"), 520, 2000],
  ["links-missing-dark-narrow", "theme=dark" + press("설정", "다른 프로젝트의 세션", "#예전 빌드 실험"), 520, 2000],
  ["links-search-light-wide", "theme=light" + press("설정", "다른 프로젝트의 세션", "@연결할 세션 검색=충돌"), 1280, 1100],
  ["links-more-dark-wide", "theme=dark" + press("설정", "다른 프로젝트의 세션", "세션 더 보기"), 1280, 1800],
  ["links-fail-light-wide", "theme=light&links=fail" + press("설정", "다른 프로젝트의 세션"), 1280, 1000],
  ["links-conflict-dark-wide", "theme=dark&links=conflict" + press("설정", "다른 프로젝트의 세션", "#오프라인 동기화", "#billing-api", "이 프로젝트에 연결"), 1280, 1500],
  ["ledger-merge-preview-en-dark-wide", "theme=dark&ledger=1&coord=1&lang=en" + press("설치 안내 이동", "Merge on board"), 1280, 1000],
];
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;

const profile = mkdtempSync(join(tmpdir(), "board-shots-"));
const chrome = spawn(browser, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
  "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const endpoint = await new Promise((done, fail) => {
  let seen = "";
  chrome.stderr.on("data", chunk => {
    seen += chunk;
    const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
    if (match) done(match[1]);
  });
  chrome.on("exit", () => fail(new Error("Browser exited: " + seen)));
});
const port = new URL(endpoint).port;
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(done => socket.addEventListener("open", done, { once: true }));
let next = 0;
const waiting = new Map();
const listeners = new Set();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) { waiting.get(message.id)(message.result); waiting.delete(message.id); }
  else for (const listener of listeners) listener(message);
});
const send = (method, params = {}) => new Promise(done => { const id = ++next; waiting.set(id, done); socket.send(JSON.stringify({ id, method, params })); });
const loaded = () => new Promise(done => { const on = message => { if (message.method === "Page.loadEventFired") { listeners.delete(on); done(); } }; listeners.add(on); });
const sleep = ms => new Promise(done => setTimeout(done, ms));

await send("Page.enable");
mkdirSync("dev/shots", { recursive: true });
try {
  for (const [name, query, width, height, hover] of shots) {
    if (only && !only.test(name)) continue;
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const load = loaded();
    await send("Page.navigate", { url: `${page}?${query}` });
    await load;
    await sleep(1500 + 450 * (query.split("press=")[1]?.split("%2C").length ?? 0));
    if (hover) {
      const { result } = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
        const button = [...document.querySelectorAll("button")].find(b => b.offsetParent && b.textContent.trim().startsWith(${JSON.stringify(hover)}));
        const box = button?.getBoundingClientRect();
        return box && { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()` });
      if (result.value) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: result.value.x, y: result.value.y });
      await sleep(300);
    }
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    const out = resolve("dev/shots", name + ".png");
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(out);
  }
} finally {
  socket.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
