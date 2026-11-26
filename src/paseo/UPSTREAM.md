# Paseo에서 옮겨 온 코드

이 폴더의 `shared/`, `client/`, `test/`, `third-party/` 아래 파일은 [paseo-coordinator-board](https://github.com/devbrother2024/paseo-coordinator-board)의 같은 경로 파일을 옮긴 것이다(MIT).

Commit: `2e9d12884e8f1c312a956e47628a554c6874ce5a`

## 규칙

- 옮긴 파일은 import 경로만 고친다. 다른 줄을 고쳐야 하면 upstream에서 고친 뒤 다시 가져온다.
- 다시 가져오기: `node scripts/sync-paseo.mjs <upstream 체크아웃 경로>`. 아래 목록의 파일을 복사하고 import 경로를 바꾼 뒤 위 커밋 줄을 갱신한다. 그다음 `npm run typecheck`와 `orca plugin test .`를 돌린다.
- 바뀌는 import는 세 가지다.
  - `@getpaseo/plugin`, `@getpaseo/plugin/client`는 `plugin-shim.ts`로 간다.
  - React Native 화면 파일에만 있는 타입(`./language`, `./board-layout`, `./remote-running`)은 `view-types.ts`로 간다.
  - 테스트의 `bun:test`는 `vitest`로 간다. 둘 다 Jest의 `expect`를 따른다.
- 파일을 더 옮기려면 아래 목록에 한 줄 더하고 스크립트를 돌린다. `server/`나 `index.server.ts`를 부르는 테스트는 그 파일을 옮길 때 함께 옮긴다.

## 옮긴 파일

- `shared/board-facts.ts`
- `shared/clarifications.ts`
- `shared/contract.ts`
- `shared/decision-actions.ts`
- `shared/decision-count.ts`
- `shared/decision-priority.ts`
- `shared/dispatch.ts`
- `shared/github-repository.ts`
- `shared/hosts.ts`
- `shared/operations.ts`
- `shared/pages.ts`
- `shared/prs.ts`
- `shared/readiness.ts`
- `shared/recommendation.ts`
- `shared/reply-history.ts`
- `shared/session-links.ts`
- `shared/session-photos.ts`
- `shared/tracked-decisions.ts`
- `shared/usage-routing.ts`
- `shared/work-images.ts`
- `shared/workspace-pull.ts`
- `server/notes.ts`
- `server/preferences.ts`
- `server/snapshot-reads.ts`
- `client/decision-edit-order.ts`
- `client/decision-priority.ts`
- `client/decision-receipts.ts`
- `client/decision-reply-state.ts`
- `client/decision-row.ts`
- `client/decision-summary.ts`
- `client/focus-queue.ts`
- `client/focus-status.ts`
- `client/history-sessions.ts`
- `client/inbox.ts`
- `client/lane-width.ts`
- `client/matrix.ts`
- `client/merge-notification.ts`
- `client/model.ts`
- `client/project-icon.ts`
- `client/remote-sessions.ts`
- `client/route-options.ts`
- `client/send-shortcut.ts`
- `client/tone.ts`
- `client/tracked-session-targets.ts`
- `client/view-mode.ts`
- `client/work-photos.ts`
- `client/vendor/marked/marked.d.ts`
- `client/vendor/marked/marked.js`
- `test/decision-edit-order.test.ts`
- `test/decision-priority.test.ts`
- `test/decision-receipts.test.ts`
- `test/decision-row.test.ts`
- `test/decision-summary.test.ts`
- `test/focus-queue.test.ts`
- `test/focus-status.test.ts`
- `test/history-sessions.test.ts`
- `test/hosts.test.ts`
- `test/inbox.test.ts`
- `test/matrix.test.ts`
- `test/merge-notification-label.test.ts`
- `test/model.test.ts`
- `test/remote-running.test.ts`
- `test/route-options.test.ts`
- `test/send-shortcut.test.ts`
- `test/session-reply-draft.test.ts`
- `test/snapshot-reads.test.ts`
- `test/tone.test.ts`
- `test/tracked-session-targets.test.ts`
- `test/view-mode.test.ts`
- `test/work-photos.test.ts`
- `test/workspace-pull.test.ts`
- `third-party/better-paseo/LICENSE`
- `third-party/marked/LICENSE`
