import { expect, test } from 'vitest'
import { createCli } from './cli'
import { fixtureRunner, sid } from './fixtures/load'
import { createFleet } from './index'

test('one snapshot of reads costs one ps; repo list is kept a minute; invalidate reads again', async () => {
  const calls: string[][] = []
  let clock = 0
  const fleet = createFleet(createCli(fixtureRunner(calls), () => clock), () => clock)
  await Promise.all([fleet.paseo.agents.list(), fleet.paseo.workspaces.list(), fleet.paseo.projects.list()])
  expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['worktree ps', 'repo list'])
  expect(calls[0]).toEqual(['worktree', 'ps', '--limit', '500', '--json'])
  fleet.invalidate()
  clock = 30_000
  await fleet.paseo.agents.list()
  expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['worktree ps', 'repo list', 'worktree ps'])
})

test('agents carry their project and workspace, and workspaces filter by project', async () => {
  const fleet = createFleet(createCli(fixtureRunner()))
  const { entries } = await fleet.paseo.agents.list()
  const asked = entries.find((e) => e.agent.id === sid(1))!
  expect(asked.project).toEqual({ projectKey: 'aaaa1111-0000-4000-8000-000000000000', projectName: 'app', workspaceName: 'app' })
  const folder = await fleet.paseo.workspaces.list({ filter: { projectId: 'folder-workspace:f01d1111-0000-4000-8000-000000000000' } })
  expect(folder.entries.map((w) => w.title)).toEqual(['Notes'])
})

test('a transcript is read once while its session has not changed', async () => {
  const calls: string[][] = []
  const fleet = createFleet(createCli(fixtureRunner(calls)))
  const refetch = () => fleet.paseo.agents.ref(sid(1)).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 48 })
  const [a, b] = await Promise.all([refetch(), refetch()])
  await refetch()
  expect(a).toBe(b)
  expect(calls.filter((c) => c[0] === 'agent')).toEqual([['agent', 'read', 'orca_session_id:' + sid(1), '--limit', '48', '--json']])
  await expect(fleet.paseo.agents.ref(sid(3)).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 128 }))
    .rejects.toMatchObject({ code: 'not_found' })
  expect(calls.at(-1)).toContain('100')
})
