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

## 확인할 것

- CLI `terminal send`도 포커스된 워크스페이스에만 보내는가.
- 메일(`orchestration send`)이 받는 쪽 기록에 표식을 남기는가.
- `agent.launch.before`의 `event.env`에 PATH가 들어오는가.
- 워커 env에서 `orca.exe`가 런타임을 찾는가.
