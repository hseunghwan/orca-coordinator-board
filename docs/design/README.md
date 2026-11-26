# Orca 어댑터 설계 결정

Paseo 서버 로직을 Orca 워커 위로 옮길 때 쓰는 경계를 정한 기록이다. 후보 두 개를 따로 설계했고, 원문은 같은 폴더에 있다.

- `candidate-1-sdk-facade.md`, `candidate-1-sdk-facade.sketch.ts`: Paseo SDK 모양을 흉내 내는 안
- `candidate-2-fleet.md`, `candidate-2-fleet.sketch.ts`: 도메인 포트 `Fleet` 안

## 결정

기본안은 후보 2(`Fleet`)다. Paseo 서버 코드는 `src/orca/index.ts`의 `Fleet`만 본다. 전송은 `fleet.deliver()` 하나로만 한다.

후보 1에서 가져온 것:

1. 화면 상태는 `orca worktree ps --json` 한 번으로 읽는다. 에이전트마다 주소(`term_…` 또는 `orca_session_id:…`), `mainAgent.outcome`, `activity.unread`, `hasLivePty`가 함께 온다. 저장소 아이콘과 원격 주소는 `orca repo list --json`(60초 캐시)에서 읽는다.
2. done이면서 안 읽음인 세션은 review 레인이다. Paseo에서 결과를 아직 안 본 세션이 확인 대기에 있다가 열면 대기 중으로 가는 동작과 같다.
3. 읽기 쪽은 Orca 행을 Paseo 에이전트 필드로 바꾸는 표 하나(`paseoAgentView`)로 투영한다. 그래서 `discovery`, `conversation`(`excerpt`, `classify`)의 판단 로직은 고치지 않는다.
4. 식별자는 형식마다 브랜드 타입을 둔다(`OrcaSessionId`, `PaneKey`, `TerminalHandle`, `WorktreeId`, `WorkspaceListId`).

후보 2에서 유지한 것과 그 근거(2026-11-26 실측, Orca 1.4.277):

- 터미널 세션의 `orca agent read`는 긴 항목을 1,214자에서 자르고 `… (truncated)`를 붙인다(표본 7개 중 4개). 채팅은 자르지 않는다. 그래서 전체 텍스트 해시나 끝에 붙인 표식으로는 전송을 대조할 수 없다. 표식 `[cb:<messageId>]`는 첫 줄에 붙이고, 대조는 표식과 앞부분 일치로 한다.
- 잘린 마지막 assistant 턴은 터미널 행의 `lastAssistantMessage`(전체 텍스트, 최대 7,050자 관찰)로 복원한다. 채팅의 `lastAssistantMessage`는 앞 200자뿐이라 복원하지 않는다(채팅 기록은 잘리지 않는다).
- `orcaSessionId`가 없는 터미널 에이전트가 실제로 있다. 이 행은 보드 행으로 만들지 않고 따로 센다.
- 코디네이터 채널의 호출자 확인은 launch 훅이 넣는 `HMAC(secret, terminalId)` 토큰으로 한다.

검토 문서를 따르는 것:

- 실행 중인 세션에 끼워 넣기(steer)는 기본적으로 거부하고 대기열에 넣는다. 실행 중인 TUI가 붙여 넣은 입력을 대기열로 받는지 시험한 뒤 바꾼다.

## 실기 확인 (2026-11-26, Orca 1.4.277)

- 채팅 세션에 `orca orchestration send --to orca_session_id:<id> --type status --body-file <f>`로 보내면 포커스와 상관없이 바로 들어간다. 유휴 채팅은 메일을 받으면 턴을 하나 돈다.
- 받는 쪽 `agent read`에는 user 항목 하나로 남는다. 모양은 `──── From: <NAME> (<handle>) (<type>) ────`, `Subject: <subject>`, 본문, 끝에 `[Reply: orca orchestration reply …]` 순서다. 본문 첫 줄의 표식 `[cb:<id>]`는 그대로 남지만 항목의 첫 줄은 아니다. 대조는 메일 머리를 뗀 뒤 표식을 찾는다.
- `--from`이 없으면 CLI를 실행한 터미널이 발신자로 남는다. 환경에서 `ORCA_TERMINAL_HANDLE`, `ORCA_PANE_KEY` 같은 변수를 모두 지워도 그 터미널 이름이 그대로 남았다. Orca는 변수가 아니라 호출 프로세스가 어느 터미널 아래에서 돌았는지로 발신자를 찾는 것으로 보인다(추정). 그래서 에이전트 셸에서 돌린 프로브는 워커의 경우를 시험하지 못한다.
- 어느 터미널에도 속하지 않은 프로세스(워커와 같은 경우, WMI로 띄워 시험)가 `--from` 없이 보내면 `Could not determine the calling terminal for this orchestration command` 오류로 거절한다. 받는 쪽 기록에는 아무것도 남지 않았다.
- 같은 프로세스가 `--from <term_…>`을 주면 보내진다. 받는 쪽 From 줄에 그 핸들이 남고, 받는 세션이 `orchestration reply`로 답하면 그 터미널의 메일함으로 간다. 그래서 워커는 자기 터미널 하나(`Coordinator Board mail`, 사람이 보고 있는 워크스페이스에 첫 채팅 전송 때 `terminal.create`로 연다)를 메일 발신자로 쓴다.
- 메일 항목은 `[Reply: …]` 줄 뒤에 `────` 줄이 하나 더 붙는다. 대조는 두 줄을 모두 떼고 표식을 찾는다.
- 워커 경로 전체(`board.send-decision` → `fleet.deliver` → `orchestration send --from`)로 채팅 세션에 답장 하나를 보냈다. outbox는 `delivered`(메일 id)가 됐고, 받는 쪽 기록에서 같은 표식과 앞부분으로 찾았고, 다음 스냅샷의 `replyHistory`에 세션의 답이 붙었고, 카드는 답한 것으로 바뀌었다(`scripts/probe-send.mjs`).

## 확인할 것

- CLI `terminal send`도 포커스된 워크스페이스에만 보내는가. 거절 문구가 `outside the active worktree`와 같은가(대체 경로가 이 문구로 갈린다). 시험할 터미널 에이전트를 사람이 정해 줘야 한다.
- host `terminal.sendText`가 여러 줄 글을 스스로 붙여넣기 괄호로 감싸는가. 대체 경로는 괄호를 직접 붙인다.
- host `terminal.create`가 돌려주는 `terminalId`를 CLI `--from`에 그대로 쓸 수 있는가, 지금 권한으로 열 수 있는가.
- `agent.launch.before`의 `event.env`에 PATH가 들어오는가.
- 워커 env에서 `orca.exe`가 런타임을 찾는가.
