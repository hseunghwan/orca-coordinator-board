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
| `agent:launch` | 지금은 쓰지 않는다 |
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

## 전송 규칙

- 사용자가 쓰고 **보내기**를 누른 글만 보낸다. 그 글은 머리말 없이 그대로 타이핑된다.
- 보내기 직전에 워커가 에이전트 상태를 다시 읽는다. 권한 대기(`blocked`), 작업 중(`working`), 카드를 연 뒤 상태가 바뀐 세션에는 보내지 않는다.
- Orca는 지금 보고 있는 워크스페이스의 터미널에만 글을 넣게 한다. 그래서 보내기 직전에 그 세션을 화면에 띄운다. 사람이 **보내기**를 누른 경우에만 화면이 넘어간다.
- 닫힌 세션을 이어 열어 보내는 기능은 Paseo판에 없어서 뺐다.
- 실패해도 다시 보내지 않는다.
- 보드가 스스로 만든 문장을 보내는 기능은 아직 없다. 생기면 `[coordinator-board]` 머리말을 붙인다([AGENTS.md](AGENTS.md) 참고).

## Paseo판에 있고 여기엔 아직 없는 것

[Paseo판](https://github.com/devbrother2024/paseo-coordinator-board)에 있는 기능 가운데 아래는 아직 없다.


코디네이터 세션과 다이제스트, 워커 배정, 보드에서 PR 병합, 사진 첨부, 모델 라우팅, 다른 프로젝트 세션 링크. Orca는 아직 플러그인이 MCP 도구를 내놓을 수 없어서, 코디네이터가 보드에 판단을 돌려주는 길은 따로 설계해야 한다.

## 실기에서 확인한 Orca 동작 (1.4.272)

- `agents.list`의 `workspaceId`는 `workspace.list`가 주는 id다. 이벤트의 `workspaceId`는 다른 형식(`<uuid>::<경로>`)이라 쓰지 않는다.
- 터미널 수가 0인 워크스페이스에도 에이전트가 있다. 그래서 워크스페이스를 모두 조회한다.
- 터미널 id가 없는 에이전트는 채팅 탭(구조화 세션)이다. 플러그인 API에는 채팅 탭에 글을 넣는 함수가 없다. `agent.resume`은 같은 대화를 새 터미널에서 하나 더 띄우므로 열린 채팅 탭에는 쓰지 않는다. 대신 `workspace.open`으로 그 워크스페이스를 보여 준다. 플러그인은 채팅 탭이 열려 있는지 따로 알 수 없어서, `agents.list`에 있는 세션은 모두 열린 것으로 본다.
- `agents.list`가 `sessionId`를 주지 않는 창이 있다. 그런 창이 있는 워크스페이스의 지난 세션은 이어 열지 않는다.
- `agent.listSessions`는 `history:read`, `agent.resume`은 `agent:launch` 권한이 있어야 한다.
- `terminal.sendText`는 포커스된 워크스페이스의 터미널에만 보낸다(다른 곳이면 `terminal is outside the active worktree`). 보드는 먼저 `terminal.focus`를 부른다.
- Claude가 평문으로 묻고 턴을 끝내면 상태는 `done`이다. `waiting`은 `AskUserQuestion` 같은 도구로 물을 때 붙는다. 그래서 보드는 Paseo판처럼 `done` 세션의 마지막 답을 읽어(`orca agent read`) 확인 요청 문장이 있으면 사람 레인에 올린다.
- 워크스페이스 id는 `identity:...`, `folder:...`, `<프로젝트>::<경로>` 세 가지 꼴로 온다. 대시보드 명령은 id, 경로, 이름과 브랜치 순서로 포커스된 워크스페이스를 찾는다.
- 커스텀 에디터는 열린 뒤 `orca.document.get()`으로 파일을 한 번 요청해야 한다. 요청하지 않으면 Orca가 에디터를 다 열리지 않은 것으로 본다.
- 워커 프로세스에는 `APPDATA`와 `HOME`이 없다. Windows의 `gh`는 `%APPDATA%\\GitHub CLI`에서 로그인 정보를 읽으므로, 워커가 `USERPROFILE`로 채워서 실행한다(`commandEnv`).

## 실기에서 확인한 orca CLI 동작 (1.4.277)

- `orca worktree ps --json` 한 번에 워크스페이스, 에이전트, 터미널 주소(`term_…`), 마지막 턴 결과(`mainAgent.outcome`), 안 읽음(`activity.unread`)이 함께 온다. 보드는 스냅샷마다 이것을 한 번 읽는다.
- 처음 보고하기 전의 터미널 에이전트는 `orcaSessionId`가 없다. 보드는 이런 행을 세기만 하고 올리지 않는다.
- 터미널 세션의 `orca agent read`는 긴 항목을 약 1,200자에서 자르고 `… (truncated)`를 붙인다. 같은 세션의 `worktree ps` 행은 마지막 답을 통째로 주므로, 앞부분이 같으면 그 글로 되돌린다. 채팅 기록은 자르지 않는다.
- 같은 대화가 두 창에 보일 때가 있다. 보드는 목록에 보이는 쪽, 그다음 최근 쪽을 쓴다.

실제 세션으로 스냅샷을 만들어 보려면 `node scripts/probe-snapshot.mjs`를 돌린다. 모든 프로젝트를 고른 상태로 레인별 수, 사람 레인 세션, CLI 호출 수와 시간을 출력한다. 출력에 실제 세션 이름이 나오니 저장소에 남기지 않는다.

## 개발

```sh
npm ci                  # 개발 도구(typescript, esbuild, vitest 등)만 설치한다. 플러그인 실행에는 필요 없다
orca plugin types .     # .orca/types 생성 (git에 올리지 않음)
npm run build           # 워커와 대시보드를 dist/worker.mjs, dist/dashboard.js로 묶는다. 고치는 동안은 npm run watch
npm run typecheck       # npx tsc -p .
orca plugin test .      # 테스트 (vitest)
orca plugin check .     # 패널을 시나리오별로 그려 보고 대시보드를 정적 검사한다 (src/panel.check.ts)
orca plugin validate .
```

`dist/`는 저장소에 함께 올린다. git으로 설치하면 빌드 없이 돈다. `src/`를 고쳤으면 `npm run build` 결과도 같이 커밋한다. `src/paseo/`는 Paseo판 코드를 import 경로만 바꿔 옮긴 폴더다([src/paseo/UPSTREAM.md](src/paseo/UPSTREAM.md)).

에이전트용 규칙은 [AGENTS.md](AGENTS.md)에 있다.

## 출처와 라이선스

MIT 라이선스([LICENSE](LICENSE)).

- 이 플러그인은 DevBrothers의 [paseo-coordinator-board](https://github.com/devbrother2024/paseo-coordinator-board)(MIT)를 Orca용으로 옮긴 것이다. 보드 구성과 결정 카드 순서, 전송 규칙(사람이 쓴 글만, 권한 대기 세션에는 보내지 않음), PR 분류와 제목 정리(`server/prs.ts`)를 의존성 없이 `src/`에 다시 썼다. 원저작권 표기는 LICENSE에 그대로 둔다.
- `src/paseo/`는 같은 저장소의 판단 로직과 테스트를 그대로 옮긴 것이다. 함께 들어온 Marked와 Better Paseo의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있다.
- 기록은 그 저장소의 `orca/` 폴더에서 시작했고, 이 저장소로 옮길 때 커밋 기록을 유지했다.
- `tsconfig.json` 등 뼈대는 Orca(stablyai/orca, MIT)의 `orca plugin create` 템플릿에서 시작했다. `.orca/types`는 `orca plugin types`가 만드는 Orca 타입이라 저장소에 넣지 않는다.
