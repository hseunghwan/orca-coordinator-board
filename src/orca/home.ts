// The board's own coordinator workspace. Paseo opens $PASEO_HOME/plugin-workspaces/coordinator-board and
// starts its coordinator there. Orca has no plugin-owned workspace, so the board registers a folder in
// its data directory as an ordinary folder project, and finds it again by path in `orca repo list`.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { T } from '../i18n'
import type { OrcaCli } from './cli'
import { samePath, worktreePs, type RepoId, type World, type WorkspaceRecord } from './view'

/** How often the repo list is read again after a repo add whose answer was lost. */
const SETTLE_TRIES = 3
const SETTLE_WAIT_MS = 500

export const homeDir = (dataDir: string) => join(dataDir, 'coordinator')
/** The names the home shows in Orca's sidebar, in the board's language. */
export const homeNames = (t: T) => ({ project: t('코디네이터 보드', 'Coordinator Board'), workspace: t('코디네이터 운영', 'Coordinator home') })

const homeRepos = z.object({ repos: z.array(z.object({
  id: z.string(), path: z.string(), displayName: z.string(), externalWorktreeVisibility: z.string().nullish()
})) })
type HomeRepo = z.output<typeof homeRepos>['repos'][number]
const parseRepos = (result: unknown) => homeRepos.parse(result)
const parsePs = (result: unknown) => worktreePs.parse(result)

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

  /**
   * Creates the folder and registers it with Orca unless the repo list has it already, then brings its
   * sidebar settings to the board's: shown worktrees and the names in the board's language. Callers share one run.
   */
  ensure(t: T): Promise<RepoId> {
    this.running ??= this.register().then(async (repo) => {
      await this.settle(repo, homeNames(t))
      return repo.id as RepoId
    }).finally(() => { this.running = null })
    return this.running
  }

  private async listed(): Promise<HomeRepo | null> {
    // The fleet keeps the repo list a minute; a project added now must show in its next view.
    this.cli.forget('repo list')
    const { repos } = await this.cli.read('repo list', [], parseRepos)
    return repos.find((repo) => samePath(repo.path, this.dir)) ?? null
  }

  private async register(): Promise<HomeRepo> {
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

  /** Writes only what differs from what Orca shows now. Cosmetic: a failed write leaves it for the next ensure. */
  private async settle(repo: HomeRepo, names: { project: string; workspace: string }): Promise<void> {
    if (repo.externalWorktreeVisibility !== 'show') {
      await this.cli.write('repo set', ['--repo', 'id:' + repo.id, '--external-worktree-visibility', 'show'])
    }
    if (repo.displayName !== names.project) {
      // Orca keys a repo-backed project's setup by the repo id, and mirrors its display name onto the repo.
      await this.cli.write('project setup-update', ['--setup', repo.id, '--display-name', names.project])
      this.cli.forget('repo list')
    }
    const ps = await this.cli.read('worktree ps', [], parsePs).catch(() => null)
    const workspace = ps?.worktrees.find((w) => w.repoId === repo.id && samePath(w.path, this.dir))
    if (workspace && workspace.displayName !== names.workspace) {
      await this.cli.write('worktree set', ['--worktree', workspace.address?.worktree ?? 'id:' + workspace.worktreeId, '--display-name', names.workspace])
    }
  }
}
