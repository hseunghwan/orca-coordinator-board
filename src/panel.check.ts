// `orca plugin check` renders the panel once per scenario with the worker on a fresh host.
// Projects sit on another host here, so the check never starts git or gh.
import { defineCheck } from 'orca/testing'

const project = { id: 'p1', name: 'App', kind: 'git', hostId: 'ssh:demo', path: '/w/app' }
const workspace = {
  id: 'w1', kind: 'worktree', name: 'feat-login', projectId: 'p1', path: '/w/app-login', branch: 'feat/login', hostId: 'ssh:demo',
  status: { state: 'active', unread: false, terminalCount: 2, lastActivityAt: 1 }
}

export default defineCheck({
  firstRun: {
    results: { 'project.list': { projects: [project], truncated: false }, 'workspace.list': { workspaces: [], truncated: false } }
  },
  decisions: {
    storage: { selectedProjects: ['p1'] },
    results: {
      'project.list': { projects: [project], truncated: false },
      'workspace.list': { workspaces: [workspace], truncated: false },
      'agents.list': {
        agents: [
          { terminalId: 't1', title: 'fix login', agent: 'claude', state: 'waiting', stateStartedAt: 1700000000000 },
          { terminalId: 't2', title: 'migrate db', agent: 'codex', state: 'blocked', stateStartedAt: 1700000100000 }
        ]
      },
      'terminal.read': { lines: ['Which branch should I use?'], truncated: false }
    }
  }
})
