# Coordinator Board for Orca

Orca용 코디네이터 보드(MVP)다. Paseo 플러그인([../README.md](../README.md))과 같은 저장소에 있지만 따로 설치하고 따로 버전을 매긴다.

## 하는 일

- **내 결정**: 고른 프로젝트에서 사람을 기다리는 세션을 한 목록에 올린다. 권한 대기, 답 기다림, 리뷰 가능한 PR 순서이고, 같은 종류 안에서는 오래 기다린 것이 먼저다.
  - 답 기다림 카드는 세션 터미널의 최근 출력을 보여 주고, 답장을 그 세션에 보낸다. **확인함**을 누르면 세션 상태가 바뀔 때까지 숨긴다.
  - 권한 대기 카드는 답장 칸이 없다. **세션 열기**로 가서 직접 승인하거나 거절한다.
- **세션 진행**: 프로젝트별 세션 상태와 열린 PR을 보여 준다. 완료(`done`) 세션은 여기에만 나온다. 항목을 누르면 그 터미널로 간다.
- **프로젝트**: 보드에 모을 Orca 프로젝트를 고른다.

## 전송 규칙

- 사용자가 쓰고 **보내기**를 누른 글만 보낸다. 그 글은 머리말 없이 그대로 타이핑된다.
- 보내기 직전에 워커가 에이전트 상태를 다시 읽는다. 권한 대기(`blocked`), 작업 중(`working`), 카드를 연 뒤 상태가 바뀐 세션에는 보내지 않는다.
- 실패해도 다시 보내지 않는다.
- 보드가 스스로 만든 문장을 보내는 기능은 아직 없다. 생기면 `[coordinator-board]` 머리말을 붙인다(`../AGENTS.md` 참고).

## Paseo판에 있고 여기엔 아직 없는 것

코디네이터 세션과 다이제스트, 워커 배정, 보드에서 PR 병합, 사진 첨부, 모델 라우팅, 다른 프로젝트 세션 링크. Orca는 아직 플러그인이 MCP 도구를 내놓을 수 없어서, 코디네이터가 보드에 판단을 돌려주는 길은 따로 설계해야 한다.

## 실기에서 확인한 Orca 동작 (1.4.272)

- `agents.list`의 `workspaceId`는 `workspace.list`가 주는 id다. 이벤트의 `workspaceId`는 다른 형식(`<uuid>::<경로>`)이라 쓰지 않는다.
- 터미널 수가 0인 워크스페이스에도 에이전트가 있다. 그래서 워크스페이스를 모두 조회한다.
- 터미널 id가 없는 에이전트가 있다. 이런 세션은 열기와 답장이 안 되고, 세션 진행에만 보인다.
- 워커 프로세스에는 `APPDATA`와 `HOME`이 없다. Windows의 `gh`는 `%APPDATA%\\GitHub CLI`에서 로그인 정보를 읽으므로, 워커가 `USERPROFILE`로 채워서 실행한다(`commandEnv`).

## 개발

```sh
npm ci                      # 저장소 루트에서. orca/tsconfig.json이 루트의 @types/node를 쓴다
orca plugin types orca      # orca/.orca/types 생성 (git에 올리지 않음)
npx tsc -p orca             # 타입 검사
orca plugin test orca       # 테스트
orca plugin check orca      # 패널을 시나리오별로 그려 본다 (src/panel.check.ts)
orca plugin validate orca
```

설치해서 써 볼 때는 `orca plugin dev load orca`를 실행한다. 코드를 실행하는 플러그인이라 Orca가 권한 목록과 `--approve <fingerprint>` 명령을 보여 준다. 목록을 확인한 사람이 직접 승인한다.

요청하는 권한: `storage:own`, `workspace:read`, `agent:read`, `terminal:read`, `terminal:send`, `workspace:write`(터미널 포커스).
