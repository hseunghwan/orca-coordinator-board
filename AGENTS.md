# AGENTS.md

Orca 에이전트 세션을 프로젝트별로 모으고 사람이 내릴 결정을 한곳에 올리는 Orca 플러그인이다. 사용자 안내는 `README.md`가 정본이다. 이 파일은 그 문서에 없는 에이전트용 규칙만 담는다.

Tech Stack: TypeScript, Orca 플러그인 API(`orca-plugin.json`, `pluginApi` 1), Node(워커), esbuild(번들), vitest(테스트). 런타임 의존성은 없다. 워커와 대시보드는 쓰는 패키지까지 `dist/`에 묶는다.

## Operational Commands

- 개발 의존성: `npm ci`(typescript, @types/node, esbuild, zod, vitest). 잠금 파일은 `package-lock.json` 하나다.
- 빌드: `npm run build`(`dist/worker.mjs`, `dist/dashboard.js`). 고치는 동안은 `npm run watch`.
- Orca 타입: `orca plugin types .` (`.orca/types`, git에 올리지 않음)
- 타입 검사: `npm run typecheck`
- 테스트: `orca plugin test .`. `node_modules`에 vitest가 있으면 Orca가 vitest로 돌린다. 그래서 테스트의 `test`는 `vitest`에서 불러온다.
- 렌더 검사: `orca plugin check .`, manifest 검사: `orca plugin validate .`
- 커밋 전에는 빌드와 위 넷을 모두 통과시킨다. CI에는 Orca CLI가 없으니 로컬에서 돌린다.

## Golden Rules

### Immutable

- `terminal.sendText`는 사람이 친 글과 구분되지 않는다. 그래서 출처 표시 없는 전송은 사용자가 화면에서 쓰고 보내기를 누른 글에만 쓴다. 보드가 만든 문장을 보내는 경로를 만들면 `[coordinator-board]` 머리말을 붙이고, 실패해도 다시 보내지 않는다.
- 권한 대기 세션에는 보내지 않는다. 전송 직전에 `agents.list`로 상태를 다시 읽고 `replyGuard`(`src/model.ts`)를 거친다.
- 같은 대화를 두 곳에서 돌리지 않는다. `agent.resume`은 `closedSessions`와 `resumeGuard`(`src/model.ts`)를 거친 닫힌 세션에만, 사람이 보내기를 누른 경로에서만 쓴다. 채팅 탭 세션(터미널 id 없음)은 `workspace.open`으로 보여 주기만 한다.
- 플러그인 승인(`--approve`)은 사람이 권한 목록을 보고 직접 한다. 에이전트가 대신 승인하지 않는다.
- 공개 저장소다. 코드, 테스트 고정값, 문서, 커밋 메시지에 개인 이름, 사용자 홈 경로, 기기 이름, 사내 주소, 토큰을 넣지 않는다. 예시 값은 `acme/app`, `/w/app`처럼 지어낸다.

### Do

- 판단 로직은 `src/model.ts`, `github.ts`, `labels.ts`, `summary.ts`에 두고, `panel.tsx`와 `src/dashboard/`에는 화면만 둔다. 테스트는 `dashboard/`를 불러오지 않는다(테스트 경계).
- 대시보드(`src/dashboard/`)는 편집 탭의 프레임이라 DOM을 직접 만든다. 글은 `dom.ts`의 `h()`로 텍스트 노드로만 넣고 `innerHTML`을 쓰지 않는다.
- 대시보드 열쇠 파일(`.coordinator-board/`)은 `.git/info/exclude`로 숨기고, 사용자 저장소에 `.gitignore`를 새로 만들지 않는다.
- Orca는 포커스된 워크스페이스의 터미널에만 글을 넣게 한다. 보내기 전 `terminal.focus`로 화면을 옮기는 일은 사람이 보내기를 누른 경로에서만 한다.
- 외부 명령(`git`, `gh`)은 `shell:false`, 시간 제한, `maxBuffer`, 대화형 프롬프트를 끈 환경 변수로 실행하고 인자는 배열로 넘긴다(`src/worker.ts`의 `run`).
- GitHub에서 읽은 글과 터미널 출력은 화면에 내기 전에 제어 문자와 양방향 제어 문자를 지우고 길이를 자른다(`src/model.ts`의 `cleanLine`).
- 화면 문구는 `t(한국어, 영어)`로 두 언어를 함께 쓴다. 한쪽만 바꾸지 않는다.
- `src/paseo/`는 Paseo판 코드를 옮긴 폴더다. 옮긴 파일은 import 경로만 고친다. 다른 줄을 바꿔야 하면 upstream에서 고친 뒤 `node scripts/sync-paseo.mjs <체크아웃>`으로 다시 가져온다(`src/paseo/UPSTREAM.md`).
- `dist/`는 git에 올린다. git으로 설치하면 빌드 없이 돌기 때문이다. `src/`를 고쳤으면 커밋 전에 `npm run build`를 돌리고 `dist/`도 함께 커밋한다.

### Don't

- 플러그인 폴더 밖을 불러오지 않는다. Orca 플러그인에는 `node_modules`가 없으니 npm 패키지는 `devDependencies`에만 두고 번들로 넣는다.
- 사이드바 패널(`src/panel.tsx`)은 Orca가 소스를 그대로 불러온다. 그래서 npm 패키지와 그것을 쓰는 `src/paseo/` 파일을 불러오지 않는다.
- `dist/`를 손으로 고치지 않는다.
- 권한(`capabilities`)을 바꾸면 새 승인이 필요하다. 바꾸기 전에 사람에게 알린다.

## Standards & References

- 한국어 문서와 화면 문구에 em dash를 쓰지 않는다. 마침표, 쉼표, 쌍점, 괄호로 바꾼다.
- 커밋 제목은 한국어 한 줄로, 명사형으로 끝낸다(예: "답장 카드의 최근 출력을 끝부분부터 표시").
- 사용자에게 보이는 기능을 바꾸면 `README.md`를 함께 고치고 `orca-plugin.json`의 `version`을 올린다.
