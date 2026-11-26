// Where orca's executable is, without zod, so the coordinator-board CLI bundle can find it too.
import { posix, win32 } from 'node:path'

type Env = Readonly<Record<string, string | undefined>>

/**
 * orca.exe, never orca.cmd: execFile cannot run a .cmd without a shell. Never a bare "orca"
 * either, since the worker's PATH is unknown.
 */
export function locateOrca(input: { platform: NodeJS.Platform; execPath: string; env: Env; exists(path: string): boolean }): string | null {
  const { platform, env } = input
  const path = platform === 'win32' ? win32 : posix
  const exe = platform === 'win32' ? 'orca.exe' : 'orca'
  const localAppData = env.LOCALAPPDATA ?? (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : undefined)
  const candidates = [
    env.ORCA_CLI_COMMAND,
    env.ORCA_CLI_BIN_DIR && path.join(env.ORCA_CLI_BIN_DIR, exe),
    path.join(path.dirname(input.execPath), 'resources', 'bin', exe),
    platform === 'win32' && localAppData ? path.join(localAppData, 'Programs', 'orca', 'resources', 'bin', exe) : undefined
  ]
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || /\.(?:cmd|bat)$/i.test(candidate)) continue
    if (input.exists(candidate)) return candidate
  }
  return null
}
