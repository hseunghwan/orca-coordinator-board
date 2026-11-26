// The board's own coordinator workspace. Paseo opens $PASEO_HOME/plugin-workspaces/coordinator-board and
// starts its coordinator there. Orca has no plugin-owned workspace, so the board registers a folder in
// its data directory as an ordinary folder project, and finds it again by path in `orca repo list`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcaCli } from './cli'
import { repoList, samePath, type RepoId, type World, type WorkspaceRecord } from './view'

/** How often the repo list is read again after a repo add whose answer was lost. */
const SETTLE_TRIES = 3
const SETTLE_WAIT_MS = 500

export const homeDir = (dataDir: string) => join(dataDir, 'coordinator')
const parseRepos = (result: unknown) => repoList.parse(result)

export class CoordinatorHome {
  private running: Promise<RepoId> | null = null

  constructor(readonly dir: string, private readonly cli: OrcaCli,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))) {}

  /** The home project, when this World lists it. */
  project(world: World): RepoId | null {
    for (const project of world.projects.values()) if (samePath(project.path, this.dir)) return project.id
    return null
  }

  /** The home project's workspace on this computer, when Orca lists one. */
  workspace(world: World): WorkspaceRecord | null {
    const id = this.project(world)
    return [...world.workspaces.values()].find((w) => w.projectId === id && !w.archived && (!w.hostId || w.hostId === 'local')) ?? null
  }

  /** Creates the folder and registers it with Orca unless the repo list has it already. Callers share one run. */
  ensure(): Promise<RepoId> {
    this.running ??= this.register().finally(() => { this.running = null })
    return this.running
  }

  private async listed(): Promise<RepoId | null> {
    // The fleet keeps the repo list a minute; a project added now must show in its next view.
    this.cli.forget('repo list')
    const { repos } = await this.cli.read('repo list', [], parseRepos)
    return (repos.find((repo) => samePath(repo.path, this.dir))?.id ?? null) as RepoId | null
  }

  private async register(): Promise<RepoId> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const known = await this.listed()
    if (known) return known
    const outcome = await this.cli.write('repo add', ['--path', this.dir, '--kind', 'folder'])
    // The repo list, not the answer, says whether the folder was added: an answer lost on the way may still have added it.
    for (let tries = 0; tries < SETTLE_TRIES; tries++) {
      const added = await this.listed()
      if (added) return added
      if (outcome.kind === 'refused') throw new Error(outcome.message)
      await this.sleep(SETTLE_WAIT_MS)
    }
    throw new Error(outcome.kind === 'ok' ? 'orca repo add answered, but the repo list does not show the folder' : outcome.message)
  }
}
