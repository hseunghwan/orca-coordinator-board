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
    /** Orca answers a write with this error and sends nothing. */
    refuseWith: null as string | null,
    /** The text lands but the answer is lost, as when the process times out. */
    loseAnswer: false,
    /** The text never lands. */
    dropText: false,
    /** Called before each worktree ps answer, as Orca's state can change between two reads. */
    beforePs: () => {},
    /** Called as the write starts, before the text lands. */
    onWrite: (_args: readonly string[]) => {},
    /** agent launch: start a terminal agent, refuse, or start one and lose the answer (with or without Orca's retry id). */
    launch: 'start' as 'start' | 'refuse' | 'lose' | 'lose-with-id',
    /** How many worktree ps reads a launched agent stays without a session id. */
    reportAfterPs: 0,
    agents: [{ id: 'claude', name: 'Claude' }, { id: 'codex', name: 'Codex' }, { id: 'grok', name: 'Grok' }],
    rateLimits: {} as Record<string, unknown>,
    /** orca host list rows, and what agent list --environment answers per environment id ('fail': it does not answer). */
    hosts: [{ kind: 'local', name: 'this machine', id: 'local' }] as Record<string, unknown>[],
    remote: {} as Record<string, Record<string, unknown>[] | 'fail'>,
    /** repo add: register the folder, register it and lose the answer, or refuse. */
    repoAdd: 'add' as 'add' | 'lose' | 'refuse',
    /** The non-Orca worktree visibility a new folder project gets (Orca 1.4.277 showed 'show'). */
    folderVisibility: 'show'
  }
  /** Folder projects added with repo add, path as Orca prints it with forward slashes, and their sidebar settings. */
  const folders: { id: string; path: string; displayName: string; workspaceName: string; visibility: string }[] = []
  const launches: { operationId: string; session: FakeSession; hiddenFor: number }[] = []
  let mails = 0
  const find = (id: string) => sessions.find((s) => s.id === id)
  const bump = (s: FakeSession) => { s.updatedAt += 1 }

  function say(id: string, role: Entry['role'], text: string) {
    transcripts.get(id)!.push({ kind: 'message', role, text })
    bump(find(id)!)
  }

  function ps() {
    const projects = [...new Set(sessions.map((s) => s.project ?? 'acme'))].filter((p) => !folders.some((f) => f.id === p))
    return ok({
      worktrees: [...folders.map((f) => ({
        worktreeId: `${f.id}::${f.path}`, repoId: f.id, hostId: 'local', path: f.path, branch: null, displayName: f.workspaceName, repo: f.displayName,
        isArchived: false, address: { worktree: `id:${f.id}::${f.path}` }, agents: agentsIn(f.id)
      })), ...projects.map((project, i) => ({
        worktreeId: `${project}::/w/${project}`, repoId: project, hostId: sessions.find((s) => (s.project ?? 'acme') === project)?.hostId ?? 'local',
        path: `/w/${project}`, branch: 'refs/heads/main', displayName: project, repo: project, isArchived: false,
        address: { worktree: `identity:wt2:local:${i}` },
        agents: agentsIn(project)
      }))]
    })
  }

  function agentsIn(project: string) {
    return sessions.filter((s) => (s.project ?? 'acme') === project).map((s) => ({
      paneKey: s.surface === 'chat' ? `structured-agent-session-${s.id}:p` : `tab-${s.id}:leaf`,
      address: s.surface === 'chat' ? 'orca_session_id:' + s.id : s.handle ?? null,
      orcaSessionId: s.id, state: s.state, agentType: 'claude', toolName: null, toolInput: null, conversationName: s.title ?? s.id,
      lastAssistantMessage: transcripts.get(s.id)!.filter((e) => e.role === 'assistant').at(-1)?.text ?? null,
      stateStartedAt: s.updatedAt, updatedAt: s.updatedAt, hasLivePty: s.livePty ?? true,
      mainAgent: { outcome: 'success' }, activity: { listed: true, unread: false }
    }))
  }

  const runner: Runner = async (args) => {
    const verb = args.slice(0, 2).join(' ')
    const flag = (name: string) => args[args.indexOf(name) + 1]
    if (verb === 'worktree ps') {
      behavior.beforePs()
      for (const l of launches) if (l.hiddenFor-- === 0) { sessions.push(l.session); transcripts.set(l.session.id, []) }
      return ps()
    }
    if (verb === 'agent installed') return ok({ agents: behavior.agents.map((a) => ({ ...a, default: false })) })
    if (verb === 'account list') return ok({ rateLimits: behavior.rateLimits })
    if (verb === 'host list') return ok({ hosts: behavior.hosts })
    if (verb === 'agent list') {
      const remote = behavior.remote[flag('--environment')]
      return !remote || remote === 'fail' ? fail('unreachable', 'environment did not answer') : ok({ agents: remote })
    }
    if (verb === 'repo list') {
      const repos = [...new Set(sessions.map((s) => s.project ?? 'acme'))].filter((id) => !folders.some((f) => f.id === id)).map((id) => ({ id, path: '/w/' + id, displayName: id }))
      return ok({ repos: [...repos, ...folders.map((f) => ({ id: f.id, path: f.path, displayName: f.displayName, kind: 'folder',
        externalWorktreeVisibility: f.visibility }))] })
    }
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
    if (behavior.refuseWith) return fail('invalid_argument', behavior.refuseWith)
    if (verb === 'terminal send') {
      const s = sessions.find((x) => x.handle === flag('--terminal'))
      if (!s) return fail('not_found', 'no such terminal')
      if (!behavior.dropText) say(s.id, 'user', flag('--text'))
      return behavior.loseAnswer ? 'Error: lost' : ok({ accepted: true, submitted: true })
    }
    if (verb === 'agent launch') {
      const retry = args.includes('--retry-launch') ? flag('--retry-launch') : null
      const earlier = launches.find((l) => l.operationId === retry)
      if (earlier) return ok({ outcome: { kind: 'terminal', handle: earlier.session.handle }, operationId: earlier.operationId })
      if (behavior.launch === 'refuse') return fail('invalid_argument', 'agent not installed')
      const n = launches.length + 1
      const project = flag('--worktree').replace(/^id:/, '').split('::')[0]
      const session: FakeSession = { id: 'launched-' + n, surface: 'terminal', state: 'done', updatedAt: 1, handle: 'term_launch_' + n, title: 'Coordinator', project }
      launches.push({ operationId: 'op-' + n, session, hiddenFor: behavior.reportAfterPs })
      if (behavior.launch === 'lose') return 'Error: lost'
      if (behavior.launch === 'lose-with-id') return fail('timeout', 'launch reply lost; re-issue with --retry-launch op-' + n)
      return ok({ outcome: { kind: 'terminal', handle: session.handle }, operationId: 'op-' + n })
    }
    if (verb === 'repo add') {
      if (behavior.repoAdd === 'refuse') return fail('invalid_argument', 'path is not a directory')
      const id = 'home-' + (folders.length + 1)
      // A new folder project is named after its folder (observed on Orca 1.4.277).
      folders.push({ id, path: flag('--path').replace(/\\/g, '/'), displayName: 'coordinator', workspaceName: 'coordinator', visibility: behavior.folderVisibility })
      return behavior.repoAdd === 'lose' ? 'Error: lost' : ok({ repo: { id, path: flag('--path'), kind: 'folder' } })
    }
    if (verb === 'repo set') {
      const f = folders.find((x) => 'id:' + x.id === flag('--repo'))
      if (!f) return fail('not_found', 'no such repo')
      f.visibility = flag('--external-worktree-visibility')
      return ok({ repo: { id: f.id } })
    }
    if (verb === 'project setup-update') {
      const f = folders.find((x) => x.id === flag('--setup'))
      if (!f) return fail('not_found', 'no such setup')
      f.displayName = flag('--display-name')
      return ok({ setup: { id: f.id, displayName: f.displayName } })
    }
    if (verb === 'worktree set') {
      const f = folders.find((x) => `id:${x.id}::${x.path}` === flag('--worktree'))
      if (!f) return fail('not_found', 'no such worktree')
      f.workspaceName = flag('--display-name')
      return ok({ worktree: { displayName: f.workspaceName } })
    }
    if (verb === 'orchestration send') {
      const id = flag('--to').replace('orca_session_id:', '')
      if (!find(id)) return fail('not_found', 'no such agent')
      // What Orca answers a process outside every Orca terminal (observed 2026-11-26).
      if (!args.includes('--from')) return fail('invalid_argument', 'Could not determine the calling terminal for this orchestration command. Pass --from with your own terminal\'s handle.')
      const body = readFileSync(flag('--body-file'), 'utf8')
      const mail = 'msg_' + String(++mails).padStart(12, '0')
      if (!behavior.dropText) say(id, 'user', [`──── From: ${flag('--from').toUpperCase()} (${flag('--from')}) (${flag('--type')}) ────`, 'Subject: ' + flag('--subject'), body,
        `[Reply: orca orchestration reply --id ${mail} --body "..."]`, '─'.repeat(60)].join('\n'))
      return behavior.loseAnswer ? 'Error: lost' : ok({ messageId: mail })
    }
    return fail('unknown', 'not faked: ' + verb)
  }
  return { runner, sessions, transcripts, writes, behavior, say, find, launches }
}
