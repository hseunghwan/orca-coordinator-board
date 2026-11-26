# 후보 2: Fleet 포트 (Orca 를 있는 그대로 드러내는 도메인 포트)

## Problem

Paseo 서버 로직(P/server 28개 파일)을 Orca 워커 위로 옮겨야 한다. Paseo 코드는 SDK 객체 `paseo` 를 거의 모든 함수에 매개변수로 넘기고, 그 SDK 는 Orca 에 없는 의미를 약속한다. 메시지 id 가 붙은 user_message, seq/epoch 가 있는 타임라인, 실행 중 끼워 넣기(steer), `sourceAgentId`, 이미지 첨부, idempotencyKey 로 만드는 에이전트, pendingPermissions 내용 같은 것들이다. Orca 쪽 사실은 이렇다(직접 관찰, 아래 "관찰한 형태").

- 세션 정보가 여러 곳에 흩어져 있다. CLI `agent list` 에는 orcaSessionId 가 있고 터미널 핸들이 없다. `terminal list` 에는 핸들이 있고 세션 id 가 없다. host `workspace.list` 는 id 형식이 다르다. 그래서 세 곳을 묶는 조인이 필요하다.
- `agent read` 는 커서가 없고 최대 100개만 준다. 긴 메시지는 **앞부분 약 1,200자만 남기고 뒤를 자른다**("… (truncated)"). Paseo 질문 감지는 마지막 assistant 턴을 **아래에서부터** 훑기 때문에, 이대로는 질문을 놓친다.
- 보내는 수단이 셋이다. `terminal send`, `orchestration send`(메일), 호출자 셸에서 실행하기. 각각 출처 표시, 재시도 규칙, Windows 인자 길이 제한(32,767자)이 다르다.
- Windows 에서는 ensemble 의 shim 방식이 그대로 동작하지 않는다(/tmp 소켓, `:` PATH, sh 전용 shim, 확장자 없는 orca 탐색).

지켜야 할 제약도 있다. P/shared 는 그대로 복사한다. RPC 이름과 계약 형태(`SessionRow` 등)는 Paseo 와 같아야 한다. "불확실하면 다시 보내지 않는다" 원칙을 지킨다. hook 은 2초 안에 끝나야 하고, 실패하면 그냥 통과로 처리된다.

## Usage (caller's view)

ported Paseo 코드는 Orca 를 모른다. `src/orca/index.ts` 의 `Fleet` 하나만 본다.

```ts
// P/server/decisions.ts — 보내기 (기존 refetch→id 찾기→해시 비교 복구 블록이 이 한 줄로 바뀐다)
store.transaction(s => s.decisionReceipts[messageId] = { status: "pending", ... });   // Paseo 그대로
const out = await fleet.deliver({
  messageId, to: input.recipientId, text: envelope(input, row), subject: cardTitle,
  mailType: "question", from: { kind: "person" }, whenWorking: "refuse", images,
});
if (out.status === "refused") throw Error(refusalText(out.reason));        // 아무것도 안 나감, 같은 id 로 나중에 재시도 가능
if (out.status === "unconfirmed") throw Error(uncertain);                  // Paseo 의 "불확실" 오류와 같음
markSent(messageId);                                                       // delivered
// 같은 카드를 다시 누르면 같은 messageId 로 같은 호출을 한다. Fleet 은 기록을 보고 대조만 한다. 절대 다시 보내지 않는다.
```

```ts
// P/server/discovery.ts — 스냅샷 (다시 씀)
const view = await fleet.view();              // CLI 2회 + host 2회, 2초 공유
const rows = [...view.sessions.values()].map(s => ({ id: s.id, ..., activityAt: iso(s.updatedAt), ...laneFacts(s) }));
// 이후 conversation.ts 의 classify(그대로)가 idle 행 중 질문이 있는 행을 human 으로 올린다
```

```ts
// P/server/board-facts.ts — 코디네이터 명의 발신. AgentCall 은 채널 서버만 만들 수 있다
export const factCommand = defineBoardCommand({
  verb: "fact", tool: "answer_board_fact", audience: "coordinator", input,
  async execute(input, { fleet, agent }) {
    const out = await fleet.deliver({ ..., from: { kind: "agent", call: agent }, whenWorking: "refuse" });
    // 경로 "mail-as-caller": 코디네이터 셸에서 orca orchestration send 가 돈다 → Orca 에 발신자가 코디네이터로 남는다
  },
});
```

코디네이터 쪽(README 에 들어갈 내용):

```
coordinator-board read                       # 추천이 필요한 세션 목록
coordinator-board read --session <id>        # 최근 4턴 + evidenceId
coordinator-board classify --session <id> --evidence <eid> --kind question --text-file q.txt
coordinator-board fact --cycle <c> --session <id> --evidence <eid>
# 종료 코드: 0 성공, 1 명령 오류, 2 플러그인 없음, 3 처리 중 끊김(됐는지 모름), 4 권한 없음
```

## Shape

### 핵심 결정: SDK 를 흉내 내지 않고, 도메인 포트를 하나 둔다

`Fleet` 은 동사 일곱 개짜리 깊은 모듈이다(`view / conversation / deliver / launch / catalog / remoteRunning / onSignal`, 여기에 이벤트 입력용 `observe`). 각 동사가 정책을 하나씩 숨긴다. 조인, 잘린 꼬리 복원, 마커, 경로 선택, 재전송 금지, launch 기록, 이벤트와 폴링 합치기가 그것이다. 공개 면에는 와이어 타입이 없다. 쓰이는 것은 `LiveSession`, `Conversation`, `DeliveryOutcome` 같은 도메인 타입뿐이다. 내부 모듈은 패키지 `imports` 맵과 eslint 로 바깥에서 import 할 수 없게 막는다(*per* boundary-discipline, importable internals 방지).

**P/server 파일 수(요청한 계수).** 28개 중 9개는 import 경로만 바뀐다. 3개는 타입과 이름만 기계적으로 바뀐다. 10개는 SDK 호출 부분만 바뀌고 업무 로직은 그대로다. 6개는 다시 쓴다(discovery, lifecycle, dispatch, coordinator, reporting, project-icons). index.server.ts 는 worker.ts 로 다시 쓴다. **본문이 바뀌는 파일은 16개다.** 검토 문서의 흉내 내기 방식이면 약 9개다. 차이 7개(decisions, clarifications, board-facts, merge-notifications, digest, usage-routing, session-links/operations)는 대부분 **보내기 지점**이다. 이 지점은 어느 쪽이든 의미가 바뀐다.
- Paseo 복구는 `messageHash = sha256(보낸 전체 텍스트)` 를 타임라인 텍스트와 비교한다. Orca 는 1,200자 뒤를 잘라서 준다. 흉내를 내면 긴 답장은 영원히 대조에 실패하고, 이 사실이 컴파일러에 걸리지 않는다.
- steer, sourceAgentId, images 도 흉내 층에서 조용히 다른 일이 된다. 큐잉, 호출자 셸 실행, 파일 경로로 바뀌는데 호출부는 그걸 모른다.
- 6개 파일에 복사돼 있던 "refetch 128 → id 찾기 → 해시 비교" 블록이 `deliver` 하나로 모인다. 고칠 곳이 한 곳이 된다(*per* encode-lessons-in-structure, single source of truth).

### 2. 세션 신원과 조인 (`src/orca/view.ts`)

| 무엇 | 값 | 쓰는 곳 |
|---|---|---|
| `SessionId` | CLI `orcaSessionId` | 보드 행 id. notes, judgments, answers, links 의 키. 채팅은 /clear 뒤에도 유지된다. 터미널은 /clear 하면 새 id 가 된다(새 대화이므로 새 행으로 받아들인다) |
| `PaneKey` | 터미널은 `<tabId>:<leafId>`, 채팅은 `structured-agent-session-<id>:<pane>` | **CLI 행과 `terminal list` 행을 잇는 열쇠다(관찰로 확인).** `ORCA_PANE_KEY`, 이벤트 `paneKey` 와 같다 |
| `TerminalHandle` | `term_<uuid>` | 터미널 전송 대상. host `terminalId` 와 같은 값(ensemble 사용례) |
| host `sessionId` | 제공자 대화 id | 쓰지 않는다(resume 전용) |
| `WorkspaceListId` | `identity:…` / `folder:…` | 프로젝트 소속. CLI 의 `<uuid>::<path>` 는 경로와 hostId 로 맞춘다(`workspaceKey` 함수 하나). `folder:` 는 문자열이 그대로 같다 |

host `agents.list` 는 **스냅샷에서 부르지 않는다.** 워크스페이스마다 한 번씩 불러야 하고, CLI `agent list` 한 번이 이미 모든 로컬 세션을 준다. `Reach`(terminal/chat/unreachable)는 뷰를 만들 때마다 계산하고 저장하지 않는다. 터미널 목록에 PTY 가 없는 done 행은 "잠든 세션"이다. 이런 세션에는 보내지 않는다.

**레인 표** (`laneFacts` 한 곳에만 둔다):

| Orca 상태 | status | lane | nativePending |
|---|---|---|---|
| blocked | blocked | human | true (권한) |
| waiting (AskUserQuestion 같은 TUI 질문) | waiting | human | true ("세션에서 답하기") |
| working | running | running | |
| done + 이벤트 outcome failure | error | review | |
| done + 잠듦 | closed | idle | |
| done (중단 포함) | idle | idle → **classify 가 질문/판단으로 human/review 로 올린다** | |
| 아직 id 없는 터미널 에이전트 | 행 아님 (`unidentified` 로 셈) | | |

평문 질문이 done 으로 보이는 문제는 이렇게 해결한다. done 을 먼저 idle 로 두고, Paseo 의 `classify`(그대로 복사)가 evidence 에서 질문을 찾으면 human 으로 올린다. `permissionVersion = sha256([id, state, stateSince ?? updatedAt])` 이다. 같은 대기 상태에서는 버전이 그대로이고, 새 대기 상태가 되면 버전이 바뀐다.

### 3. 대화 읽기와 evidenceId (`src/orca/conversation.ts`)

- 두 가지 항목 모양을 하나로 맞춘다. 터미널은 `{kind:"message", role, text, tools:[{name}]}`, 채팅은 `message` 와 별도 `{kind:"tool", name, state}` 다.
- **꼬리 복원.** 마지막 assistant 텍스트가 잘렸을 때, 터미널 행의 `lastAssistantMessage` 가 전체 텍스트이고(관찰: 최대 7,050자, 실제 끝까지 있음) 앞부분이 일치하면 그것으로 바꾼다. 채팅의 `lastAssistantMessage` 는 공백을 접은 앞 200자뿐이라 복원할 수 없다(위험 R3).
- **evidenceId** = `sha256(["orca-evidence/v1", sessionId, ...읽은 그대로의 항목(role, text, tool 이름)]).slice(0,24)`. 복원한 꼬리가 아니라 **읽은 그대로의 텍스트**를 해시한다. 그래서 Orca 전사 창이 같으면 id 도 같다. seq 대신 쓰는 구분자는 보드가 보낸 메시지의 `[cb:<uuid>]` 마커다. 보드를 거친 답장은 매번 유일하므로 "같은 문장이 반복돼 id 가 겹치는" 경우는 사람이 터미널에 같은 말을 직접 치고 에이전트도 똑같이 답할 때뿐이다(받아들인 위험).
- 상태가 `working` 이면 발췌를 거부한다(Paseo 의 gap 처리와 같다). 상태가 없으면 "알 수 없음"으로 받아들인다.

### 4. 보내기 (`src/orca/deliver.ts`)

**경로 표** (`chooseRoute` 순수 함수가 혼자 정한다):

| 발신자 \ 수신 | 터미널 | 채팅 |
|---|---|---|
| person (답장, 추가 질문, 장부 답, 다이제스트, 작업 요청) | `terminal send --enter --wait-submit 10`: user 턴이 된다, Paseo 와 같다 | 보드 메일함 터미널을 `--from` 으로 한 메일. 봉투에 origin person 표시 |
| board (병합 알림 = `plugin:coordinator-board`) | 보드 메일함 메일 | 같음 |
| agent (보드 사실 = 코디네이터 명의) | 호출자 셸에서 `orchestration send` (protocol-2 exec) | 같음 |

보드 메일함이 없으면 board 와 채팅 경로는 `no-board-sender` 로 거절한다. Paseo 처럼 서명 없는 프롬프트로 대신 보내지 않는다.

**알고리즘.** 마커를 찍는다 → outbox 를 확인한다(같은 id 에 다른 내용이면 거절, 이미 보냈으면 그 결과, 시도 중이거나 불확실하면 **대조만**) → 새 뷰로 안전 검사를 한다(blocked/waiting 에는 어떤 경로로도 보내지 않는다. 권한 프롬프트나 선택 TUI 에 글자가 들어가면 선택지를 누를 수 있다) → outbox 에 `attempting` 을 먼저 기록한다(임시 파일 후 rename) → 실행 → 결과를 매핑한다. Orca 가 "아무것도 안 보냈다"고 보장하는 오류 코드(`PRE_SEND_CODES`)만 `refused` 다. 나머지는 1.5초 뒤 대조한다. 대조 방법은 경로별로 다르다. 터미널은 `agent read --limit 100` 에서 같은 마커가 있고 앞부분이 일치하는 user 항목을 찾는다. 메일은 메일 id 가 있으면 확정이다.

**`--retry-request` 는 자동으로 쓰지 않는다.** Orca 는 이 id 를 오류 때 *알려 준다*(우리가 고르지 않는다). 오류 응답이 사라지면 쓸 수 없다. 그래서 기록만 해 두고, 진단용으로만 쓴다.

**steer.** Paseo 에서 실행 중 끼워 넣기는 claude/codex 코디네이터에게만 허용된다. 여기서는 `whenWorking:"queue-in-agent"` 로 옮긴다. Orca `terminal send` 는 실행 중인 에이전트에 붙여 넣은 프롬프트를 "accepted"와 "submitted"로 구분해 알려 준다. 이것을 대기열 입력으로 본다. 검토 문서는 "working 이면 거부"를 권했다. 이 후보는 다르게 판단한다.

**포커스 제한.** host `terminal.sendText` 는 쓰지 않는다. CLI 를 쓰고, 포커스 관련 오류가 오면 `needs-focus` 로 거절한다. 화면을 몰래 옮기지 않는다. 사용자가 "세션 열기"를 누른 뒤 같은 messageId 로 다시 보내면 된다(거절은 시도로 치지 않는다).

**길이.** 터미널 경로는 `--text` 인자로 가므로 30,000자를 넘으면 `too-long` 이다(Paseo 본문 24,000자 + 봉투는 들어간다). 메일 경로는 `--body-file` 이라 제한이 없다.

### 5. 이벤트로 큐 비우기 (`src/orca/signals.ts`)

`agent.status.changed` 와 30초 폴링이 **같은 순수 리듀서**로 들어간다. 그래서 둘이 "턴 끝"을 다르게 판단할 수 없다. turn-ended 는 working 에서 done/waiting 으로 바뀌는 전이인데, **working 을 실제로 본 적이 있을 때만** 낸다(launch 직후 첫 done 을 걸러 낸다). permission-cleared 는 blocked 에서 다른 상태로 바뀔 때이고, 250ms 뒤에 한 번 더 확인한다. gone 은 폴링 두 번 연속 없거나 워크스페이스가 삭제됐을 때다. worker.ts 가 신호를 Paseo 의 `resumeQueued`, 병합 알림 `resume`, `resumeReplies` 에 연결한다. 그 뒤 `board.changed` 신호만 post 한다(스냅샷은 프레임이 당겨 온다).

### 6. 코디네이터 채널 (`src/channel/*`)

- pipe 는 Windows 에서 `\\.\pipe\orca-coordinator-board-<sha256(pluginRoot)[0:12]>`, 그 밖에서는 `/tmp/…sock` 이다. 이름은 shim 위치에서도 계산할 수 있다. 그래서 env 가 없는 채팅도 절대 경로만 알면 연결할 수 있다.
- **hook** 은 순수하고 동기다. `CB_PIPE/CB_BIN/CB_NODE` 를 넣는다. PATH 는 `path.delimiter`(Windows `;`)로 앞에 붙이되, 기존 키를 대소문자 무시로 찾아("Path") 같은 이름으로 다시 쓴다. WSL/원격 실행에는 PATH 를 건드리지 않는다. launch 마커가 있으면 권한 인자를 붙인다.
- **호출자 신원.** hook 이 `CB_CALLER_TOKEN = HMAC(secret, terminalId)` 를 넣는다. secret 은 storage 에 한 번만 만들어 둔다. 검증은 다시 계산해서 비교하면 끝이라 launch 마다 저장할 것이 없다(*per* derive instead of sync). ensemble 은 env 자기 신고만 믿는다. 이 방식은 다른 터미널이 흉내 내기 어렵다. 코디네이터 명령은 토큰으로 검증된 터미널만 쓸 수 있다. 채팅은 "자기 신고"로만 받고, `report` 만 허용한다.
- **프로토콜.** NDJSON 이다. 첫 줄은 `ChannelRequest`. 그 뒤 워커가 `ExecFrame` 을 보내면 shim 이 자기 셸에서 `orca … --json` 을 실행하고 `ExecResultFrame` 으로 답한다. 마지막은 `ReplyFrame{exit}` 이다. 자유 텍스트는 argv 로 보내지 않는다(.cmd 가 `% ^ &` 를 다시 해석하기 때문). stdin 이나 파일로 받는다.
- **`AgentCall`** 은 서버 모듈만 만들 수 있는 타입이다. "코디네이터 명의로 보내기"는 코디네이터 자신의 명령을 처리하는 동안에만 할 수 있다. 이것을 타입이 보장한다.
- `.cmd` shim 은 `CB_NODE`(Orca Electron) + `ELECTRON_RUN_AS_NODE=1` 을 먼저 쓰고, 없으면 `node` 를 쓴다. sh shim 도 같이 둔다(Claude Code 의 Bash 는 Windows 에서도 Git Bash 다).

### 7. CLI 실행 층 (`src/orca/cli.ts`)

- 찾는 순서: `ORCA_CLI_COMMAND` → `ORCA_CLI_BIN_DIR/orca.exe` → `dirname(process.execPath)/resources/bin/orca.exe`. `orca.cmd` 는 셸 없이 실행할 수 없어서 쓰지 않는다. 실제 설치 폴더에 `orca.exe, orca.cmd` 가 둘 다 있다.
- env 는 허용 목록 방식이다. `APPDATA/LOCALAPPDATA/HOME` 는 `USERPROFILE` 에서 채운다. `ORCA_USER_DATA_PATH = %APPDATA%\orca`(관찰값). 에이전트 창 변수(`ORCA_TERMINAL_HANDLE` 등)는 **넣지 않는다**.
- 읽기와 쓰기를 타입으로 나눈다. `read()` 는 TTL 캐시, 진행 중 호출 공유, spawn 실패 시 1회 재시도를 한다. `write()` 는 캐시, 공유, 재시도를 하지 않는다. 결과는 `ok / failed(preSend) / ambiguous` 중 하나다. 동시 실행은 4개까지이고, 쓰기가 먼저다. 응답은 Orca 봉투(`{ok,result}`)를 zod 로 검사한 뒤 도메인 타입으로 바꾼다.
- **호출 예산.** CLI 한 번에 약 0.55초가 든다(관찰. 대부분 프로세스 시작 비용). 스냅샷마다 host 2회 + CLI 2회(병렬, 2초 공유)다. 대화 읽기는 `(id, updatedAt)` 캐시를 놓친 것만, 스냅샷당 최대 8개, 동시 3개까지 한다. 나머지는 백그라운드에서 채우고 `board.changed` 를 보낸다. 캐시가 차 있으면 CLI 2회, 처음이면 최악 10회다. 보내기는 새 뷰 1번(CLI 2회) + 대화 읽기 1회 + 쓰기 1회다.

### 관찰한 형태 (읽기 전용 명령, 개인 정보 제거)

- `agent list --json`: `{agents:[{orcaSessionId, kind:"terminal"|"chat", agent, state, worktreeId, workspace, repo?, hostId, paneKey, title, lastAssistantMessage, updatedAt}], truncated, hostScope:{hostIds:["local"], omittedHostIds:["runtime:<uuid>","runtime:wsl%3Aubuntu"], omittedHostSelectors:[{hostId, selector:"--environment <name>"}]}}`. 이 PC 에는 chat 25개(전부 done), terminal 9개가 있었다. 터미널 `worktreeId` 는 `<uuid>::C:/…/<repo>`, 채팅은 `folder:<uuid>` 였다.
- `terminal list --json`: `{terminals:[{handle:"term_<uuid>", ptyId:"<worktreeId>@@<8hex>", incarnationId, worktreeId, worktreePath, branch, tabId, leafId, title, connected, writable, lastOutputAt, preview, executionHostId, agentIdentity:"claude"|"codex"|없음}], hostScope, topologyRevisions, totalCount, truncated}`. **`tabId + ":" + leafId` 가 에이전트 행 `paneKey` 와 같다.** 이 세션 자신의 `ORCA_TERMINAL_HANDLE` 과 `paneKey` 로 확인했다. `agentIdentity` 는 에이전트 이름이지 세션 id 가 아니다(검토 문서가 기대한 조인 키가 아니다).
- `agent read <id> --limit n --json`: `{orcaSessionId, kind, agent, source:"transcript"|"chat", entries, limited, state}`. 긴 텍스트는 앞 약 1,200자 + `"\n… (truncated)"` 로 잘린다.
- `lastAssistantMessage`: 터미널은 마지막 메시지 전체(611~7,050자, 실제 끝까지), 채팅은 공백을 접은 앞 200자.
- `agent show <id> --json`: `{orcaSessionId, kind, places:[agent list 행]}`. `agent installed --json`: `{agents:[{id,name,default}]}`.
- `account list --json`: 에이전트별 `{accounts, activeAccountId, activeAccountIdsByRuntime?, systemDefault?}` + `rateLimits.<agent>.{session, weekly, fableWeekly?, monthly, extraUsage, updatedAt, error}`. 창 하나는 `{usedPercent, windowMinutes, resetsAt, resetDescription}` 이다.
- `host list --json`: `{hosts:[{kind:"local"|"ssh"|"environment", name, id, selector, machineName?, platform?, connected?}]}`.
- `status --json`: `{target, app, runtime{capabilities[]}, graph}`. 이 셸에서는 **`caller` 필드가 없었다.** 그래서 호출자 검증을 `orca status` 에 기대지 않았다.
- 모든 CLI 응답은 `{id, ok, result, _meta:{runtimeId}}` 봉투다. 한 번 호출에 약 0.52~0.58초 걸렸다.
- 설치 폴더 `resources/bin` 에는 `orca.exe, orca.cmd, orca-agent-hook.exe, journal-file-lock.exe` 가 있다. 에이전트 셸 env 에는 `ORCA_TERMINAL_HANDLE, ORCA_PANE_KEY, ORCA_TAB_ID, ORCA_WORKTREE_ID, ORCA_WORKSPACE_ID, ORCA_USER_DATA_PATH, ORCA_CLAUDE_CONFIG_DIR, ORCA_AGENT_HOOK_TOKEN` 등이 있다.

## Synthesis decision

*(arena 가 채운다.)*

## Tradeoffs accepted

- P/server 본문 변경 16개를 받아들이는 대신, Orca 가 지킬 수 없는 의미(steer, messageId, sourceAgentId, 전체 텍스트 해시)를 흉내 층이 조용히 바꾸는 일을 없앤다.
- outbox 가 Paseo 영수증과 별도로 "전송 사실"을 가진다. 상태가 둘로 보일 수 있다. 대신 재전송 금지를 한 곳에서 보장한다. 소유는 나뉜다. outbox 는 전송 사실만, 영수증은 업무 사실(fingerprint, version)만 가진다.
- host `agents.list` 를 쓰지 않는다. 그래서 `stateStartedAt` 은 이벤트에서만 얻는다(재시작 직후에는 없다). 대신 스냅샷이 워크스페이스 수와 상관없이 CLI 2회로 끝난다.
- 채팅의 긴 마지막 메시지는 끝을 볼 수 없다. 이 경우 질문 감지가 놓칠 수 있다는 점을 받아들인다(코디네이터 분류는 여전히 가능하다).
- steer 를 대기열 입력으로 근사한다. 코디네이터가 실행 중일 때 작업 요청이 바로 들어가지만, 반영되는 시점은 에이전트가 정한다.
- 보내기 전 새 뷰를 읽느라 보내기마다 약 0.6초가 더 든다. 대신 상태 판단 경로가 하나뿐이다.

## Alternatives considered

- **Paseo SDK 흉내(검토 문서 권고).** import 만 바꾸는 파일은 많아진다(약 19개). 대신 공개 면이 커진다. `agents.list({filter,sort,page})`, 커서 페이지, `pendingPermissions`, `timeline.refetch` 의 seq/epoch 를 모두 꾸며야 한다. 꾸민 필드가 틀린 동작을 컴파일되게 만든다. 예를 들어 1,200자 잘림 때문에 해시 대조가 항상 실패하고, steer 가 큐잉으로 바뀌는데 호출부는 모른다. 얕은 모듈과 정보 누설에 해당해서 탈락시켰다.
- **host API 중심**(워크스페이스마다 `agents.list` + `terminal.read` + `terminal.sendText`). CLI 가 필요 없다. 하지만 대화가 아니라 화면을 읽는다. 채팅은 읽지도 보내지도 못한다. 포커스도 바꿔야 한다. Paseo 질문 감지와 evidence 를 맞출 수 없어서 탈락시켰다.
- **모든 전송을 메일로**(`orchestration send` 하나). 경로가 하나라 단순하고 메일 id 로 확정할 수 있다. 하지만 사람 답장이 user 턴이 아니라 메일이 된다. 터미널 에이전트에서 메일이 대화에 어떻게 들어가는지도 확인되지 않았다. Paseo 동작과 달라서, 사람 답장은 터미널 입력으로 남겼다.

## Open questions and risks

- R1. 워커 env 에서 `orca.exe` 가 런타임을 찾는가(`ORCA_USER_DATA_PATH` 만으로 충분한가)? 첫 단계에서 `agent list` 하나로 확인해야 하지 않을까?
- R2. CLI `terminal send` 도 포커스된 워크스페이스로 제한되는가? 제한된다면 `needs-focus` 로 거절하는 지금 방식이 괜찮은가, 아니면 Paseo 와 다르더라도 자동으로 포커스를 옮길 것인가?
- R3. 채팅의 긴 마지막 메시지 끝을 읽을 다른 경로(채팅 저장 파일, `orca search`)가 있는가?
- R4. 메일이 채팅이나 터미널 전사에 어떤 모양으로 들어가는가? 마커가 남는가? 남지 않으면 채팅 수신자의 "응답 표시(replies)"는 비게 된다.
- R5. `agent.launch.before` 의 `event.env` 에 PATH 가 들어 있는가? 없다면 워커의 PATH 로 대체한다. 그러면 사용자 셸 PATH 가 덮이지 않는가? 그래서 charter 에 shim 의 절대 경로를 함께 넣기로 했는데, 이것으로 충분한가?
- R6. 실행 중인 Claude/Codex 터미널에 붙여 넣은 입력이 정말 "대기열 입력"으로 처리되는가? 아니면 진행 중인 턴을 끊는가?
- R7. `--worktree` 선택자 문법(`path:…` 또는 `id:…`)과 `PRE_SEND_CODES` 의 실제 코드 값은 Phase D 에서 확인해야 한다.
- R8. 보드 메일함 터미널은 어느 워크스페이스에 둘 것인가? 코디네이터 워크스페이스에 둘 경우, 그 워크스페이스가 닫히면 병합 알림이 `unavailable` 이 되는데 그대로 둘 것인가?
- R9. 세션이 복원되면(hook 을 거치지 않으면) 코디네이터 토큰이 없다. 이때 "채널 끊김"을 보여 주고 다시 실행하게 하는 방식이면 되는가?

## Next implementation step

`src/orca/view.ts` 의 `buildView` 와 `workspaceKey` 를 관찰한 JSON 고정값으로 단위 테스트하며 먼저 만든다. 그 위에 `discovery.laneFacts` 를 올려 `board.snapshot` 이 평문 질문 세션을 `lane:"human"` 으로 내는지 확인한다.
