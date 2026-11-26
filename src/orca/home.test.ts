import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { translator } from '../i18n'
import { createCli } from './cli'
import { fakeOrca } from './fixtures/fake-orca'
import { CoordinatorHome } from './home'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function setup() {
  const orca = fakeOrca([])
  const dir = mkdtempSync(join(tmpdir(), 'board-home-'))
  dirs.push(dir)
  const home = new CoordinatorHome(join(dir, 'coordinator'), createCli(orca.runner), async () => {})
  const sidebar = async () => {
    const repo = JSON.parse(await orca.runner(['repo', 'list', '--json'], 0)).result.repos.find((r: { id: string }) => r.id === 'home-1')
    const ps = JSON.parse(await orca.runner(['worktree', 'ps', '--json'], 0)).result.worktrees.find((w: { repoId: string }) => w.repoId === 'home-1')
    return { project: repo.displayName, visibility: repo.externalWorktreeVisibility, workspace: ps.displayName }
  }
  return { orca, home, sidebar, verbs: () => orca.writes.map((w) => w.slice(0, 2).join(' ')) }
}

test('a new home takes the board language names in the sidebar', async () => {
  const f = setup()
  expect(await f.home.ensure(translator('ko'))).toBe('home-1')
  expect(await f.sidebar()).toEqual({ project: '코디네이터 보드', visibility: 'show', workspace: '코디네이터 운영' })
  expect(f.verbs()).toEqual(['repo add', 'project setup-update', 'worktree set'])
})

test('a home whose worktrees Orca hides is set to show them', async () => {
  const f = setup()
  f.orca.behavior.folderVisibility = 'hide'
  await f.home.ensure(translator('ko'))
  expect(await f.sidebar()).toMatchObject({ visibility: 'show' })
  expect(f.verbs().filter((v) => v === 'repo set')).toHaveLength(1)
})

test('an ensure that finds the home as the board wants it writes nothing', async () => {
  const f = setup()
  await f.home.ensure(translator('ko'))
  const before = f.orca.writes.length
  expect(await f.home.ensure(translator('ko'))).toBe('home-1')
  expect(f.orca.writes.length).toBe(before)
})

test('a changed board language renames only the names, once', async () => {
  const f = setup()
  await f.home.ensure(translator('ko'))
  const before = f.orca.writes.length
  await f.home.ensure(translator('en'))
  expect(f.verbs().slice(before)).toEqual(['project setup-update', 'worktree set'])
  expect(await f.sidebar()).toMatchObject({ project: 'Coordinator Board', workspace: 'Coordinator home' })
})
