import { expect, test } from 'vitest'
import { fixtureWorld as world, sid } from './fixtures/load'
import { paseoAgentView, workspaceKey } from './view'

test('a row without an orca_session_id is counted, not boarded, and one conversation in two panes is one session', () => {
  const w = world()
  expect(w.unidentified).toBe(1)
  expect([...w.sessions.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(sid).sort())
  expect(w.sessions.get(sid(7))).toMatchObject({ handle: 'term_00000007-0000-4000-8000-000000000000', listed: true })
})

test('workspaces keep the host list id, a branch without refs/heads and the project of their repo', () => {
  const w = world()
  const login = [...w.workspaces.values()].find((ws) => ws.path === '/w/app-login')
  expect(login).toMatchObject({ listId: 'identity:wt2:local:0a0a0a0a-0000-4000-8000-000000000002', branch: 'feat/login', projectName: 'app', title: 'feat-login' })
  const folder = w.workspaces.get('folder:f01d0000-0000-4000-8000-000000000000' as never)
  expect(folder).toMatchObject({ listId: 'folder:f01d0000-0000-4000-8000-000000000000', projectName: 'Notes', branch: null })
})

test('only an inline raster icon is kept, so an isolated frame never fetches', () => {
  const projects = [...world().projects.values()]
  expect(projects.map((p) => [p.name, p.icon?.slice(0, 22) ?? null, p.remoteUrl])).toEqual([
    ['app', 'data:image/png;base64,', 'git@github.com:acme/app.git'],
    ['site', null, 'https://github.com/acme/site.git']
  ])
})

test('workspaceKey joins the CLI, event and host list forms of one workspace', () => {
  const cli = workspaceKey({ id: 'aaaa::C:\\W\\App\\', hostId: 'local' })
  expect(cli).toBe(workspaceKey({ id: 'identity:wt2:local:x', path: 'c:/w/app', hostId: 'local' }))
  expect(cli).toBe(workspaceKey({ id: 'aaaa::c:/w/app' }))
  expect(cli).not.toBe(workspaceKey({ id: 'aaaa::C:\\W\\App', hostId: 'ssh:box' }))
  expect(workspaceKey({ id: 'aaaa::/w/App' })).not.toBe(workspaceKey({ id: 'aaaa::/w/app' }))
  expect(workspaceKey({ id: 'folder:f1', path: '/w/notes' })).toBe('folder:f1')
  expect(workspaceKey({ id: 'identity:wt2:local:x' })).toBeNull()
})

test('the lane table: a wait is a pending permission per episode, a failure an error, unread a finished result, no PTY closed', () => {
  const w = world()
  const view = (n: number) => {
    const s = w.sessions.get(sid(n))!
    return paseoAgentView(s, w.workspaces.get(s.worktree))
  }
  expect(view(4)).toMatchObject({ status: 'running', attentionReason: 'permission', pendingPermissions: [{ id: expect.stringMatching(/@1795000004000$/), title: 'Bash', description: 'rm -rf build' }] })
  expect(view(5)).toMatchObject({ status: 'running', attentionReason: 'permission', pendingPermissions: [{ title: 'AskUserQuestion' }] })
  expect(view(3)).toMatchObject({ status: 'running', activeTurn: { startedAt: expect.any(String) }, pendingPermissions: [], backgroundWork: { count: 1 } })
  expect(view(6)).toMatchObject({ status: 'error', attentionReason: 'error' })
  expect(view(1)).toMatchObject({ status: 'idle', requiresAttention: true, attentionReason: 'finished' })
  expect(view(8)).toMatchObject({ status: 'closed', requiresAttention: false })
  expect(view(2)).toMatchObject({ status: 'idle', requiresAttention: false, attentionReason: null, model: null, provider: 'claude' })
  expect(view(9).archivedAt).not.toBeNull()
})
