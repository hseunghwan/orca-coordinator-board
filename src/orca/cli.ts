// The orca CLI process boundary: where orca.exe is, the environment it runs with, and the JSON
// envelope it prints. Callers get parsed domain values or a CliError, never raw stdout.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { z } from 'zod'

/** Only reads for now. A write must never share a run, be cached or be retried, so it gets its own method later. */
export type ReadVerb = 'worktree ps' | 'repo list' | 'agent read'

const TIMEOUT_MS: Readonly<Record<ReadVerb, number>> = { 'worktree ps': 10_000, 'repo list': 10_000, 'agent read': 10_000 }
export const MAX_PROCESSES = 4

export class CliError extends Error {
  constructor(message: string, readonly code: string | null) {
    super(message)
    this.name = 'CliError'
  }
}

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

const KEEP = ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ORCA_USER_DATA_PATH', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'USER']

/**
 * An allowlist, not a passthrough: an agent pane's variables (ORCA_TERMINAL_HANDLE, ORCA_PANE_KEY, ...)
 * would make the CLI take the worker for that agent. Orca starts the worker without APPDATA and HOME
 * on Windows, and the CLI finds its runtime under %APPDATA%\orca, so those are filled from USERPROFILE.
 */
export function cliEnv(base: Env, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    // Windows names PATH "Path"; keep the name it came with.
    if (value !== undefined && KEEP.includes(key.toUpperCase())) env[key] = value
  }
  const profile = base.USERPROFILE
  if (platform === 'win32' && profile) {
    env.APPDATA ??= win32.join(profile, 'AppData', 'Roaming')
    env.LOCALAPPDATA ??= win32.join(profile, 'AppData', 'Local')
    env.HOME ??= profile
    env.ORCA_USER_DATA_PATH ??= win32.join(env.APPDATA, 'orca')
  }
  env.GH_PROMPT_DISABLED = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

const envelope = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string().nullish(), message: z.string() }) })
])

/** The last JSON line wins: some commands print progress before the envelope. */
export function parseEnvelope(stdout: string): unknown {
  const lines = stdout.trim().split(/\r?\n/)
  for (const text of [stdout, ...lines.reverse()]) {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      continue
    }
    const parsed = envelope.safeParse(json)
    if (!parsed.success) break
    if (!parsed.data.ok) throw new CliError(parsed.data.error.message, parsed.data.error.code ?? null)
    return parsed.data.result
  }
  throw new CliError('orca printed no JSON result', 'unparseable')
}

/** Runs orca with these arguments and resolves its stdout, even on a non-zero exit (the envelope says why). */
export type Runner = (args: readonly string[], timeoutMs: number) => Promise<string>

export function execRunner(exe: string, env: Record<string, string>): Runner {
  return (args, timeoutMs) => new Promise((resolve, reject) => {
    execFile(exe, [...args], { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env, encoding: 'utf8' },
      (error, stdout) => {
        if (error && (error as { killed?: boolean }).killed) return reject(new CliError('orca did not answer in time', 'timeout'))
        if (stdout || !error) return resolve(stdout)
        reject(new CliError(error.message, 'spawn_failed'))
      })
  })
}

export interface OrcaCli {
  /** Same verb and arguments share one run while it is in flight, and the value for ttlMs after. */
  read<T>(verb: ReadVerb, args: readonly string[], parse: (result: unknown) => T, options?: { ttlMs?: number }): Promise<T>
  /** Drops cached values; runs in flight still finish. */
  forget(verb?: ReadVerb): void
}

export function createCli(run: Runner | null, now: () => number = Date.now, maxProcesses = MAX_PROCESSES): OrcaCli {
  const cache = new Map<string, { verb: ReadVerb; expires: number; value: Promise<unknown> }>()
  const queue: (() => void)[] = []
  let running = 0

  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (running >= maxProcesses) await new Promise<void>((resolve) => queue.push(resolve))
    else running++
    try {
      return await task()
    } finally {
      const next = queue.shift()
      if (next) next()
      else running--
    }
  }

  return {
    read<T>(verb: ReadVerb, args: readonly string[], parse: (result: unknown) => T, options: { ttlMs?: number } = {}): Promise<T> {
      if (!run) return Promise.reject(new CliError('orca CLI not found', 'cli_unavailable'))
      const argv = [...verb.split(' '), ...args, '--json']
      const key = JSON.stringify(argv)
      const hit = cache.get(key)
      if (hit && hit.expires > now()) return hit.value as Promise<T>
      const entry = { verb, expires: Infinity, value: limited(() => run(argv, TIMEOUT_MS[verb])).then((stdout) => parse(parseEnvelope(stdout))) }
      cache.set(key, entry)
      entry.value.then(() => {
        if (options.ttlMs) entry.expires = now() + options.ttlMs
        else if (cache.get(key) === entry) cache.delete(key)
      }, () => {
        if (cache.get(key) === entry) cache.delete(key)
      })
      return entry.value
    },
    forget(verb) {
      for (const [key, entry] of cache) if ((!verb || entry.verb === verb) && entry.expires !== Infinity) cache.delete(key)
    }
  }
}

export function hostCli(): OrcaCli {
  const exe = locateOrca({ platform: process.platform, execPath: process.execPath, env: process.env, exists: existsSync })
  return createCli(exe ? execRunner(exe, cliEnv(process.env, process.platform)) : null)
}
