// Recorded-shape CLI answers for tests. Every id, path and text here is made up.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Runner } from '../cli'
import { buildWorld, repoList, worktreePs, type SessionId } from '../view'

export const stdout = (name: string) => readFileSync(join(__dirname, name), 'utf8')
export const result = (name: string) => JSON.parse(stdout(name)).result
export const sid = (n: number) => `5e55${String(n).padStart(4, '0')}-0000-4000-8000-000000000000` as SessionId
export const fixtureWorld = () => buildWorld(worktreePs.parse(result('worktree-ps.json')), repoList.parse(result('repo-list.json')), 1)

const READS: Record<string, string> = {
  [sid(1)]: 'agent-read-chat-question.json',
  [sid(2)]: 'agent-read-chat-done.json',
  [sid(7)]: 'agent-read-terminal-cut.json'
}

/** Answers orca like the fixtures; an agent read of any other session fails as Orca does. */
export function fixtureRunner(calls: string[][] = []): Runner {
  return async (args) => {
    calls.push([...args])
    if (args[0] === 'worktree' && args[1] === 'ps') return stdout('worktree-ps.json')
    if (args[0] === 'repo' && args[1] === 'list') return stdout('repo-list.json')
    const id = args[0] === 'agent' && args[1] === 'read' ? args[2].replace('orca_session_id:', '') : ''
    if (READS[id]) return stdout(READS[id])
    return JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no transcript' } })
  }
}
