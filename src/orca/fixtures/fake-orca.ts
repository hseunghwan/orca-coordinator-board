// An in-memory Orca behind the CLI runner, for tests that send: sessions with states, transcripts that
// grow when something is sent, mail framing as Orca writes it, and the terminal transcript's cut.
// Every id and text here is made up.
import { readFileSync } from 'node:fs'
import type { Runner } from '../cli'
import { TRUNCATED } from '../conversation'

export type FakeSession = {
  id: string
  surface: 'terminal' | 'chat'
  state: 'working' | 'blocked' | 'waiting' | 'done'
  updatedAt: number
  title?: string
  handle?: string
  livePty?: boolean
  hostId?: string
  project?: string
}
type Entry = { kind: 'message'; role: 'user' | 'assistant'; text: string }

/** Where a terminal transcript cuts a long entry (observed on Orca 1.4.277). */
export const TERMINAL_CUT = 1214
const ok = (result: unknown) => JSON.stringify({ id: 'x', ok: true, result })
const fail = (code: string, message: string) => JSON.stringify({ ok: false, error: { code, message } })

export function fakeOrca(sessions: FakeSession[]) {
  const transcripts = new Map<string, Entry[]>(sessions.map((s) => [s.id, []]))
  const writes: string[][] = []
  const behavior = {
    /** Orca's answer to a terminal send outside the focused workspace. */
    outsideFocus: false,
    /** The text lands but the answer is lost, as when the process times out. */
    loseAnswer: false,
    /** The text never lands. */
    dropText: false,
    /** Called as the write starts, before the text lands. */
    onWrite: (_args: readonly string[]) => {}
  }
  let mails = 0
  const find = (id: string) => sessions.find((s) => s.id === id)
  const bump = (s: FakeSession) => { s.updatedAt += 1 }

  function say(id: string, role: Entry['role'], text: string) {
    transcripts.get(id)!.push({ kind: 'message', role, text })
    bump(find(id)!)
  }

  function ps() {
    const projects = [...new Set(sessions.map((s) => s.project ?? 'acme'))]
    return ok({
      worktrees: projects.map((project, i) => ({
        worktreeId: `${project}::/w/${project}`, repoId: project, hostId: sessions.find((s) => (s.project ?? 'acme') === project)?.hostId ?? 'local',
        path: `/w/${project}`, branch: 'refs/heads/main', displayName: project, repo: project, isArchived: false,
        address: { worktree: `identity:wt2:local:${i}` },
        agents: sessions.filter((s) => (s.project ?? 'acme') === project).map((s) => ({
          paneKey: s.surface === 'chat' ? `structured-agent-session-${s.id}:p` : `tab-${s.id}:leaf`,
          address: s.surface === 'chat' ? 'orca_session_id:' + s.id : s.handle ?? null,
          orcaSessionId: s.id, state: s.state, agentType: 'claude', toolName: null, toolInput: null, conversationName: s.title ?? s.id,
          lastAssistantMessage: transcripts.get(s.id)!.filter((e) => e.role === 'assistant').at(-1)?.text ?? null,
          stateStartedAt: s.updatedAt, updatedAt: s.updatedAt, hasLivePty: s.livePty ?? true,
          mainAgent: { outcome: 'success' }, activity: { listed: true, unread: false }
        }))
      }))
    })
  }

  const runner: Runner = async (args) => {
    const verb = args.slice(0, 2).join(' ')
    const flag = (name: string) => args[args.indexOf(name) + 1]
    if (verb === 'worktree ps') return ps()
    if (verb === 'repo list') return ok({ repos: [...new Set(sessions.map((s) => s.project ?? 'acme'))].map((id) => ({ id, path: '/w/' + id, displayName: id })) })
    if (verb === 'agent read') {
      const id = args[2].replace('orca_session_id:', '')
      const s = find(id)
      if (!s) return fail('not_found', 'no transcript')
      const limit = Number(flag('--limit'))
      const entries = transcripts.get(id)!.slice(-limit).map((e) =>
        s.surface === 'terminal' && e.text.length > TERMINAL_CUT ? { ...e, text: e.text.slice(0, TERMINAL_CUT) + TRUNCATED } : e)
      return ok({ orcaSessionId: id, kind: s.surface, entries, state: s.state === 'working' ? 'working' : 'done' })
    }
    writes.push([...args])
    behavior.onWrite(args)
    if (verb === 'terminal send') {
      const s = sessions.find((x) => x.handle === flag('--terminal'))
      if (!s) return fail('not_found', 'no such terminal')
      if (behavior.outsideFocus) return fail('invalid_argument', 'terminal is outside the active worktree')
      if (!behavior.dropText) say(s.id, 'user', flag('--text'))
      return behavior.loseAnswer ? 'Error: lost' : ok({ accepted: true, submitted: true })
    }
    if (verb === 'orchestration send') {
      const id = flag('--to').replace('orca_session_id:', '')
      if (!find(id)) return fail('not_found', 'no such agent')
      const body = readFileSync(flag('--body-file'), 'utf8')
      const mail = 'msg_' + String(++mails).padStart(12, '0')
      if (!behavior.dropText) say(id, 'user', [`──── From: BOARD (${flag('--type')}) ────`, 'Subject: ' + flag('--subject'), body,
        `[Reply: orca orchestration reply --id ${mail} --body "..."]`, '─'.repeat(60)].join('\n'))
      return behavior.loseAnswer ? 'Error: lost' : ok({ messageId: mail })
    }
    return fail('unknown', 'not faked: ' + verb)
  }
  return { runner, sessions, transcripts, writes, behavior, say, find }
}
