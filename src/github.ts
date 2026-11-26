// git and gh as the worker runs them. The pull request parsing is the ported Paseo code in src/server/prs.ts.
import { execFile } from 'node:child_process'

/**
 * The environment for git and gh. Orca starts the worker without APPDATA (and HOME), and gh on
 * Windows reads its sign-in from %APPDATA%\\GitHub CLI, so it would answer "not logged in".
 * Fill only what is missing, from USERPROFILE. Prompts stay off: a hung prompt never holds the board.
 */
export function commandEnv(env: Readonly<Record<string, string | undefined>>, platform: string): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' }
  const profile = env.USERPROFILE
  if (platform === 'win32' && profile) {
    next.APPDATA ??= profile + '\\AppData\\Roaming'
    next.LOCALAPPDATA ??= profile + '\\AppData\\Local'
    next.HOME ??= profile
  }
  return next
}

/** git or gh with shell:false, a timeout, a buffer cap and prompts off. */
export function run(command: 'git' | 'gh', args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      shell: false,
      windowsHide: true,
      timeout: command === 'gh' ? 15_000 : 3_000,
      maxBuffer: 2 * 1024 * 1024,
      env: commandEnv(process.env, process.platform)
    }, (error: Error | null, stdout: string | Buffer) => (error ? reject(error) : resolve(String(stdout))))
  })
}
