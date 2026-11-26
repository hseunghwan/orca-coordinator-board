// Who is calling the channel, from what the CLI says and what Orca reports now.
import type { SessionId, World } from '../orca'
import type { CallerClaim } from './protocol'
import { tokenMatches } from './hook'

/** terminal: proven by the launch token. chat: a chat's own word, enough only for report. */
export type Caller = { sessionId: SessionId; via: 'terminal' | 'chat' }

export function identifyCaller(claim: CallerClaim, secret: string, world: World): Caller | { denied: string } {
  if (claim.terminal && claim.token) {
    if (!tokenMatches(secret, claim.terminal, claim.token)) return { denied: '이 터미널의 보드 토큰이 맞지 않습니다. 보드가 띄운 에이전트 터미널에서 실행하세요.' }
    // After /clear a terminal reports a new session; the latest one is the caller.
    const session = [...world.sessions.values()].filter((s) => s.handle === claim.terminal).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return session ? { sessionId: session.id, via: 'terminal' } : { denied: '이 터미널의 세션을 Orca에서 아직 찾지 못했습니다. 첫 응답 뒤에 다시 실행하세요.' }
  }
  if (claim.session) {
    const session = world.sessions.get(claim.session as SessionId)
    if (session?.surface === 'chat') return { sessionId: session.id, via: 'chat' }
  }
  return { denied: '호출한 세션을 확인할 수 없습니다. 보드가 띄운 에이전트 터미널에서 실행하세요.' }
}
