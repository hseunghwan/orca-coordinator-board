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

- 터미널 세션: 포커스 밖 워크스페이스의 터미널 에이전트에 `orca terminal send --terminal <term_…> --text … --enter --wait-submit 10`을 보내면 그대로 들어간다(`input_accepted`, `turn_started`). 어느 터미널에도 속하지 않은 프로세스(워커와 같은 경우)에서 보내도 된다. 메일과 달리 발신 터미널이 필요 없다. 포커스 제한은 host `terminal.sendText`에만 있다.
- 터미널 기록의 user 항목도 1,214자에서 `… (truncated)`로 잘린다. 첫 줄의 표식은 남으므로 대조에 쓸 수 있다.

## 실기 확인: 코디네이터 (2026-11-26, Orca 1.4.277)

- `orca agent launch --agent claude --model haiku --worktree path:<경로> --surface terminal --prompt <글> --json`의 결과에는 `outcome.kind`(`terminal`), `outcome.handle`(`term_…`), `outcome.paneKey`, `worktreeId`, `operationId`가 온다. 짧은 답을 하는 세션은 1초 안에 `worktree ps`에 같은 주소와 `orcaSessionId`로 나왔다. 보드는 handle로 세션을 찾아 코디네이터로 지정한다.
- 프롬프트 첫 줄의 표식 `[coordinator-board:<id>]`는 첫 user 항목에 그대로 남는다.
- 실행 명령(`orca terminal list`의 `preview`)은 단어마다 POSIX 작은따옴표로 감싸고, 프롬프트 앞에 `'--'`를 둔다. 사람의 에이전트 설정에 따라 `'--dangerously-skip-permissions'`가 붙어 있었다. 그래서 훅은 코디네이터 실행에서 우회 인자를 빼고, 권한 인자(claude `--permission-mode auto`, codex `--approve-for-me`)를 `'--'` 앞에 넣는다. 인자 이름은 각 CLI의 `--help`에서 확인했다.
- 백그라운드로 띄운 터미널은 `orca terminal list`에서 `orphaned: true`로 나온다. 이 터미널은 `orca terminal close --terminal <handle> --tab`이 `terminal_handle_stale`로 실패했고, `--tab` 없이는 닫혔다.
- `orca agent installed --json`은 `{ agents: [{ id, name, default }] }`만 준다. 모델 목록은 없어서 보드는 Paseo 라우팅 표의 모델을 정적 추천으로 쓴다.
- `orca account list --json`의 `rateLimits.<제공자>`에는 `session`, `weekly`, `monthly`와 모델 계열 창(예: `fableWeekly`)이 `usedPercent`, `resetsAt`(ms)와 함께 오고, `status`, `error`, `planType`, `updatedAt`이 붙는다. 보드는 `remainingPct = 100 - usedPercent`로 바꾸고, 모델 계열 창은 `weekly_model_<계열>`로 이름 붙여 그 모델에만 적용한다.
- `orca plugin dev hook <폴더>`는 로드된 개발 플러그인에만 돈다. 이 작업 폴더는 로드되지 않아 `plugin_not_found`가 났다. 그래서 `scripts/probe-channel.mjs`로 실제 워커 코드(`activateWith`)의 훅을 부르고, 그 env로 `bin/coordinator-board.cmd`를 자식 프로세스로 실행했다. `CB_NODE`는 Orca 실행 파일(`ELECTRON_RUN_AS_NODE=1`)이다. 결과: 훅이 `CB_BIN CB_CALLER_TOKEN CB_NODE CB_PIPE CB_TERMINAL`을 넣고 `Path` 맨 앞에 bin을 붙였다. 코디네이터로 지정한 터미널의 `read`는 종료 코드 0(호출당 약 0.45초), 틀린 토큰은 4, `plan`은 1, 워커가 없는 pipe는 2였다.

## 실기 확인: 보드 사실, 장부, PR (2026-11-26, Orca 1.4.277)

- 서명한 메일: 어느 터미널에도 속하지 않은 프로세스(WMI로 띄움, 워커와 같은 경우)가 `fleet.deliver`의 agent 발신자로 시험 채팅에 사실 묶음 하나를 보냈다. 명령은 `orchestration send --from <코디네이터 터미널 핸들> --type status`였고 결과는 `delivered`(메일 id)였다. 받는 쪽 기록의 From 줄에는 코디네이터 터미널 핸들과 `(status)`가 남았다. 보드의 기록 변환은 이 항목을 Paseo의 에이전트 메시지(`paseo-agent-message:<messageId>`)로 읽었고, 발신자는 코디네이터 세션 id, 본문 해시는 보낸 묶음과 같았다. 그래서 `BoardFacts.decorate`가 불확실한 전송을 받는 쪽 기록으로 확정할 수 있다. 받은 채팅은 턴을 하나 돌았고 답장 메일은 보내지 않았다(`scripts/probe-ledger.mjs mail`).
- 보드 메일 터미널 명의(병합 알림)는 따로 보내지 않았다. 지금 열린 보드 메일 터미널이 없었고, 프로브가 터미널을 새로 열 수 없다. 같은 `--from <보드 터미널>` 경로는 2단계에서 채팅 답장으로 확인했다.
- 터미널 세션에 `orchestration send`로 보낸 메일이 받는 쪽 기록에 어떤 모양으로 남는지는 실기로 보지 않았다. 가짜 Orca는 채팅과 같은 메일 머리로 둔다.
- PR: 보드가 고른 프로젝트 7개 가운데 GitHub 저장소 3개가 auto로 연결됐고 4개는 `unmapped`였다(GitHub이 아닌 원격). 열린 PR은 없었다. 병합된 PR 하나에 `board.read-pull-lifecycle`은 `MERGED`, `board.preview-pull-request-merge`(GraphQL 읽기)는 `merged`를 돌려줬고 바우처는 나오지 않았다. 병합 확정은 실기로 부르지 않았다(`scripts/probe-ledger.mjs prs`).
- 코디네이터의 `review`: 살아 있는 코디네이터에게 터미널 입력으로 요청 하나를 보냈다(`delivered`, `terminal-input`). 코디네이터는 명령을 한 번 실행했고 CLI는 종료 코드 2(파이프에 닿지 못함)를 냈다. 원인은 명령 줄에 직접 쓴 파이프 이름으로 본다(추정). 이 에이전트의 셸 도구(Claude Code, Git Bash)에 같은 명령 글을 넘기면 `\\`가 `\`로 줄어 `\\.\pipe\…`가 `\.\pipe\…`가 되고, 같은 종료 코드 2가 났다. 같은 명령을 스크립트 파일로 Git Bash에서 돌리면 이 브랜치의 워커에 닿아 `{"closed":[],"reviewable":[…]}`를 돌려줬다. 실제 코디네이터는 `CB_PIPE`를 실행 환경에서 물려받으므로 이 줄임을 겪지 않는다(3단계에서 `read`로 확인). 프로브는 이제 명령을 스크립트 파일로 넘긴다.
- PATH: 코디네이터의 `claude.exe` 환경 블록을 읽기만 해서 봤다(`scripts/probe-path.mjs`). `CB_BIN CB_CALLER_TOKEN CB_NODE CB_PIPE CB_TERMINAL`은 있었고, PATH 키는 `PATH` 하나뿐이며 bin 폴더가 들어 있지 않았다. 코디네이터의 Bash 도구 기록에는 `coordinator-board: command not found`(127)가 남았고, charter의 절대 경로로는 실행됐다. 훅은 이제 Windows에서 같은 값을 `PATH` 키에도 쓰고, 실행마다 `event.env`의 PATH 키 이름만 로그에 남긴다. `event.env`에 `Path`가 왔는지, `PATH`가 왔는지, 아예 없었는지는 새 실행 없이는 볼 수 없어서 확인하지 못했다.

## 실기 확인: 작업자 배정, 호스트 (2026-11-26, Orca 1.4.277)

- 채널 protocol 2: 실제 shim(`bin/coordinator-board.cmd`)을 Orca 런타임(`CB_NODE`가 `Orca.exe`, `ELECTRON_RUN_AS_NODE=1`)으로 돌리고, 워커 쪽 `serveChannel`이 `exec` 줄로 `agent installed`를 시켰다. CLI는 `CB_NODE` 옆의 `resources/bin/orca.exe`를 찾아 `ELECTRON_RUN_AS_NODE`를 뺀 환경으로 실행했고, 워커는 `exec-result`로 받은 출력을 `createCli`로 읽었다(요청 `v: 2`, 에이전트 4개). 읽기 전용 명령만 썼고 `dist/` 대신 임시 폴더의 shim과 CLI 묶음으로 돌렸다.
- `orca host list --json`의 행은 `kind`(`local`, `ssh`, `environment`), `id`, `name`, `selector`를 준다. SSH 행에만 `connected`가 있고 환경 행에는 연결 여부가 없다. 그래서 보드는 `agent list --environment`가 답한 환경만 연결됨으로 본다.
- 짝지은 환경 하나는 `orca agent list --environment <id> --json`에 약 1.1초 만에 에이전트 8개를 돌려줬다. 행의 키는 `orcaSessionId kind agent state worktreeId workspace hostId paneKey title lastAssistantMessage updatedAt`이고, 이 기기의 목록과 달리 `repo`가 없었다. 다른 환경(WSL)은 0.6초 만에 `remote_runtime_unavailable`로 거절했다. 원격 세션은 `worktreeId`의 저장소 id가 이 기기 프로젝트와 같을 때만 프로젝트에 붙는다.
- 살아 있는 코디네이터를 거치는 배정은 아직 보내지 않았다. 로드된 개발 플러그인은 `feat/paseo-parity` 작업 트리의 0.5.0이고, `node scripts/probe-dispatch.mjs check`가 코디네이터(터미널, `done`)와 대상 워크스페이스는 찾았지만 카탈로그에 Haiku가 없다고 보고했다(이 브랜치 코드가 아직 로드되지 않았다는 뜻). 작업 요청 하나는 이 코드가 로드된 뒤 `probe-dispatch.mjs send`로 보낸다.

## 확인할 것

- 코디네이터 셸에서 돌린 `orca agent launch`가 Orca 화면에 코디네이터가 넘긴 것으로 나오는가, 새 작업자에게 훅의 작업자 권한 인자와 PATH의 bin이 들어가는가(`probe-dispatch.mjs send`, `verify`, `scripts/probe-path.mjs --match <표식>`).
- 받는 에이전트(Claude Code, Codex)가 `[사진 n] <경로>` 줄의 파일을 실제로 여는가.

- host `terminal.create`가 돌려주는 `terminalId`를 CLI `--from`에 그대로 쓸 수 있는가, 지금 권한으로 열 수 있는가.
- `agent.launch.before`의 `event.env`에 PATH가 어떤 키로 들어오는가. 다음 코디네이터 실행 때 워커 로그의 `launch hook: PATH keys in the launch env` 줄과 `scripts/probe-path.mjs`로 확인한다. 아예 없다면 훅은 PATH를 두고 `CB_BIN`과 charter의 절대 경로로만 CLI를 알린다.
- 터미널 세션이 `orchestration send` 메일을 기록에 어떤 모양으로 남기는가(보드 사실과 병합 알림이 터미널 세션에 갈 때).
- 실제 훅의 `event.command`가 `orca terminal list`의 `preview`와 같은 모양인가.
- 워커 env에서 `orca.exe`가 런타임을 찾는가.
