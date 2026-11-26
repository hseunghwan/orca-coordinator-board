# Coordinator Board for Orca

Orca 에이전트 세션을 프로젝트별로 모으고, 사람이 답하거나 승인해야 할 세션을 한곳에 올리는 Orca 플러그인(MVP)이다. Paseo용 [코디네이터 보드](https://github.com/devbrother2024/paseo-coordinator-board)를 Orca로 옮겨 왔다(아래 "출처와 라이선스").

보드는 세 곳에 나온다.

- **상태바**: Paseo판과 같은 식으로 센 내 결정 수(사람 레인 세션과 리뷰 가능한 PR)를 보여 준다. 누르면 대시보드가 열린다.
- **대시보드**: 편집 영역에 전체 폭 탭으로 열린다. 왼쪽에 내 결정 카드, 오른쪽에 프로젝트별 진행 카드가 놓인다. 상태바를 누르거나 명령 팔레트에서 `Coordinator Board: Open dashboard`를 실행한다.
- **오른쪽 사이드바 패널**: 내 결정 수와 먼저 볼 결정 세 개, **보드 열기** 버튼만 둔다.

## 설치

Orca 1.4.259 이상이 필요하다. 코드를 실행하는 플러그인이라 개발 폴더로 불러온다.

```sh
git clone https://github.com/hseunghwan/orca-coordinator-board.git
cd orca-coordinator-board
orca plugin dev load .
```

Orca가 권한 목록과 `orca plugin dev reload <폴더> --approve <fingerprint>` 명령을 보여 준다. 목록을 확인한 사람이 직접 승인한다. 그 뒤 오른쪽 사이드바의 **Coordinator Board** 패널이나 상태바 항목을 눌러 보드에 모을 프로젝트를 고른다. PR 목록은 이 컴퓨터에 로그인된 `gh`로 읽는다(없으면 PR만 비어 보인다).

### 요청하는 권한

| 권한 | 쓰는 곳 |
| --- | --- |
| `storage:own` | 상태바 문구의 언어 |
| `workspace:read` | 프로젝트, 워크스페이스, 터미널 목록 |
| `agent:read` | 에이전트 상태(권한 대기, 답 기다림, 작업 중, 완료) |
| `terminal:read` | 답 기다림 카드에 보이는 터미널 최근 출력 |
| `terminal:send` | 사람이 쓰고 보내기를 누른 답장 입력 |
| `workspace:write` | 세션 터미널로 화면 옮기기, 채팅 워크스페이스 열기, 대시보드 파일 열기 |
| `agent:launch` | 지금은 쓰지 않는다(코디네이터는 `orca agent launch` CLI로 띄운다) |
| `history:read` | 지금은 쓰지 않는다 |

상태바 갱신은 권한이 필요 없다. 세션 목록과 대화는 Orca CLI(`orca worktree ps`, `orca repo list`, `orca agent read`)로 읽는다. 워커가 Orca에 들어 있는 `orca.exe`를 셸 없이 실행한다.

보드가 고른 프로젝트, 코디네이터, 메모와 답장 영수증은 `~/.orca-coordinator-board/`(`scope.json`, `notes.json`)에 둔다. Paseo판의 `~/.paseo/plugin-data/coordinator-board/`와 같은 파일 형식이다.

## 하는 일

- **내 결정**: 고른 프로젝트에서 사람을 기다리는 세션을 한 목록에 올린다. 권한 대기, 답 기다림, 리뷰 가능한 PR 순서이고, 같은 종류 안에서는 오래 기다린 것이 먼저다.
  - 답 기다림 카드는 세션 터미널의 최근 출력을 보여 주고, 답장을 그 세션에 보낸다. **확인함**을 누르면 세션 상태가 바뀔 때까지 숨긴다.
  - 채팅 탭에서 도는 세션은 터미널이 없어 답장 칸 대신 **채팅 열기**만 있다. 그 워크스페이스를 열어 주면 사람이 채팅에서 직접 답한다.
  - 권한 대기 카드는 답장 칸이 없다. **세션 열기**로 가서 직접 승인하거나 거절한다.
- **세션 진행**: 프로젝트별 세션 상태와 열린 PR을 보여 준다. 완료(`done`) 세션은 여기에만 나온다. 항목을 누르면 그 터미널로 간다.
- **프로젝트**: 보드에 모을 Orca 프로젝트를 고른다.

## 대시보드가 여는 파일

Orca 플러그인은 편집 영역에 자기 화면을 직접 띄울 수 없다. 그래서 대시보드는 `.coordinator-board` 파일 전용 에디터로 만들었다. 대시보드를 열면 워커가 지금 보고 있는 워크스페이스에 `.coordinator-board/board.coordinator-board`를 쓰고 그 파일을 연다.

- 파일에는 보드 데이터가 없다. 탭을 여는 열쇠일 뿐이고, 내용은 모두 워커에서 읽는다.
- git checkout이면 `.git/info/exclude`에 `/.coordinator-board/` 한 줄을 더해 git에 잡히지 않게 한다. `.gitignore`는 만들지 않는다.
- 다른 호스트(SSH 등)의 워크스페이스에서는 열지 않는다.
- 세션을 누르면 그 세션의 워크스페이스로 화면이 바뀐다. 대시보드 탭은 처음 연 워크스페이스에 남는다.
- 화면 배치는 Paseo판 보드와 같다. 보기는 인박스(기본), 집중, 매트릭스, 기존 가운데 고르고, 보기와 보드 언어(한국어 기본, English)는 이 기기에 저장된다.
- 결정 카드에서 담당 세션에 바로 답장한다. 보내기 단축키는 macOS에서 ⌘+Enter, 그 밖에서는 Ctrl+Enter다. 긴 추천 답장은 **답장 전문 보기**로 펼쳐 읽어야 보낼 수 있다.
- **질문하기**로 결정 전에 그 세션에 물어볼 수 있고, 문답은 카드 아래에 쌓인다.
- **집중** 보기는 가장 급한 결정 한 건만 크게 띄운다. 위의 막대가 남은 결정과 처리한 결정을 보여 준다. J는 다음, K는 이전 결정으로 가고, S는 지금 결정을 이번 방문 동안만 맨 뒤로 미룬다. 입력창에 쓰는 동안에는 이 키를 듣지 않는다. 맨 아래 줄은 프로젝트별로 진행 중인 세션을 보여 주고, **진행 보기**로 세션 진행과 기록을 연다.
- **매트릭스** 보기는 위의 띠에 결정을 급한 순서로 놓고, 아래 표에 프로젝트마다 내 결정, 진행 중, 확인 대기, 대기 중, 완료 칸을 둔다. 칸을 누르면 그 줄 아래에 카드가 펼쳐진다. 호스트 칸은 이 기기의 세션 수만 센다. 좁은 화면에서는 프로젝트별로 접고 편다.
- 보낸 답장은 그 자리에 영수증으로 남는다. 지난 답장은 인박스의 **기록** 탭과 기존 보기의 **최근 결정 기록**에서 다시 본다.

- **코디네이터에 요청**을 누르면 코디네이터 패널이 열린다. 코디네이터가 있으면 일을 맡기거나 다이제스트를 요청하고, 없으면 추천 설정과 시작할 워크스페이스를 골라 새로 시작한다. 결정 카드의 **코디네이터에 추천 요청**과 **코디네이터에 조율 요청**도 코디네이터가 있을 때 쓸 수 있다.
- 설정에서 기존 세션을 코디네이터로 지정하거나 해제하고, **새 코디네이터로 교체…**로 바꾼다. Orca는 플러그인이 사이드바 고정을 바꾸게 하지 않아 고정 설정은 없다.
- 사진 첨부와 사실 질문 자동 답장은 다음 단계에서 붙는다.

## 코디네이터

- **만들기**: 설정에서 고른 모델로 코디네이터를 `orca agent launch --surface terminal`로 띄운다. Orca에는 플러그인 전용 폴더가 없어서, 고른 워크스페이스(고르지 않으면 지금 보고 있는 곳)에서 시작한다. 응답이 끊겨도 같은 실행을 `--retry-launch`로만 다시 확인하고 두 개를 띄우지 않는다. 터미널이 첫 응답을 하면 보드가 코디네이터로 지정한다. 워크스페이스 고정은 Orca에 없어서 하지 않는다.
- **권한 모드**: 코디네이터는 권한 우회 모드로 띄운다(claude `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`). 에이전트 설정이 이미 붙였으면 그대로 두고, 없으면 한 번 붙인다. Paseo판의 자동 모드(`auto`, `auto-review`)와 다른 점이다.
- **보고 명령**: Orca 플러그인은 MCP 도구를 줄 수 없어서, 코디네이터는 셸 명령 `coordinator-board`로 보드를 읽고 판단을 남긴다. 모든 에이전트 실행에 `agent.launch.before` 훅이 `PATH`와 `CB_*` 변수, 그 터미널 전용 토큰을 넣는다. 명령은 `read [--session]`, `classify`, `report`이고 `plan`, `assign`, `fact`, `review`는 아직 없다. 자세한 쓰임은 `coordinator-board --help`.
- **요청**: 다이제스트, 작업 요청, 추천 요청을 코디네이터에게 보낸다. Orca는 실행 중인 턴에 끼워 넣을 수 없어서 코디네이터가 대기 중일 때만 보낸다. 보드가 쓴 요청에는 `[coordinator-board]` 머리말이 붙는다.
- **채팅 코디네이터**: 기존 채팅 세션을 코디네이터로 고르면 보드가 명령 경로를 한 번 알린다. 채팅은 실행 훅을 거치지 않아 `report`만 쓸 수 있다.
- 채팅 메일을 보내는 보드 터미널은 코디네이터가 있으면 그 워크스페이스에 둔다.

## 전송 규칙

- 사용자가 쓰고 **보내기**를 누른 글만 보낸다. 그 글은 머리말 없이 그대로 타이핑된다.
- 보내기 직전에 워커가 에이전트 상태를 다시 읽는다. 권한 대기(`blocked`), 작업 중(`working`), 카드를 연 뒤 상태가 바뀐 세션에는 보내지 않는다.
- 터미널 세션에는 `orca terminal send`로 보낸다. 세션이 다른 워크스페이스에 있어도 들어가므로 화면을 옮기지 않는다.
- 닫힌 세션을 이어 열어 보내는 기능은 Paseo판에 없어서 뺐다.
- 실패해도 다시 보내지 않는다.
- 보드가 스스로 만든 문장을 보내는 기능은 아직 없다. 생기면 `[coordinator-board]` 머리말을 붙인다([AGENTS.md](AGENTS.md) 참고).

## Paseo판에 있고 여기엔 아직 없는 것

[Paseo판](https://github.com/devbrother2024/paseo-coordinator-board)에 있는 기능 가운데 아래는 아직 없다.


워커 배정, 보드 사실 답하기와 기록 정리, 보드에서 PR 병합, 사진 첨부, 다른 프로젝트 세션 링크.

## 실기에서 확인한 Orca 동작 (1.4.272)

- `agents.list`의 `workspaceId`는 `workspace.list`가 주는 id다. 이벤트의 `workspaceId`는 다른 형식(`<uuid>::<경로>`)이라 쓰지 않는다.
- 터미널 수가 0인 워크스페이스에도 에이전트가 있다. 그래서 워크스페이스를 모두 조회한다.
- 터미널 id가 없는 에이전트는 채팅 탭(구조화 세션)이다. 플러그인 API에는 채팅 탭에 글을 넣는 함수가 없다. `agent.resume`은 같은 대화를 새 터미널에서 하나 더 띄우므로 열린 채팅 탭에는 쓰지 않는다. 대신 `workspace.open`으로 그 워크스페이스를 보여 준다. 플러그인은 채팅 탭이 열려 있는지 따로 알 수 없어서, `agents.list`에 있는 세션은 모두 열린 것으로 본다.
- `agents.list`가 `sessionId`를 주지 않는 창이 있다. 그런 창이 있는 워크스페이스의 지난 세션은 이어 열지 않는다.
- `agent.listSessions`는 `history:read`, `agent.resume`은 `agent:launch` 권한이 있어야 한다.
- 0.3.0부터 `agent.launch.before` 훅을 쓴다. 이 버전으로 올리면 권한 목록이 바뀌어 다시 승인해야 한다.
- `terminal.sendText`는 포커스된 워크스페이스의 터미널에만 보낸다(다른 곳이면 `terminal is outside the active worktree`). CLI `orca terminal send`에는 이 제한이 없어서 보드는 CLI로만 보낸다.
- Claude가 평문으로 묻고 턴을 끝내면 상태는 `done`이다. `waiting`은 `AskUserQuestion` 같은 도구로 물을 때 붙는다. 그래서 보드는 Paseo판처럼 `done` 세션의 마지막 답을 읽어(`orca agent read`) 확인 요청 문장이 있으면 사람 레인에 올린다.
- 워크스페이스 id는 `identity:...`, `folder:...`, `<프로젝트>::<경로>` 세 가지 꼴로 온다. 대시보드 명령은 id, 경로, 이름과 브랜치 순서로 포커스된 워크스페이스를 찾는다.
- 커스텀 에디터는 열린 뒤 `orca.document.get()`으로 파일을 한 번 요청해야 한다. 요청하지 않으면 Orca가 에디터를 다 열리지 않은 것으로 본다.
- 워커 프로세스에는 `APPDATA`와 `HOME`이 없다. Windows의 `gh`는 `%APPDATA%\\GitHub CLI`에서 로그인 정보를 읽으므로, 워커가 `USERPROFILE`로 채워서 실행한다(`commandEnv`).

## 실기에서 확인한 orca CLI 동작 (1.4.277)

- `orca worktree ps --json` 한 번에 워크스페이스, 에이전트, 터미널 주소(`term_…`), 마지막 턴 결과(`mainAgent.outcome`), 안 읽음(`activity.unread`)이 함께 온다. 보드는 스냅샷마다 이것을 한 번 읽는다.
- 처음 보고하기 전의 터미널 에이전트는 `orcaSessionId`가 없다. 보드는 이런 행을 세기만 하고 올리지 않는다.
- 터미널 세션의 `orca agent read`는 긴 항목을 약 1,200자에서 자르고 `… (truncated)`를 붙인다. 같은 세션의 `worktree ps` 행은 마지막 답을 통째로 주므로, 앞부분이 같으면 그 글로 되돌린다. 채팅 기록은 자르지 않는다.
- 같은 대화가 두 창에 보일 때가 있다. 보드는 목록에 보이는 쪽, 그다음 최근 쪽을 쓴다.

코디네이터 채널은 `node scripts/probe-channel.mjs`로 확인한다(빌드 뒤). 실제 워커 코드의 실행 훅을 부르고 그 env로 `bin/coordinator-board`를 실행해 종료 코드를 출력한다. 보드 데이터는 임시 폴더에 둔다.

실제 세션으로 스냅샷을 만들어 보려면 `node scripts/probe-snapshot.mjs`를 돌린다. 모든 프로젝트를 고른 상태로 레인별 수, 사람 레인 세션, CLI 호출 수와 시간을 출력한다. 출력에 실제 세션 이름이 나오니 저장소에 남기지 않는다.

## 개발

```sh
npm ci                  # 개발 도구(typescript, esbuild, vitest 등)만 설치한다. 플러그인 실행에는 필요 없다
orca plugin types .     # .orca/types 생성 (git에 올리지 않음)
npm run build           # 워커, 코디네이터 명령, 대시보드를 dist/worker.mjs, dist/cli.cjs, dist/dashboard.js로 묶고, 대시보드 탭이 여는 dist/dashboard.html을 쓴다. 고치는 동안은 npm run watch
npm run typecheck       # npx tsc -p .
orca plugin test .      # 테스트 (vitest)
orca plugin check .     # 패널을 시나리오별로 그려 보고 대시보드를 정적 검사한다 (src/panel.check.ts)
orca plugin validate .
node dev/build.mjs      # 가짜 window.orca와 예시 보드로 대시보드를 dev/out/index.html에 묶는다
node dev/shoot.mjs      # 로컬 Chrome이나 Edge 헤드리스로 dev/shots/에 화면을 찍는다. 이름 패턴을 주면 그 화면만 찍는다(예: node dev/shoot.mjs reply)
```

`dist/`는 저장소에 함께 올린다. git으로 설치하면 빌드 없이 돈다. `src/`를 고쳤으면 `npm run build` 결과도 같이 커밋한다. `src/paseo/`는 Paseo판 코드를 import 경로만 바꿔 옮긴 폴더다([src/paseo/UPSTREAM.md](src/paseo/UPSTREAM.md)).

에이전트용 규칙은 [AGENTS.md](AGENTS.md)에 있다.

## 출처와 라이선스

MIT 라이선스([LICENSE](LICENSE)).

- 이 플러그인은 DevBrothers의 [paseo-coordinator-board](https://github.com/devbrother2024/paseo-coordinator-board)(MIT)를 Orca용으로 옮긴 것이다. 보드 구성과 결정 카드 순서, 전송 규칙(사람이 쓴 글만, 권한 대기 세션에는 보내지 않음), PR 분류와 제목 정리(`server/prs.ts`)를 의존성 없이 `src/`에 다시 썼다. 원저작권 표기는 LICENSE에 그대로 둔다.
- `src/paseo/`는 같은 저장소의 판단 로직과 테스트를 그대로 옮긴 것이다. 함께 들어온 Marked와 Better Paseo의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있다.
- 기록은 그 저장소의 `orca/` 폴더에서 시작했고, 이 저장소로 옮길 때 커밋 기록을 유지했다.
- `tsconfig.json` 등 뼈대는 Orca(stablyai/orca, MIT)의 `orca plugin create` 템플릿에서 시작했다. `.orca/types`는 `orca plugin types`가 만드는 Orca 타입이라 저장소에 넣지 않는다.
