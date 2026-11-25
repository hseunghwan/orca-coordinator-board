// Labels for states and results, in both languages.
import type { T } from './i18n'
import type { AgentState, PullReason, PullStatus, ReplyStatus } from './model'

export function stateLabel(t: T, state: AgentState): string {
  switch (state) {
    case 'working': return t('작업 중', 'Working')
    case 'blocked': return t('권한 대기', 'Waiting for permission')
    case 'waiting': return t('답 기다림', 'Waiting for you')
    case 'done': return t('완료', 'Done')
  }
}

export const stateTone = { working: 'accent', blocked: 'warning', waiting: 'danger', done: 'success' } as const

export function pullReasonLabel(t: T, reason: PullReason): string {
  switch (reason) {
    case 'ready': return t('리뷰 가능', 'Ready for review')
    case 'draft': return t('초안', 'Draft')
    case 'conflict': return t('충돌', 'Conflict')
    case 'checks-failed': return t('검사 실패', 'Checks failed')
    case 'checks-pending': return t('검사 중', 'Checks running')
    case 'changes-requested': return t('수정 요청됨', 'Changes requested')
    case 'blocked': return t('병합 조건 미충족', 'Blocked')
    case 'auto-merge': return t('자동 병합 대기', 'Auto-merge on')
    case 'unknown': return t('상태 확인 필요', 'Needs a look')
  }
}

export function pullStatusNote(t: T, status: PullStatus): string | null {
  switch (status) {
    case 'ok': return null
    case 'truncated': return t('PR이 많아 일부만 보입니다.', 'Showing only some pull requests.')
    case 'unmapped': return t('origin 원격에서 GitHub 저장소를 찾지 못했습니다.', 'No GitHub repository found in the origin remote.')
    case 'unavailable': return t('PR을 읽지 못했습니다. gh 로그인 상태를 확인하세요.', 'Could not read pull requests. Check that gh is signed in.')
    case 'remote': return t('다른 호스트의 프로젝트는 PR을 읽지 않습니다.', 'Pull requests are not read for projects on another host.')
  }
}

export function replyStatusLabel(t: T, status: ReplyStatus): string {
  switch (status) {
    case 'sent': return t('보냈습니다.', 'Sent.')
    case 'empty': return t('보낼 내용이 없습니다.', 'Nothing to send.')
    case 'too-long': return t('답이 너무 깁니다. 8000자 이하로 줄이세요.', 'The reply is too long. Keep it under 8000 characters.')
    case 'gone': return t('세션을 찾을 수 없습니다.', 'The session is no longer there.')
    case 'permission': return t('권한 요청을 기다리는 세션이라 보내지 않았습니다. 세션에서 직접 처리하세요.', 'Not sent: the session is waiting for permission. Handle it in the session.')
    case 'busy': return t('세션이 작업 중이라 보내지 않았습니다. 끝나면 다시 보내세요.', 'Not sent: the session is working. Send again when it stops.')
    case 'changed': return t('세션 상태가 바뀌었습니다. 최근 출력을 다시 확인한 뒤 보내세요.', 'The session changed. Check its latest output, then send again.')
    case 'failed': return t('보내지 못했습니다.', 'Could not send.')
    case 'open': return t('이 세션이 지금 열려 있어 이어 열지 않았습니다. 열린 세션에서 답하세요.', 'Not resumed: the session is open now. Answer it where it runs.')
  }
}
