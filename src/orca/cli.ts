// The orca CLI process boundary: where orca.exe is, the environment it runs with, and the JSON
// envelope it prints. Callers get parsed domain values or a CliError, never raw stdout.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { z } from 'zod'

export type ReadVerb = 'worktree ps' | 'repo list' | 'agent read'
/** Commands that send something. A write never shares a run, is never cached and never retried. */
export type WriteVerb = 'terminal send' | 'orchestration send'

// terminal send waits up to 10 s for the prompt to start a turn.
const TIMEOUT_MS: Readonly<Record<ReadVerb | WriteVerb, number>> = {
  'worktree ps': 10_000, 'repo list': 10_000, 'agent read': 10_000, 'terminal send': 30_000, 'orchestration send': 20_000
}

/**
 * ok: Orca took it. refused: Orca answered with an error and offered no retry id, so nothing went out.
 * ambiguous: the process timed out, died or printed no envelope, or Orca named a --retry-request id;
 * the text may have landed.
 */
export type WriteResult =
  | { kind: 'ok'; result: unknown }
  | { kind: 'refused'; code: string | null; message: string }
  | { kind: 'ambiguous'; message: string; retryRequest: string | null }
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
        const errno = (error as { code?: unknown }).code
        // ENOENT and EACCES mean the process never started; anything else may have run part way.
        reject(new CliError(error.message, errno === 'ENOENT' || errno === 'EACCES' ? 'spawn_failed' : 'exec_failed'))
      })
  })
}

export interface OrcaCli {
  /** Same verb and arguments share one run while it is in flight, and the value for ttlMs after. */
  read<T>(verb: ReadVerb, args: readonly string[], parse: (result: unknown) => T, options?: { ttlMs?: number }): Promise<T>
  /** Drops cached values; runs in flight still finish. */
  forget(verb?: ReadVerb): void
  /** Runs once, uncached and unshared. Never throws. */
  write(verb: WriteVerb, args: readonly string[]): Promise<WriteResult>
}

export function writeOutcome(stdout: string): WriteResult {
  try {
    return { kind: 'ok', result: parseEnvelope(stdout) }
  } catch (error) {
    const { message, code } = error as CliError
    if (code === 'unparseable') return { kind: 'ambiguous', message, retryRequest: null }
    const retry = /--retry-request\s+([A-Za-z0-9_-]+)/.exec(message)
    return retry ? { kind: 'ambiguous', message, retryRequest: retry[1] } : { kind: 'refused', code, message }
  }
}

export function createCli(run: Runner | null, now: () => number = Date.now, maxProcesses = MAX_PROCESSES): OrcaCli {
  const cache = new Map<string, { verb: ReadVerb; expires: number; value: Promise<unknown> }>()
  // Two callers may parse the same output into different shapes; they share a run only when they share a parser.
  const parsers = new WeakMap<object, number>()
  let parserCount = 0
  const parserId = (parse: object) => {
    let id = parsers.get(parse)
    if (id === undefined) parsers.set(parse, (id = ++parserCount))
    return id
  }
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
      const key = JSON.stringify(argv) + '#' + parserId(parse)
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
    },
    async write(verb, args) {
      if (!run) return { kind: 'refused', code: 'cli_unavailable', message: 'orca CLI not found' }
      try {
        return writeOutcome(await limited(() => run([...verb.split(' '), ...args, '--json'], TIMEOUT_MS[verb])))
      } catch (error) {
        const { message, code } = error as CliError
        return code === 'spawn_failed' ? { kind: 'refused', code, message } : { kind: 'ambiguous', message, retryRequest: null }
      }
    }
  }
}

export function hostCli(): OrcaCli {
  const exe = locateOrca({ platform: process.platform, execPath: process.execPath, env: process.env, exists: existsSync })
  return createCli(exe ? execRunner(exe, cliEnv(process.env, process.platform)) : null)
}
