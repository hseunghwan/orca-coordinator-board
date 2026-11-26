# AGENTS.md

Orca 에이전트 세션을 프로젝트별로 모으고 사람이 내릴 결정을 한곳에 올리는 Orca 플러그인이다. 사용자 안내는 `README.md`가 정본이다. 이 파일은 그 문서에 없는 에이전트용 규칙만 담는다.

Tech Stack: TypeScript, Orca 플러그인 API(`orca-plugin.json`, `pluginApi` 1), Node(워커), React 19(대시보드), esbuild(번들), vitest(테스트). 런타임 의존성은 없다. 워커와 대시보드는 쓰는 패키지까지 `dist/`에 묶는다.

## Operational Commands

- 개발 의존성: `npm ci`(typescript, @types/node, esbuild, zod, vitest, react, react-dom). 잠금 파일은 `package-lock.json` 하나다.
- 빌드: `npm run build`(`dist/worker.mjs`, `dist/dashboard.js`, 대시보드 entry `dist/dashboard.html`). Orca는 선언된 프레임 entry를 확장자와 상관없이 HTML 문서로 읽으므로 entry를 `.js`로 두지 않는다. 고치는 동안은 `npm run watch`.
- Orca 타입: `orca plugin types .` (`.orca/types`, git에 올리지 않음)
- 타입 검사: `npm run typecheck`
- 실기 확인: `node scripts/probe-snapshot.mjs`(실제 orca CLI로 스냅샷을 만든다. 출력에 실제 세션 이름이 나오니 커밋하지 않는다).
- 전송 실기 확인: `node scripts/probe-send.mjs --session <id> --yes [--from <term_…>]`(실제 워커 경로로 답장 하나를 보낸다. 사람이 시험용으로 정한 세션에만 쓴다). 에이전트 셸에서 돌리면 그 터미널이 발신자가 되므로 워커의 경우를 보려면 터미널 밖 프로세스로 띄운다.
- 테스트: `orca plugin test .`. `node_modules`에 vitest가 있으면 Orca가 vitest로 돌린다. 그래서 테스트의 `test`는 `vitest`에서 불러온다.
- 렌더 검사: `orca plugin check .`, manifest 검사: `orca plugin validate .`
- 대시보드 하네스: `node dev/build.mjs`로 가짜 `window.orca`와 예시 보드를 `dev/out/index.html`에 묶고, `node dev/shoot.mjs`로 로컬 Chrome이나 Edge 헤드리스 화면을 `dev/shots/`에 찍는다. 둘 다 git에 올리지 않는다. 하네스 타입 검사는 `npx tsc -p dev`. 가짜 워커는 답장을 확인됨, 전송 미확인, 다른 수신자의 영수증 순서로 돌려 답한다. 주소의 `send=<n>`으로 시작 위치를 고르고, `press=`는 보이는 버튼만 누른다. `press=`의 `@<접근성 이름>=<글>`은 그 입력창에 글을 넣는다. `coord=1`은 코디네이터가 있는 보드로 열고, `fail=1`은 코디네이터 요청과 시작을 실패시킨다. 워커가 `board.operations`에 `workspaces`를 주면 코디네이터를 시작할 워크스페이스를 고를 수 있다(`src/dashboard/rpc.ts`의 Orca 확장 계약).
- 커밋 전에는 빌드와 위 넷을 모두 통과시킨다. CI에는 Orca CLI가 없으니 로컬에서 돌린다.

## Golden Rules

### Immutable

- `terminal.sendText`는 사람이 친 글과 구분되지 않는다. 그래서 출처 표시 없는 전송은 사용자가 화면에서 쓰고 보내기를 누른 글에만 쓴다. 보드가 만든 문장을 보내는 경로를 만들면 `[coordinator-board]` 머리말을 붙이고, 실패해도 다시 보내지 않는다.
- 보내기는 `fleet.deliver`(`src/orca/deliver.ts`)로만 한다. outbox에 시도를 먼저 쓰고, 같은 messageId는 다시 보내지 않고 받는 쪽 기록으로 대조만 한다. 권한 대기, 질문 대기, 작업 중인 세션에는 보내지 않고, 전송 직전에 세션 상태를 다시 읽는다.
- 같은 대화를 두 곳에서 돌리지 않는다. 보드는 세션을 이어 열지(`agent.resume`) 않는다. 채팅 세션과 터미널이 잠든 세션은 `workspace.open`으로 보여 주기만 한다.
- 플러그인 승인(`--approve`)은 사람이 권한 목록을 보고 직접 한다. 에이전트가 대신 승인하지 않는다.
- 공개 저장소다. 코드, 테스트 고정값, 문서, 커밋 메시지에 개인 이름, 사용자 홈 경로, 기기 이름, 사내 주소, 토큰을 넣지 않는다. 예시 값은 `acme/app`, `/w/app`처럼 지어낸다.

### Do

- 판단 로직은 옮긴 Paseo 코드(`src/paseo/`, `src/server/`)에 두고, `panel.tsx`에는 화면만 둔다. 대시보드가 스냅샷에서 계산하는 것은 `src/dashboard/board-model.ts`에 두고 테스트한다. 테스트는 `.tsx` 화면 파일을 불러오지 않는다(테스트 경계).
- Orca 상태는 `src/orca/index.ts`의 `Fleet`로만 읽는다. Orca 행을 Paseo 상태로 바꾸는 레인 표는 `src/orca/view.ts` 한 곳에 있다. `src/server/`의 파일은 Paseo 파일을 고쳐 옮긴 것이라 첫 줄에 원본 경로와 커밋, 바꾼 점을 적는다.
- `orca` CLI는 `src/orca/cli.ts`로만 실행한다. `orca.exe`를 셸 없이, 허용 목록 환경으로 실행한다. 읽기는 `read`, 보내는 명령은 `write`(캐시, 공유, 재시도 없음)로만 한다.
- 대시보드(`src/dashboard/`)는 편집 탭의 프레임이고 React 19로 그린다. 화면 구조는 Paseo판 `client/*.tsx`를 따르고, 모양은 `src/dashboard/ui/`의 Orca 레시피(`--orca-*` 토큰)로 입힌다. 글은 React 텍스트로만 넣고 `innerHTML`과 `dangerouslySetInnerHTML`을 쓰지 않는다. 마크다운은 `marked` 토큰을 요소로 바꾼다(`ui/markdown.tsx`).
- 대시보드 `.tsx` 첫 줄의 `/** @jsxImportSource react */`는 지우지 않는다. tsconfig의 기본 JSX는 사이드바 패널용 `orca`다.
- 대시보드는 워커를 Paseo 계약(`src/paseo/shared/contract.ts` 등의 `defineRpc`)으로 부른다. `src/dashboard/rpc.ts`의 `call`이 출력을 zod로 검사한다. 워커가 보내는 `board.changed`는 다시 읽으라는 신호일 뿐이다.
- 대시보드 열쇠 파일(`.coordinator-board/`)은 `.git/info/exclude`로 숨기고, 사용자 저장소에 `.gitignore`를 새로 만들지 않는다.
- Orca는 포커스된 워크스페이스의 터미널에만 글을 넣게 한다. 보내기 전 `terminal.focus`로 화면을 옮기는 일은 사람이 보내기를 누른 경로에서만 한다.
- 외부 명령(`git`, `gh`)은 `shell:false`, 시간 제한, `maxBuffer`, 대화형 프롬프트를 끈 환경 변수로 실행하고 인자는 배열로 넘긴다(`src/github.ts`의 `run`).
- GitHub에서 읽은 글은 화면에 내기 전에 제어 문자와 양방향 제어 문자를 지우고 길이를 자른다(`src/server/prs.ts`의 `parseOpenPulls`).
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
