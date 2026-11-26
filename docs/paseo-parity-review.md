# Paseo 코디네이터 보드와 같은 동작을 위한 검토 (2026-11-26)

인용 표기는 다음과 같다.
- `P/` = [paseo-coordinator-board](https://github.com/devbrother2024/paseo-coordinator-board) 저장소 루트
- `CB/` = 이 저장소 루트 (`orca-coordinator-board`, 검토 당시 v0.1.0)
- `T/` = `CB/.orca/types/` (Orca host API 1.10 타입)
- `E/` = [orca-ensemble](https://github.com/DueGin/orca-ensemble) 저장소 루트
- `AC:n` = Orca 1.4.277 의 `orca agent-context --json` 출력에서 n번째 줄
- `orca/` = stablyai/orca 저장소 소스

`orca-ensemble` 은 이번 포트가 아니다. 다른 저자의 Orca 플러그인(에이전트 팀)이다. 다만 이 플러그인이 쓰는 방식, 즉 에이전트 PATH 에 CLI 를 심고 IPC 로 워커와 통신하는 방식은 Paseo 의 MCP 도구를 대신할 현실적인 경로다. 그래서 이 문서에서 자주 참조한다.

---

## 1. 개요

Paseo 보드는 코디네이터를 중심에 둔 결정 보드다. 세션 대화를 직접 읽고 마지막 assistant 턴에서 질문을 찾는다(`P/server/conversation.ts:20-21,76-96`). 코디네이터는 MCP 도구로 대화를 분류하고 작업자를 배정한다(`P/server/coordinator.ts:19-79`). 결정 카드에는 버전이 붙고, 영수증은 pending 에서 sent 로 넘어간다. 결정 장부(tracked ledger), PR 병합, 모델 배정과 사용량 라우팅도 있다. 현재 Orca 포트 v0.1.0 은 상태 모니터에 가깝다. Orca 가 알려 주는 `blocked`/`waiting` 상태를 카드로 만든다. `ready` PR 은 검토 카드로 보여 주고, 답장은 터미널에 타이핑해 넣는다(`CB/src/model.ts:189-213`, `CB/src/worker.ts:284-335`). 코디네이터, 대화 읽기, 장부, 병합, 라우팅은 없다.

가장 큰 의미 차이는 "무엇이 결정인가"다. Paseo 카드의 주 출처는 idle 세션의 마지막 assistant 턴에 남은 평문 질문이다. Orca 에서는 이런 세션이 `done` 상태가 된다(`CB/README.md:82`). 그런데 포트는 `done` 을 카드로 만들지 않는다(`CB/src/model.ts:197-198`). 그래서 Paseo 에서 보이던 결정 대부분이 포트에는 아예 나타나지 않는다.

결론부터 말하면, 같은 동작은 대부분 만들 수 있다. 레인, 질문 감지, 결정 버전, 우선순위와 그룹, 전송 가드와 영수증, 추가 질문, 메모, 결정 장부와 큐, PR 병합, 사용량 라우팅은 Paseo 코드 밑에 Orca 어댑터를 깔면 거의 그대로 옮길 수 있다. 코디네이터 도구는 ensemble 식 shim CLI 로 대신해야 하고, Windows 문제를 먼저 고쳐야 한다. 맞출 수 없는 부분도 있다. 워크스페이스 고정(pin), 채팅의 권한 모드 지정, 모델과 모드 카탈로그 조회, 메시지 안의 이미지 첨부, 진짜 `sourceAgentId`/`messageId` 가 그렇다. 이 중 출처 표시와 메시지 id 는 메일 발신자와 본문 표식으로 근사할 수 있다. 화면은 custom editor 프레임에서 React 로 만들면 네 가지 보기를 모두 재현할 수 있다. components 패널로는 불가능하다(5.h 참고).

---

## 2. 핵심 개념

| 개념 | 정의 | Paseo 근거 | Orca 판에서 둘 곳 |
|---|---|---|---|
| 세션 행 + 레인 | 에이전트 1개를 보드에 올린 행. 레인은 `human/running/review/idle/unknown` 다섯 가지다 | `P/shared/contract.ts:15-38`, `P/server/discovery.ts:29-51` | 어댑터가 `orca agent list` 와 `agents.list` 를 합쳐 만든다. id 는 `orcaSessionId` |
| 대화 발췌(evidence) | 마지막 4턴과 그 해시(`evidenceId`, 24 hex). 판단이 "어느 대화를 보고 내렸나"를 고정한다 | `P/server/conversation.ts:26,65-69` | `orca agent read --json` 항목에서 계산 |
| 판단(judgment) | 코디네이터가 evidence 하나에 붙인 분류 `question/review/idle` 와 구조화된 내용 | `P/server/preferences.ts:13-16,34` | 플러그인 저장소 `scope.json` |
| 결정 카드 + 버전 | 사람이 답할 질문. 출처는 permission, conversation, coordinator, agent-note, person-note 다섯 가지다. 버전은 sha256([project, id, permissionVersion 또는 evidenceId, note revision, content]) | `P/server/decisions.ts:23-57` | 그대로 이식 |
| 영수증(receipt) | 보내기 전에 `pending` 으로 쓰고 전송 뒤 `sent` 로 바꾸는 기록. 불확실하면 다시 보내지 않고 대조만 한다 | `P/server/preferences.ts:45-51`, `P/server/decisions.ts:122-141` | 이식. 대조 수단만 바꾼다(5.c) |
| 장부 결정(tracked decision) | 운영자가 준 `tracked-decisions.json` 과 외부 장부에서 읽은 결정 레코드. 수신자, 큐, 사진을 가진다 | `P/shared/tracked-decisions.ts:16-31`, `P/server/tracked-decisions.ts:84-115` | 파일 기반이라 그대로 이식 |
| 추가 질문(clarification) | 결정 전에 원 세션이나 코디네이터에게 설명을 묻는 메시지. 대기 중에는 원래 질문을 계속 답할 수 있게 둔다 | `P/shared/clarifications.ts:36-45,104-174` | 이식 |
| 보드 사실(board fact) | "이 프로젝트 관리돼?" 같은 사실 질문에 서버가 만든 정보성 답. 코디네이터 명의로 보낸다 | `P/server/board-facts.ts:24-63,185-227` | 이식. 발신은 코디네이터 셸에서 메일로 한다 |
| 병합 바우처(merge voucher) | 병합 미리보기 때 발급하는 5분짜리 토큰. head, base, 검사 결과의 지문을 묶는다. 확정 때 `expectedHeadOid` 로 병합한다 | `P/server/pr-merge.ts:249-264,331-343,346-435` | `gh` 만 쓰므로 그대로 이식 |
| 코디네이터 | 보드가 지정하거나 만든 운영 세션. MCP 도구를 받고 다이제스트와 작업 요청을 받는다 | `P/server/lifecycle.ts:93-173`, `P/server/coordinator.ts:74-79` | `orca agent launch --surface terminal` + shim CLI |

---

## 3. 비즈니스 로직 비교표

### 3.1 기능별 비교

| 기능 | Paseo 동작 | 현재 Orca 포트 | 차이 |
|---|---|---|---|
| 세션 수집 | `agents.list` 와 `workspaces.list` 를 100개씩 넘겨 읽는다. 보관됨, internal, 사라진 워크스페이스는 뺀다(`P/server/discovery.ts:65-86`) | `workspace.list` 최대 60개, 워크스페이스마다 `agents.list` 를 동시 4개로 읽는다(`CB/src/worker.ts:39,177-222`) | 60개를 넘으면 `truncated` 가 된다. 프로젝트 fallback 규칙과 `unassigned` 처리가 없다 |
| 레인 분류 | 권한 대기 → human. error → review. running → running. finished/requiresAttention → review. idle/closed → idle (`P/server/discovery.ts:29-51`) | 레인 없음. Orca 상태 4개(working/blocked/waiting/done)를 그대로 쓴다(`CB/src/model.ts:3`) | review 레인(오류, 결과 확인 필요)이 없다. done 이 idle 과 review 로 나뉘지 않는다 |
| 대화 발췌 | idle/error 일 때 tail 48개를 읽어 마지막 4턴을 남긴다. 60초 캐시를 쓰고 closed 는 다시 읽지 않는다(`P/server/conversation.ts:125-145`) | `terminal.read` 60줄 화면 꼬리만 읽는다(`CB/src/worker.ts:212-220`) | 대화가 아니라 화면이다. 채팅은 아예 못 읽는다. evidenceId 가 없다 |
| 질문 감지 | 마지막 assistant 턴을 아래에서 위로 훑는다. 코드 블록, 인용, 선택 제안은 건너뛰고 한국어/영어 요청 정규식으로 찾는다(`P/server/conversation.ts:20-21,76-96`) | 없음. Orca 의 `waiting` 상태(도구 기반 질문)에만 기댄다(`CB/README.md:82`) | 평문 질문 대부분을 놓친다 |
| 판단 우선 적용 | 현재 evidence 와 맞는 judgment 가 있으면 그 판단이 레인을 정한다. 없으면 질문 감지 결과를 쓴다(`P/server/conversation.ts:103-122`) | 없음 | 코디네이터 분류 자체가 없다 |
| 결정 출처와 버전 | permission > conversation/coordinator > note 순서다. 버전이 같으면 `decisionAnswered` 로 review 로 보낸다(`P/server/decisions.ts:23-57`) | 키는 `terminalId@stateStartedAt` 다. 상태가 바뀌면 새 카드가 된다(`CB/src/model.ts:173`) | 답했는지를 버전이 아니라 수동 dismiss 로 관리한다 |
| 우선순위 | 사유 순위 overdue=now 0, permission=reply=blocker 1, today 2, week 3, scheduled 4, undated 5. 그다음 대기 시작이 오래된 순, 그다음 key 순(`P/shared/decision-priority.ts:4,25-46`) | permission 0 < reply 1 < review 2, 그다음 since 오름차순(`CB/src/model.ts:187,212`) | 기한, blocker, 장부가 없다. PR 은 Paseo 에서 undated(5)이고 포트에서는 2다 |
| 그룹 | now, waiting, merge, later, handled 다섯 묶음(`P/client/decision-row.ts:6-37`, `P/client/inbox.ts:20-30`) | 없음. 카드 목록 하나뿐이다 | 화면 구조부터 다르다 |
| 전송 가드 | idle, 권한 대기 아님, 새 발췌, `updatedAt` 불변, 트랜잭션 안에서 버전 재확인을 거친 뒤 pending 영수증을 쓴다(`P/server/decisions.ts:143-176`) | `replyGuard`. 빈 글, 8000자 초과, 사라짐, blocked, working, `stateStartedAt` 변경을 본다(`CB/src/model.ts:273-283`) | 버전 재확인이 없고 pending 영수증도 없다 |
| 영수증과 재시도 금지 | 메시지 id 를 결정적으로 만들고, 불확실하면 타임라인에서 같은 id 와 해시를 찾아 대조만 한다(`P/server/decisions.ts:64-67,122-141`) | 보낸 뒤에 `ReplyRecord` 를 남긴다(최대 50개). 재시도는 안 한다(`CB/src/worker.ts:300-335`) | 보내기 전 기록이 없어 결과 대조가 불가능하다 |
| 메시지 봉투 | `[Coordinator Board · 프로젝트 · 카드]` 다음 줄에 JSON 문맥을 붙이고 그 뒤에 답을 쓴다(`P/server/decision-message.ts:23-26,51-59`) | 사람이 쓴 글을 그대로 타이핑한다 | 수신 에이전트가 출처와 카드를 알 수 없다 |
| 추천 요청 | 코디네이터에게 고정 프롬프트를 보내 "이 카드만 읽고 분류하라"고 한다(`P/server/recommendation.ts:5-21`) | 없음 | |
| 추가 질문 | 카드 종류별로 수신자를 정한다. 대기 중에는 원래 질문을 복원한다(`P/shared/clarifications.ts:104-174`, `P/server/clarifications.ts:62-100,210-301`) | 없음 | |
| 메모와 보고 | `board.save-note` 는 revision 으로 낙관적 동시성을 지킨다. `report_to_board` 도구는 metadata 가 켜진 세션에만 준다(`P/server/notes.ts:31-52`, `P/server/reporting.ts:11-40`) | 없음. "Mark reviewed" 로 숨기기만 한다(`CB/src/worker.ts:399-406`) | |
| 코디네이터 도구 | MCP 6종(read, classify, plan, assign, fact, review)을 매 호출마다 호출자 검증하며 제공한다(`P/server/coordinator.ts:8-79`) | 없음. 플러그인은 MCP 를 줄 수 없다(`CB/README.md:72`) | 5.a 의 shim 이 필요하다 |
| 코디네이터 생성·지정·교체·고정 | 경로 확인, 허용 모드, idempotencyKey, 메타데이터 재채택, 자동 고정을 한다(`P/server/lifecycle.ts:83-173`) | 없음 | 고정은 Orca 에서도 불가 |
| 모델 라우팅과 배정 | 등급 A~D, M 별 후보, 사용량 기반 `preferCapacity`, `dispatchWorker`(`P/shared/dispatch.ts:55-129`, `P/server/dispatch.ts:153-227`) | 없음 | |
| 다이제스트와 작업 요청 | 코디네이터에게 결정적 메시지 id 로 보낸다. 실행 중인 claude/codex 코디네이터에게는 steer 로 끼워 넣는다(`P/server/digest.ts:23-66`) | 없음 | |
| 보드 사실 | 단일 줄 사실 질문을 서버가 검증한다. 코디네이터 명의로 `sourceAgentId` 를 달아 보낸다(`P/server/board-facts.ts:24-60,185-227`) | 없음 | |
| 결정 장부와 큐 | 파일 장부, 외부 장부, 수신자 해석, 큐 드레인(hook 4종 + 스냅샷마다), 취소, 사진(`P/server/tracked-decisions.ts:84-435`) | 없음 | |
| PR 목록과 분류 | `gh pr list` 를 9단계로 분류한다. ready 는 review 레인(`P/server/prs.ts:33-46`) | 같은 9단계 분류(`CB/src/github.ts:70-81`) | 분류 로직은 이미 같다. 저장소 매핑 auto/manual/off 가 없다 |
| PR 병합 | 미리보기, 바우처, `mergePullRequest(expectedHeadOid)`, 변이는 한 번만, 실패 시 재조회(`P/server/pr-merge.ts:158-435`) | 없음. GitHub 링크만 연다 | |
| 병합 알림 | 장부 소유자나 코디네이터에게 `sourceAgentId:"plugin:coordinator-board"` 로 보낸다. 바쁘면 queued 로 두고 hook 이 재개한다(`P/server/merge-notifications.ts:39-121`) | 없음 | |
| 세션 연결 | 다른 프로젝트 세션을 이 프로젝트로 묶는다(`P/server/session-links.ts:9-85`) | 없음 | |
| 사진 | PNG/JPEG/WebP 최대 4장, 장당 5 MiB, 합계 12 MiB. 메시지에 이미지로 첨부한다(`P/shared/work-images.ts:3-21`) | 없음 | Orca 는 근사만 가능 |
| 프로젝트 아이콘 | 업로드 아이콘이나 favicon 을 찾고, 없으면 첫 글자(`P/server/project-icons.ts`) | 없음 | |
| 호스트와 원격 세션 | 호스트별 표시 설정, 30초마다 다른 호스트의 running 세션을 읽는다(`P/client/remote-running.tsx:12-45`) | 원격 호스트는 PR 상태만 `remote` 로 표시한다(`CB/src/worker.ts:150-164`) | |
| 상태 표시 수 | 사이드바 배지 = 장부 + 장부가 덮지 않은 human 세션 + 장부가 덮지 않은 review PR (`P/shared/decision-count.ts:22-28`) | 상태 표시줄 `N waiting` = permission + reply. PR 은 빠진다(`CB/src/summary.ts:19-35`) | 세는 방식이 다르다 |
| 다국어 | 보드 자체 언어 설정, 기본값 ko (`P/client/language.tsx:10-13`) | Orca locale 을 따른다(`CB/src/i18n.ts:4-6`) | 설정 위치가 다르다 |
| 저장 | `scope.json`, `notes.json`, 장부 영수증, 사진 폴더. 임시 파일에 쓰고 rename, 권한 0600 (`P/server/preferences.ts:84-93`) | storage 키 4개(`CB/src/worker.ts:32-35`) | |
| 닫힌 세션 재개 | 없음 | `agent.resume` 뒤 화면이 안정되면 타이핑한다(`CB/src/worker.ts:352-388`) | 포트에만 있는 기능이다. 유지 여부를 정해야 한다 |

### 3.2 빠진 것이 아니라 의미가 다른 부분

1. **결정의 정의.** Paseo 는 "idle 상태에서 마지막 턴이 질문"이면 결정이다. 포트는 Orca 의 `waiting` 이면 결정이다. Orca 에서 `waiting` 은 `AskUserQuestion` 같은 도구 기반 질문일 때만 생긴다(`CB/README.md:82`). 그래서 포트의 reply 카드는 대부분 TUI 선택 화면이 떠 있는 상태다. 그 상태에서 자유 텍스트를 타이핑해 넣는 동작은 선택지를 잘못 고를 위험이 있다(추정).
2. **done 과 waiting.** Paseo 의 idle 은 "질문이 있으면 human, 없으면 idle"로 나뉜다. 포트는 done 을 진행 목록에만 넣는다(`CB/src/model.ts:198`).
3. **채팅 탭.** Paseo 는 모든 에이전트에게 같은 방식으로 보낸다. 포트는 터미널 id 가 없는 채팅에 카드는 띄우지만 입력은 막는다(`CB/src/panel.tsx:150-175`). 실제로는 `orca orchestration send --to orca_session_id:` 로 채팅에도 보낼 수 있다(`AC:7278`, `E/src/worker/adapter.ts:373-426`).
4. **답한 카드의 처리.** Paseo 는 `answers[sessionId].version` 이 같으면 review 로 옮긴다. 포트는 사람이 dismiss 하거나 상태가 바뀌어 키가 달라질 때까지 남긴다.
5. **정렬 순위.** 포트는 PR 이 세션 바로 뒤(2)에 온다. Paseo 는 PR 이 항상 undated(5)라서 기한 있는 장부 결정보다 뒤에 온다.
6. **답장 길이.** Paseo 는 24000자, 포트는 8000자다(`CB/src/model.ts:95`).
7. **이벤트 위치.** Paseo 는 서버 hook 으로 큐를 비운다. 포트는 워커에 events 계약이 없어 30초 폴링만 한다(`CB/orca-plugin.json:13-49`). 이벤트는 패널 쪽에서만 구독한다.

---

## 4. Paseo 기본 요소와 Orca 대응

| Paseo 기본 요소 | Orca 대응 | 충실도 | 한계 |
|---|---|---|---|
| `agents.list` (status, activeTurn, pendingPermissions, attentionReason, lastError, requiresAttention, updatedAt, metadata) | `orca agent list --json`: orcaSessionId, kind, state, lastAssistantMessage, updatedAt, paneKey, hostId (`AC:292`). 여기에 host `agents.list{workspaceId}`(terminalId, stateStartedAt, sessionId) 와 `workspace.list{includeStatus}`(unread) 를 합친다 | 근사 | `pendingPermissions` 내용이 없고 `blocked` 하나뿐이다. CLI 행에는 터미널 핸들이 없어 `terminal list` 의 `agentIdentity` 로 붙여야 한다(검증 필요). 터미널 에이전트는 `/clear` 하면 id 가 바뀐다 |
| `workspaces.list` / `projects.list` | host `workspace.list`, `project.list` (`T/orca-host/index.d.ts:165,171`) | 동일에 가까움 | 커스텀 아이콘 revision 이 없다. 워크스페이스 id 형식이 세 가지다 |
| `timeline.refetch(tail, 48/128)` | `orca agent read <id> --limit ≤100 --json` (`AC:324`) | 근사 | cursor, seq, epoch, messageId 가 없다. 최신 100개까지만 읽는다 |
| `send(text,{messageId})` | 사람 답장은 `orca terminal send --terminal --text --enter --wait-submit --retry-request` (`AC:11399`). 채팅은 `orchestration send` | 근사 | messageId 를 보낼 수 없다. 본문 표식으로 대조한다 |
| `activeTurnBehavior:"steer"` | 없음. 바쁜 채팅은 턴이 끝날 때 메일을 받는다(`E/src/worker/adapter.ts:5-7`) | 불가 | 실행 중인 코디네이터에 끼워 넣기 불가. 대기열로 바꾼다 |
| `images` | 없음. 플러그인 데이터 폴더에 파일로 저장하고 본문에 절대 경로를 넣는다(추정) | 근사 | Claude 는 경로로 이미지를 읽을 수 있다. 다른 에이전트는 보장이 없다 |
| `sourceAgentId` | `orca orchestration send --from <handle>`. 발신자가 기록된다(`AC:7278`, `AC:7045`). 코디네이터 명의 발신은 코디네이터 셸에서 실행한다(ensemble protocol 2, `E/src/worker/main.ts:236-259`) | 근사 | 터미널 직접 입력에는 출처가 없다. hook 에는 `inputKind` 만 온다(`T/orca-host/index.d.ts:326`) |
| `setMetadata` | 플러그인 저장소에 orcaSessionId 기준으로 둔다 | 근사 | 에이전트 쪽에서는 보이지 않는다 |
| `defineAgentTool` + `agent.open.before` | `agent.launch.before` 가 PATH 와 env 에 shim CLI 를 넣고, named pipe IPC 로 워커에 연결한다(5.a) | 근사 | 채팅에는 launch hook 이 없다. 호출자 신원은 자기 신고다 |
| `workspace.agents.create({idempotencyKey, parent, mode, systemPrompt})` | `orca agent launch --agent --worktree --model --effort --surface terminal --prompt --json` (`AC:253`). 권한은 `agent.launch.before` 에서 명령줄을 고친다 | 근사 | idempotency 는 `--retry-launch <opId>` 뿐이다. parent 는 플러그인 저장소에 둔다. systemPrompt 는 Claude 의 `--append-system-prompt` 나 첫 프롬프트로 대신한다 |
| `providers.listAvailable/snapshot` | `orca agent installed` (`AC:292` 주석) | 근사 | |
| `providers.listModels/listModes` | 없음. 정적 목록과 사용자 입력으로 대신한다(ensemble 의 `MODEL_SUGGESTIONS` 방식) | 불가 | 잘못된 모델은 실행 시점 거절로만 알 수 있다(`E/src/worker/adapter.ts:47-51`) |
| `providers.listUsage` | `orca account list --json` → `rateLimits.<agent>.{session,weekly}.usedPercent/resetsAt` (`AC:48`) | 근사 | 로컬 전용. 스키마가 문서화되지 않았다 |
| `setPinned` | 없음. `worktree ps` 의 `isPinned` 는 읽기 전용이다 | 불가 | |
| hook `agent.turn.after` | event `agent.status.changed` 에서 working → done/waiting 전이와 `mainAgent.outcome` 을 본다(`T/orca-host/index.d.ts:313-314`) | 근사 | 채팅은 paneKey 만 온다. 30초 순회로 보완한다 |
| hook `agent.permission.after` | 같은 이벤트의 blocked → 다른 상태 전이 | 근사 | |
| hook `agent.close.after` / `archive.after` | `workspace.removed` 와, `agent list` 에서 사라진 행 | 근사 | 개별 탭 닫힘 이벤트는 없다 |
| `defineSettings` (device) | `contributes.settings` 또는 `storage` | 동일 | |
| `getPaseoClient(serverId)` | `orca agent list --environment <name> --json`, `orca host list` (`AC:4834`) | 근사 | 페어링된 서버마다 호출해야 한다. 계정과 세션 기록은 로컬 전용이다 |
| `execCommand(gh/git)` | 워커의 `child_process.execFile`, 현재 포트의 `commandEnv` (`CB/src/github.ts:27-36`) | 동일 | |

---

## 5. 똑같이 만들기 위한 설계 권고

### 5.a 코디네이터 보고 채널

Paseo 의 MCP 도구 7종(`read_board_conversation`, `classify_board_conversation`, `plan_board_assignment`, `assign_board_worker`, `answer_board_fact`, `review_board_records`, `report_to_board`)은 모두 동기 호출이다. 결과를 바로 돌려줘야 한다. 그런데 Orca 플러그인은 `mcpServers` 와 `skills` 를 기여할 수 없다(`ORCA/shared/plugins/.../plugin-contribution-points.js:39-46`).

| 방식 | 장점 | 단점 |
|---|---|---|
| (a) shim CLI + IPC (ensemble 방식) | 셸이 있는 모든 에이전트에서 동작한다. 동기 응답이 된다. 워커가 zod 로 입력을 검증한다(`E/src/worker/collab.ts:1973-2025`). protocol 2 를 쓰면 호출자 셸에서 `orca` 명령을 돌려 Orca 가 "에이전트가 한 일"로 기록한다(`E/src/worker/caller.ts:1-5`) | Windows 에서 그대로는 동작하지 않는다(7장). 채팅에는 PATH 를 넣을 수 없다 |
| (b) Orca 메일을 플러그인 메일함으로 | 오래 남고 재시도 id 가 있다(`AC:7278`) | 비동기라 read/classify 결과를 돌려줄 수 없다. 워커가 `inbox` 를 폴링해야 한다. `check` 는 메일을 소비한다(`AC:6785`) |
| (c) `agent.tool.before` 감시 | 설치할 것이 없다 | Claude 터미널만 된다. SSH/WSL 은 안 된다. 2초 안에 답해야 한다. 결과를 `{deny}` 로 돌려주는 편법이다(`T/orca-host/index.d.ts:335`) |
| (d) Claude 실행에 `--mcp-config` 주입 | 진짜 MCP 도구가 된다. Paseo 와 가장 비슷하다 | 검증되지 않았다(추정). Claude 터미널만 된다. Windows 셸 인용 문제가 있다. MCP 서버는 결국 같은 IPC 로 워커와 이야기해야 한다 |

**권고는 (a)를 기본으로 두는 것이다.** (d)는 같은 pipe 백엔드 위에 나중에 붙이는 선택지로 남긴다. 구체적인 형태는 다음과 같다.
- CLI 이름은 `coordinator-board` 로 하고 하위 명령은 `read [--session]`, `classify --session --evidence --kind --text`, `plan`, `assign --job-file`, `fact --cycle --session --evidence`, `review [--key --fingerprint --evidence --quote-file]`, `report --kind --text` 로 둔다. 하위 명령 하나가 Paseo 도구 하나에 대응한다. 워커 쪽 구현은 Paseo `server/coordinator.ts`, `operations.ts:170-236`, `board-facts.ts`, `tracked-review.ts`, `reporting.ts` 의 `execute` 본문을 그대로 쓴다.
- `agent.launch.before` 는 **모든** 에이전트 실행에 env 와 PATH 만 추가한다. 명령줄은 고치지 않는다. 권한 검사는 워커가 호출자 신원으로 한다. Paseo 도 매 호출마다 호출자를 다시 검증한다(`P/server/coordinator.ts:8-16`). hook 은 2초 제한이 있으므로 CLI 를 띄우지 않는 순수 함수로 짠다(`T/orca-worker/index.d.ts:98-104`).
- **Windows 대응**
  - pipe 는 `\\.\pipe\orca-coordinator-board-<sha256(pluginRoot)[0:12]>` 로 하고, 다른 OS 에서는 Unix 소켓을 쓴다. ensemble 의 `/tmp/...sock`(`E/src/shared/paths.ts:13-15`)은 Windows 에서 `listen` 이 실패한다.
  - PATH 는 `path.delimiter`(Windows 는 `;`)로 잇는다. ensemble 은 `:` 로 고정돼 있다(`E/src/worker/hooks.ts:126`).
  - `bin/coordinator-board.cmd` 를 두고 `"%CB_NODE%"` 로 번들된 `cli.cjs` 를 `ELECTRON_RUN_AS_NODE=1` 과 함께 실행한다. sh 스크립트도 같이 둔다.
  - `orca.exe` 찾는 순서는 `ORCA_CLI_COMMAND`, 그다음 `ORCA_CLI_BIN_DIR`, 그다음 `process.execPath` 옆의 `resources/bin/orca.exe` 다. 워커에서 실행할 때는 `ORCA_USER_DATA_PATH` 와 `APPDATA` 를 채운다. 워커 env 에 `APPDATA`/`HOME` 이 없기 때문이다(`CB/README.md:85`).
- **채팅.** launch hook 이 없으므로 pipe 이름을 env 없이도 계산할 수 있게 고정 해시로 만든다. 첫 프롬프트에는 CLI 의 절대 경로를 넣는다(ensemble `chatNote`, `E/src/shared/prompt.ts:308-312`). 그래도 **코디네이터는 항상 `--surface terminal` 로 띄운다.** 그래야 PATH, 권한 인자, 시스템 프롬프트를 모두 넣을 수 있다.
- **호출자 신원.** `ORCA_TERMINAL_HANDLE` 을 쓰고, 없으면 `structured-agent-session-${ORCA_AGENT_SESSION_ID}` 를 쓴다(`E/src/shared/agents.ts:51-55`). 이 값은 자기 신고라서 위조할 수 있다. 보강책으로 protocol 2 exec 를 써서 호출자 셸에서 `orca status --json` 을 실행하고 `caller.orcaSessionId` 와 맞춰 본다(`AC:10740`). 이 방식으로 위조가 어려워지는 정도는 추정이다.

### 5.b 대화 읽기 (evidence)

- 기본 경로는 `orca agent read orca_session_id:<id> --limit 48 --json` 이다. 결과 `entries[{kind, role, text}]` 를 Paseo `excerpt()` 입력 형태로 바꾸는 얇은 변환 함수만 쓰고, `excerpt`, 질문 정규식, `classify` 는 그대로 쓴다(`P/server/conversation.ts:20-122`). 채팅도 `source:"chat"` 으로 읽힌다(`AC:324`).
- 결과 맨 앞의 `state:"working"` 은 미완료 턴이다. 이때는 Paseo 가 gap 에서 하듯 발췌를 거부한다. state 가 없으면 "알 수 없음"으로 본다(`AC:324` 주석).
- **evidenceId 의 안정성.** Paseo 는 epoch 와 `seqEnd` 를 해시에 넣는다. Orca 에는 둘 다 없다. 대신 "최근 4개 user/assistant 텍스트 + 그 뒤 tool 입력 + 마지막 항목 인덱스 거리"를 해시한다. 같은 대화에 새 항목이 없으면 id 가 바뀌지 않는다. 같은 문장이 반복되는 드문 경우에는 충돌할 수 있다(추정).
- **비용 줄이기.** `orca agent list --json` 의 `lastAssistantMessage` 로 먼저 질문 후보를 거른다. `agent read` 는 후보와 판단 대상에만 쓴다. 캐시는 `updatedAt` 을 키로 60초 둔다. Paseo 의 `activityAt` 캐시(`P/server/conversation.ts:125-145`)와 같은 방식이다.
- **보조 경로.** 오케스트레이션 작업자는 `orchestration worker-read --source transcript --cursor` (`AC:7517`)로 읽는다. Claude 의 `stop_reason` 이 필요하면 `${ORCA_CLAUDE_CONFIG_DIR || ~/.claude}/projects/<cwd 변환>/<sessionId>.jsonl` 을 직접 읽는다. ensemble 은 `ORCA_CLAUDE_CONFIG_DIR` 을 무시해서 Orca 가 관리하는 계정에서는 경로가 틀린다(`E/src/worker/transcripts.ts:9-13`). `terminal.read` 는 화면이라 evidence 로 쓰지 않는다.

### 5.c 전송, 출처, 전달 확인

| 보내는 것 | Orca 수단 | 출처 표시 |
|---|---|---|
| 사람이 쓴 답장, 추가 질문, 장부 답, 작업 요청 (터미널 에이전트) | 워커가 `orca terminal send --terminal <h> --text <봉투> --enter --wait-submit 10 --json` 실행 | Paseo 처럼 봉투 머리말만 붙인다 |
| 같은 종류, 채팅 | `orca orchestration send --to orca_session_id:<id> --from <플러그인 터미널> --type question --subject --body-file` | 메일 발신자 |
| 보드 사실 (Paseo 는 `sourceAgentId`=코디네이터) | `coordinator-board fact` 처리 중 protocol 2 로 **코디네이터 셸에서** `orchestration send` 실행 | 발신자가 코디네이터로 기록된다 |
| 병합 알림 (Paseo 는 `plugin:coordinator-board`) | 플러그인 전용 조용한 터미널을 `--from` 으로 쓴다(ensemble "Ensemble" 발신자, `E/src/worker/adapter.ts:373-388`) | 발신자가 보드로 기록된다 |

- **messageId 대조.** Paseo 의 결정적 UUID 는 그대로 만든다. 봉투 JSON 문맥에 `messageId` 를 넣는다(`P/server/decision-message.ts:51-59` 의 필드에 하나 추가). pending 영수증에 `messageHash` 와 `retryRequestId` 를 함께 저장한다. 결과가 불확실하면 `agent read --limit 100` 의 user 항목에서 같은 messageId 와 본문 해시를 찾는다. 찾으면 sent 로 바꾸고, 못 찾으면 unconfirmed 로 남긴다. 절대 새로 보내지 않는다. `terminal send` 의 `--retry-request` 는 "같은 명령 그대로"를 다시 보낼 때만 중복을 막는다(`AC:11399`). Paseo 규칙을 지키려면 이 재발행도 하지 않는 편이 안전하다.
- **유휴 확인.** Paseo `canReceiveBoardInput` (`P/server/discovery.ts:18-22`)을 다음처럼 옮긴다. `blocked` 면 거부. `done` 이면 허용. `waiting` 은 TUI 질문이므로 허용하지 않고 "세션에서 답하기" 카드로 둔다(3.2 의 1번). `working` 이면 코디네이터라도 거부하고 대기열에 넣는다. steer 가 없기 때문이다. 보내기 직전에 `agents.list` 와 `agent read` 의 state 를 다시 읽고, `stateStartedAt`/`updatedAt` 이 그대로인지 확인한다.
- **권한 대기 가드.** blocked 세션에는 어떤 경로로도 보내지 않는다. 추가 질문은 Paseo 처럼 코디네이터에게 보낸다(`P/shared/clarifications.ts:118`).
- **포커스 문제.** host `terminal.sendText` 는 포커스된 워크스페이스에만 들어가서 화면을 옮겨야 한다(`CB/README.md:81`). CLI `terminal send` 에도 같은 제한이 있는지는 확인되지 않았다(추정). 1단계에서 직접 시험해서 제한이 없으면 CLI 로 통일한다.
- **주의.** Orca 문서는 다른 에이전트 입력창에 타이핑하지 말고 `orchestration send` 를 쓰라고 한다(`AC:11399`). 사람 답장을 user 턴으로 남기는 것이 Paseo 와 같은 동작이다. 그래서 터미널에는 `terminal send` 를 쓰는 쪽을 권하지만, Orca 의 권고와는 어긋난다.

### 5.d 코디네이터 생성, 모델, 권한 모드

- **생성.** `orca agent launch --agent claude|codex --worktree id:<ws> --model <m> --effort <e> --surface terminal --prompt <charter+시작 지시> --json` 을 쓴다(`AC:253`). 응답의 `outcome.handle` 과, 첫 보고 뒤의 orcaSessionId 를 `pendingCoordinator` 에 저장한다. Paseo 의 "생성 전에 id 를 저장해 재시도 때 같은 세션을 채택"(`P/server/lifecycle.ts:93-173`)은 `--retry-launch <operationId>` 와 저장된 handle 로 대신한다.
- **운영 워크스페이스.** Paseo 는 플러그인 전용 폴더를 쓴다(`P/index.server.ts:42`). Orca 에는 플러그인이 프로젝트를 추가하는 API 가 없다. 사용자가 고른 프로젝트 워크스페이스에 띄운다. `orca repo` 로 전용 폴더를 등록할 수 있는지는 확인하지 못했다(추정).
- **권한 모드.** 터미널 실행에만 쓸 수 있다. `agent.launch.before` 가 실행 대상이 코디네이터인지 알아보고(프롬프트 안 표식, ensemble `[ensemble:L…]` 방식, `E/src/worker/hooks.ts:53`) 허용된 인자만 붙인다. Paseo 허용 목록은 claude `auto/default`, codex `auto-review/auto` 다(`P/server/dispatch.ts:21-45`). 이것을 에이전트별 인자 표로 옮긴다. 정확한 플래그 값은 각 CLI 버전에서 확인해야 한다(추정). 작업자에게 `bypassPermissions` 를 금지하는 규칙도 같은 표에서 막는다.
- **시스템 프롬프트.** Claude 는 `--append-system-prompt` 를 붙일 수 있다(`E/src/worker/hooks.ts:178`). Windows 실행 셸의 인용 규칙이 확인되지 않았으므로 1차 구현에서는 charter 를 첫 프롬프트에 넣는다.
- **맞출 수 없는 것.** 워크스페이스 고정은 setter 가 없다. 대신 `worktree set --display-name "코디네이터 운영"`(`AC:12124`)과 상태 표시줄로 보여 준다. 채팅 코디네이터의 권한 모드는 Orca 설정 > Agents 값만 따른다(`E/src/shared/agents.ts:76-79`). 실행 후 `currentModeId` 검증(`P/server/lifecycle.ts:19-31`)은 불가능하다. 영수증에 "요청한 인자"만 남긴다.
- **작업자 배정** (`assign_board_worker`). 코디네이터의 `coordinator-board assign` 처리 중 protocol 2 로 코디네이터 셸에서 `orca agent launch` 를 실행한다. 이렇게 하면 Orca 화면에 "코디네이터가 넘김"으로 나온다(`E/src/worker/caller.ts:1-5`). fingerprint, grade, parent 는 플러그인 저장소에 `requestKey` 키로 둔다. 감독이 필요하면 `orchestration worker-start` 를 쓴다. 다만 이 명령은 surface 를 무시한다(`AC:7603`).

### 5.e 모델 라우팅과 사용량

- `P/shared/dispatch.ts` 와 `P/shared/usage-routing.ts` 는 그대로 쓴다.
- **사용량.** `orca account list --json` 의 `rateLimits.<agent>.session/weekly` 를 `AccountUsage.windows[]` 로 바꾼다. `remainingPct = 100 - usedPercent`, 신선도는 `updatedAt` 으로 판단한다. 3초 제한과 실패 시 빈 배열 처리는 Paseo 와 같게 둔다(`P/server/usage-routing.ts:16-44`).
- **카탈로그.** `orca agent installed` 로 사용 가능한 에이전트를 얻는다. 모델 목록은 정적 추천표에 사용자가 직접 입력한 id 를 더한다. "모델 n개", "모델 조회 실패" 같은 Paseo 상태 문구는 "추천 n개 · 직접 입력 가능"으로 바꿔야 한다.

### 5.f 다른 호스트

- `workspace.list` 는 모든 호스트를 덮는다(`hostId` 는 local, ssh, runtime). `orca host list` 로 페어링된 서버를 얻고, 30초마다 `orca agent list --environment <name> --json` 으로 running 세션을 읽는다. Paseo `remote-running` 과 같은 주기다.
- **잃는 것.** 계정 사용량은 로컬 전용이다(`AC:48`). `agent.listSessions` 는 로컬과 WSL 만 된다. `agent.tool.*` hook 은 SSH/WSL 에서 동작하지 않는다. 원격 세션에 보내는 경로는 `orchestration send --on <server>` 뿐이다(`AC:7278` 주석).

### 5.g 이벤트 기반 큐 비우기

- 매니페스트에 `contributes.events: ["agent.status.changed","workspace.removed"]` 를 넣는다.
- 각 Paseo hook 의 대응은 다음과 같다.
  - `agent.turn.after` 대신 working 에서 done/waiting 으로 바뀌는 전이를 쓴다. `mainAgent.outcome` 이 success, failure, cancellation, interruption 중 하나면 턴 끝으로 본다.
  - `agent.permission.after` 대신 blocked 에서 다른 상태로 바뀌는 전이를 쓰고, 250ms 뒤에 한 번 더 확인한다(`P/index.server.ts:202-218`).
  - close/archive 대신 `workspace.removed` 와 목록에서 사라진 행을 쓴다.
- 이 이벤트들이 `resumeQueued` 와 병합 알림 `resume` 을 부른다. 채팅과 이벤트 누락은 30초 상태 폴링에서 같은 함수를 불러 보완한다. 실행 직후 첫 `done` 은 턴 끝으로 보지 않는다(`E/src/worker/collab.ts:204-207`).

### 5.h 대시보드 화면

**결정은 custom editor 의 isolated HTML 프레임에 React 를 번들해서 쓰는 것이다.** 사이드바 components 패널은 배지와 "보드 열기"만 맡는다.

이유는 다음과 같다.
- components 패널은 DOM 이 없고(`T/orca/index.d.ts:172-173`) 키 이벤트를 받을 수 없다. 단축키는 Textarea 의 `onSubmit`(Cmd/Ctrl+Enter)만 있다(`T/orca/index.d.ts:326,370`). 그래서 J/K/S 키, 드래그로 사진 놓기, 붙여넣기, 너비 측정(600/900/490 분기), Matrix 행 아래 서랍, 가로 칸반을 만들 수 없다.
- 프레임은 전체 폭을 쓰고 `document` 수준 키 처리가 된다. `orca-ensemble` 이 이미 React 19 와 esbuild 로 custom editor 프레임을 배포하고 있다(`E/package.json:19-20`, `E/orca-plugin.json:51-67`).
- 대가도 있다. 키 파일이 있어야 하고(현재 포트의 `.coordinator-board/` + `info/exclude` 방식, `CB/src/worker.ts:410-436`), 데스크톱 전용이며, `orca.document.get()` 을 반드시 불러야 한다(`CB/README.md:84`).

**토큰 대응**

| Paseo 테마 키 | Orca 값 |
|---|---|
| surface0 (페이지, 입력) | `--orca-background` |
| surface1 (카드, 패널) | `--orca-card` + `1px color-mix(in oklab, var(--orca-border) 50%, transparent)` + shadow-sm. 라이트에서는 card 와 background 가 모두 `#fff` 라서 테두리로 구분한다 |
| surface2 (선택, 눌림) | 선택 행은 `--orca-accent`. 코드 배경은 `--orca-muted` |
| border | `--orca-border` |
| foreground / foregroundMuted | `--orca-foreground` / `--orca-muted-foreground` |
| accent (주 버튼) | `--orca-primary` (중립 잉크색이다. 파란색이 아니다) |
| accent (포커스, 드래그 외곽선) | `--orca-ring`, 3px `ring/50` |
| accent (running 점, 사용량 막대) | running 은 `yellow-500` 스피너, 막대는 `--orca-primary` (Progress 레시피) |
| accentForeground (배지 숫자) | `--orca-primary-foreground` |
| statusDanger | `--orca-destructive` (프레임에 노출됨) |
| statusWarning | 하드코딩 `#ca8a04` / `#eab308`. 라이트의 글자색은 `color-mix(warning 70%, fg)` |
| statusSuccess | 하드코딩 `#147638` / `#86efac` |
| 질문/권한 점 | `orange-600` / `orange-500` (agent-question) |
| `tint(c, .16)` | 배경 `color-mix(in oklab, c 10%, transparent)`, 테두리 25% (`orca/main.css:558-559`) |
| 링크 | `#0969da` / `#4493f8`. `--orca-primary` 를 링크색으로 쓰지 않는다 |

추가로 할 일은 세 가지다. `html.light/.dark` 마다 `color-scheme` 을 직접 지정한다. 격리 프레임 셸은 이것을 넣지 않는다(`orca/plugin-panel-shell.ts:313-316`). Geist 폰트는 `woff2` 를 플러그인 안에 함께 넣는다. 반경은 `--orca-radius` 에 0.6, 0.8, 1, 1.4 를 곱해 만든다.

**컴포넌트 대응**

| Paseo | Orca 레시피 | 달라지는 점 |
|---|---|---|
| Button (pill, 32/28) | Button `rounded-md`, default 36 / sm 32 / xs 24 | 알약 모양 대신 8px 모서리가 된다. 주 버튼은 중립 잉크색이다 |
| Button `ghost` (흐린 글자) | `ghost-muted` | |
| Button `selected` | `outline` + `bg-accent` | |
| SegmentedControl | Tabs 기본형. `bg-muted p-[3px]`, 활성은 `bg-background shadow-sm`, sm 은 28px | 높이 26에서 28로 |
| StatusBadge (tint 알약) | Badge. warning 변형, success 는 outline + 6px 점, danger 는 destructive, muted 는 secondary | 색 채운 알약 대신 점 표시 |
| StatusDot / RunningMark | AgentStateDot 글리프. working 은 노란 스피너, waiting/blocked 는 주황 물음표, done 은 emerald 체크, 실패만 빨강 | Paseo 의 running 은 회색 스피너다 |
| SessionChip | Button `pill` 크기(h-7, rounded-full, text-xs) + outline + `ChevronRight` | Orca 에서 알약 모양이 허용되는 유일한 곳이다 |
| Disclosure | Card sm + ghost 트리거 + chevron | |
| SectionLabel | 11px semibold muted (메뉴 라벨 레시피) | |
| ⌘/Ctrl+Enter 툴팁 | Tooltip (반전 칩) + Kbd 키캡 | |
| 카드 반경 12/16 | `rounded-xl` 14px | |

### 5.i 코드 구조

**데이터 형태를 먼저 고정한다.** `board.snapshot` 출력(`P/shared/contract.ts` 의 `boardSnapshot`)을 그대로 쓴다. `SessionRow` 에는 `orca: {surface: 'chat'|'terminal', terminalHandle?, paneKey, workspaceId, workspaceListId?, hostId}` 하나만 더한다. `id` 는 `orcaSessionId` 다. 화면 코드는 이 스냅샷 하나만 본다.

**어댑터 인터페이스.** Paseo 서버 코드가 쓰는 SDK 표면(`P/` 조사 결과 3장 표)을 그대로 흉내 낸 `OrcaPaseoShim` 을 만든다. 그러면 서버 파일은 import 만 바꾸면 된다.

```ts
interface BoardHost {
  agents: { list(q): Page<Entry>; ref(id): { refresh(): Promise<Entry|null>;
            send(text, o:{messageId; from:'person'|'plugin'|{agent:string}}): Promise<SendReceipt>;
            timeline: { refetch(o:{limit:number}): Promise<Timeline> } } }
  workspaces: { list(q): Page<Workspace>; launch(o:LaunchSpec): Promise<{handle; sessionId?}> }
  projects: { list(): Promise<Project[]> }
  providers: { listAvailable(); listModels(p); listUsage(): Promise<AccountUsage[]> }
  cli(args: string[], o?: { asCaller?: string; timeoutMs?: number }): Promise<unknown>
  onTurnEnd(fn); onPermissionCleared(fn); onGone(fn)
}
```

| 구분 | 파일 |
|---|---|
| 그대로 이식 (`defineRpc`/`defineSettings` 만 로컬 shim 으로 바꾸고 zod 는 번들) | `P/shared/*.ts` 전부. `P/client/` 의 순수 `.ts` 파일: decision-priority, decision-row, inbox, focus-queue, focus-status, matrix, decision-summary(+vendor marked), decision-receipts, decision-edit-order, decision-reply-state, send-shortcut, work-photos, model, history-sessions, merge-notification, route-options, lane-width, project-icon, view-mode, tracked-session-targets, tone. `P/test/` 의 해당 테스트 |
| 어댑터 위에서 이식 (본문 유지, 호출부만 바꿈) | `P/server/` 의 conversation(입력 변환만), decisions, decision-message, recommendation, clarifications, board-facts, tracked-decisions, tracked-review, project-decision-sources, merge-notifications, digest, notes, preferences(데이터 경로), session-links, snapshot-reads, reply-photos, session-photos, prs와 pr-merge(`execCommand` 를 현재 포트의 `run` 과 `commandEnv` 로 교체), usage-routing, display-usage. `P/client/remote-sessions.ts` |
| 새로 작성 | discovery(Orca 상태를 레인으로 바꾸는 표), coordinator와 reporting(shim 명령), lifecycle(launch, 고정 제거), dispatch(카탈로그 출처), project-icons(커스텀 아이콘 경로), `index.server.ts` 를 `worker.ts` 로(`panels.handle` 등록, events, hooks). 모든 `.tsx` 화면 |
| 현재 포트에서 재사용 | `CB/src/github.ts` 의 `commandEnv`, `CB/src/model.ts` 의 `cleanLine`, `CB/src/summary.ts` 의 `focusedWorkspace` 와 키 파일 처리 |

Paseo 화면은 React Native 다(`P/client/view-inbox.tsx:2`, `P/client/controls.tsx:3`). `View`, `Text`, `Pressable`, `ScrollView` 를 DOM 으로 바꾸는 작은 원시 컴포넌트 층을 만들면 `.tsx` 구조를 거의 그대로 옮길 수 있다. `paddingHorizontal` 같은 RN 전용 스타일 키만 변환하면 된다(추정). 이 층에서 Orca 레시피 클래스를 입힌다. 현재 포트에 있는 `resume-reply` 는 Paseo 에 없는 기능이다. 빼거나 "닫힌 세션" 보조 기능으로 따로 둔다.

---

## 6. 단계별 구현 순서

| 단계 | 내용 | 확인 방법 |
|---|---|---|
| 0. 뼈대 | ensemble 식 esbuild 번들(`dist/worker.mjs`, `dist/board.html`). 2.i 의 "그대로 이식" 파일과 Paseo 테스트를 옮긴다 | `orca plugin test .` 에서 이식한 단위 테스트 통과, `orca plugin validate .` |
| 1. 읽기 전용 동등성 (가장 작은 첫 조각) | 어댑터의 목록 결합, `agent read` 발췌, 질문 감지, done 세션의 human 레인, `board.snapshot`, `board.decision-count`, 상태 표시줄 수. 프레임에 Inbox 보기를 읽기 전용으로, Orca 토큰으로 만든다 | `orca plugin dev request . board.snapshot` 결과에서 평문 질문 세션이 `lane:"human"` 으로 나오는지. `orca plugin shot` 으로 Inbox 의 now/waiting/merge/later 묶음과 순서를 확인 |
| 2. 답장 전송 | 봉투, pending 영수증, 가드, 터미널/채팅 전송, `agent read` 대조. 포커스 제한도 이 단계에서 확인 | 테스트 에이전트에 `dev request . board.send-decision` 을 보내고 pending 이 sent 로 바뀌는지. blocked 세션은 거부되는지 |
| 3. 코디네이터 | named pipe, `.cmd` shim, `agent.launch.before` 의 env/PATH, `setup-coordinator`, read/classify/추천/다이제스트/작업 요청 | `orca plugin dev hook . agent.launch.before --data …` 로 PATH 가 `;` 로 이어지는지. 코디네이터 터미널에서 `coordinator-board read` 가 응답하는지 |
| 4. 나머지 보기 | Focus, Matrix, Classic, 헤더, 필터, 설정, 진행 칸반, 기록 | 보기마다 `orca plugin shot`. J/K/S, Ctrl+Enter, 너비 600/900/490 분기 |
| 5. 장부, 사실, PR | 결정 장부와 큐, 이벤트 드레인, 보드 사실, 병합 미리보기와 확정, 병합 알림 | `orca plugin dev emit . agent.status.changed --data …` 로 큐가 비워지는지. 실제 저장소에서 바우처 만료와 head 변경 거부 |
| 6. 운영 기능 | 라우팅, 사용량, 배정, 원격 호스트, 세션 연결, 사진(파일 경로 방식), 프로젝트 아이콘 | `dev request . board.operations`, 코디네이터의 `coordinator-board assign` 으로 작업자가 실제로 실행되는지 |

1단계만 끝나도 사용자가 가장 먼저 느끼는 차이가 사라진다. Paseo 에서 보던 질문이 Orca 보드에 같은 순서와 같은 묶음으로 뜬다.

---

## 7. 못 맞추는 부분과 주의점

| 항목 | 근거 | 사용자가 겪는 일 |
|---|---|---|
| MCP 도구를 줄 수 없음 | `ORCA/.../plugin-contribution-points.js:39-46` | 코디네이터가 도구 대신 셸 명령을 쓴다. 채팅 코디네이터는 첫 프롬프트에 경로를 받아야 한다 |
| ensemble 방식이 Windows 에서 동작하지 않음 | `/tmp` 소켓(`E/src/shared/paths.ts:13-15`), `:` PATH(`E/src/worker/hooks.ts:126`), sh 전용 shim(`E/bin/agent-team:1`), `/bin/bash` 실행(`E/src/worker/adapter.ts:139,162`), 확장자 없는 `bin/orca` 탐색(`E/src/worker/adapter.ts:90-91`) | 그대로 베끼면 이 PC 에서 코디네이터 채널이 열리지 않는다. 5.a 의 수정이 필수다 |
| 평문 질문이 done 으로 보임 | `CB/README.md:82` | 대화를 읽지 않으면 질문을 놓친다. 그래서 세션마다 `agent read` 비용이 든다 |
| waiting 은 TUI 질문 화면 | `CB/README.md:82` | 자유 텍스트를 넣으면 선택지를 잘못 고를 수 있다(추정). "세션에서 답하기"로 처리한다 |
| steer 없음 | 4장 표 | 실행 중인 코디네이터에게 작업 요청을 바로 넣을 수 없다. 턴이 끝난 뒤 들어간다 |
| messageId, sourceAgentId 없음 | `T/orca-host/index.d.ts:326,334` | 대조는 본문 표식 기반이다. 터미널 직접 입력에는 출처가 남지 않는다 |
| `agent read` 는 최신 100개, cursor 없음 | `AC:324` | 긴 턴이 이어지면 오래된 pending 영수증을 확인하지 못하고 unconfirmed 로 남는다 |
| 터미널 에이전트 id 가 `/clear` 때 바뀜 | `AC:292` 주석 | 그 세션에 쌓인 답변 기록, 메모, 연결이 끊긴다 |
| resume-reply 가 요청 시간 제한 30초를 넘김 | `T/orca-services/index.d.ts:54`, `CB/src/worker.ts:338-369` | 화면은 실패로 표시하는데 워커는 나중에 타이핑할 수 있다. 오래 걸리는 요청은 즉시 접수만 돌려주고 결과를 `panels.post` 로 알린다. 또는 `timeoutMs` 를 120초까지 준다 |
| hook 2초 제한, 실패하면 통과 | `T/orca-worker/index.d.ts:98-104` | launch hook 안에서 CLI 를 띄우면 PATH 주입이 조용히 빠진다 |
| 워크스페이스 id 형식 세 가지 | `CB/README.md:76,83` | 이벤트의 `workspaceId` 대신 `workspaceListId` 를 쓴다 |
| 고정(pin) 불가 | `worktree ps` 의 `isPinned` 읽기 전용 | 코디네이터 워크스페이스가 사이드바 위에 고정되지 않는다 |
| 모델/모드 카탈로그 없음 | 4장 표 | 모델 선택기가 추천 목록 + 직접 입력이 된다. 잘못된 모델은 실행할 때 알게 된다 |
| 이미지 첨부 없음 | 4장 표 | 사진은 파일 경로로 전달한다. 타임라인의 사진 렌더러는 만들 수 없다 |
| 계정 사용량과 세션 기록은 로컬 전용 | `AC:48`, `T/orca-host/index.d.ts:278` | 원격 호스트 기준 사용량 라우팅은 못 한다 |
| 키 파일 의존 | `CB/src/worker.ts:410-436` | 포커스된 로컬 워크스페이스가 있어야 보드가 열린다. 저장소에 숨김 폴더가 생긴다 |
| 격리 프레임의 디자인 공백 | `orca/plugin-panel-shell.ts:313-316`, CSP `font-src 'self' data:` | `color-scheme` 과 Geist 를 직접 챙기지 않으면 스크롤바가 밝게 나오고 글꼴이 다르다 |
| 권한(capabilities) 변경 | `CB/AGENTS.md:39` | events, hooks 와 새 권한을 더하면 사용자가 다시 승인해야 한다 |
| `panels.post` 한도 | 256 KiB, 10초에 200번 | 스냅샷은 post 로 밀지 말고 request 로 당겨 온다. post 는 "바뀜" 신호만 보낸다 |

정리하면 1단계(읽기 전용 동등성)와 3단계(Windows 용 shim 채널)가 이번 작업의 핵심이다. 나머지는 Paseo 코드를 어댑터 위로 옮기는 반복 작업이다.