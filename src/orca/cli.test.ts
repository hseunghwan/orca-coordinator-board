import { expect, test } from 'vitest'
import { CliError, cliEnv, createCli, locateOrca, parseEnvelope, type Runner } from './cli'

const ok = (result: unknown) => JSON.stringify({ id: '1', ok: true, result, _meta: { runtimeId: 'r' } })

test('finds orca.exe from the override, the app folder, then the default install, and never a .cmd', () => {
  const env = { USERPROFILE: 'C:\\Users\\me', ORCA_CLI_COMMAND: 'C:\\tools\\orca.cmd' }
  const exists = (path: string) => path.endsWith('orca.exe') || path.endsWith('orca.cmd')
  expect(locateOrca({ platform: 'win32', execPath: 'C:\\Apps\\Orca\\Orca.exe', env, exists }))
    .toBe('C:\\Apps\\Orca\\resources\\bin\\orca.exe')
  expect(locateOrca({ platform: 'win32', execPath: 'C:\\node\\node.exe', env, exists: (path) => path.startsWith('C:\\Users') }))
    .toBe('C:\\Users\\me\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe')
  expect(locateOrca({ platform: 'win32', execPath: 'C:\\x\\node.exe', env: { ORCA_CLI_COMMAND: 'D:\\orca\\orca.exe' }, exists }))
    .toBe('D:\\orca\\orca.exe')
  expect(locateOrca({ platform: 'linux', execPath: '/opt/orca/orca', env: { ORCA_CLI_BIN_DIR: '/opt/bin' }, exists: (path) => path === '/opt/bin/orca' }))
    .toBe('/opt/bin/orca')
  expect(locateOrca({ platform: 'win32', execPath: 'C:\\x\\node.exe', env: {}, exists: () => false })).toBeNull()
})

test('the CLI environment drops agent pane variables and fills what Windows leaves out', () => {
  const env = cliEnv({
    Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows',
    ORCA_TERMINAL_HANDLE: 'term_1', ORCA_PANE_KEY: 'a:b', ORCA_AGENT_SESSION_ID: 's', GITHUB_TOKEN: 'secret'
  }, 'win32')
  expect(env).toEqual({
    Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\me', SystemRoot: 'C:\\Windows',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', HOME: 'C:\\Users\\me',
    ORCA_USER_DATA_PATH: 'C:\\Users\\me\\AppData\\Roaming\\orca', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0'
  })
  expect(cliEnv({ APPDATA: 'D:\\roam', USERPROFILE: 'C:\\u' }, 'win32').ORCA_USER_DATA_PATH).toBe('D:\\roam\\orca')
})

test('reads the result from the envelope, after progress lines, and turns ok:false into a coded error', () => {
  expect(parseEnvelope(ok({ a: 1 }))).toEqual({ a: 1 })
  expect(parseEnvelope('starting runtime\n' + ok([2]) + '\n')).toEqual([2])
  expect(() => parseEnvelope(JSON.stringify({ ok: false, error: { code: 'not_found', message: 'no such agent' } })))
    .toThrow(expect.objectContaining({ code: 'not_found', message: 'no such agent' }))
  expect(() => parseEnvelope('Error: boom')).toThrow(expect.objectContaining({ code: 'unparseable' }))
})

test('one run per argv in flight, a value kept for its ttl, a failure not kept', async () => {
  const runs: string[][] = []
  let fail = false
  const run: Runner = async (args) => {
    runs.push([...args])
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (fail) return JSON.stringify({ ok: false, error: { message: 'down' } })
    return ok({ n: runs.length })
  }
  let clock = 0
  const cli = createCli(run, () => clock)
  const parse = (result: unknown) => result as { n: number }
  const [a, b] = await Promise.all([cli.read('repo list', [], parse, { ttlMs: 100 }), cli.read('repo list', [], parse, { ttlMs: 100 })])
  expect(a).toBe(b)
  expect(runs).toEqual([['repo', 'list', '--json']])
  await cli.read('repo list', [], parse, { ttlMs: 100 })
  expect(runs).toHaveLength(1)
  clock = 101
  await cli.read('repo list', [], parse, { ttlMs: 100 })
  expect(runs).toHaveLength(2)
  await cli.read('agent read', ['orca_session_id:x', '--limit', '48'], parse)
  await cli.read('agent read', ['orca_session_id:x', '--limit', '48'], parse)
  expect(runs).toHaveLength(4)
  fail = true
  await expect(cli.read('worktree ps', [], parse)).rejects.toBeInstanceOf(CliError)
  fail = false
  await expect(cli.read('worktree ps', [], parse)).resolves.toEqual({ n: 6 })
})

test('at most four orca processes at once', async () => {
  let live = 0
  let peak = 0
  const run: Runner = async () => {
    peak = Math.max(peak, ++live)
    await new Promise((resolve) => setTimeout(resolve, 5))
    live--
    return ok(null)
  }
  const cli = createCli(run)
  await Promise.all(Array.from({ length: 9 }, (_, i) => cli.read('agent read', ['orca_session_id:' + i], (r) => r)))
  expect(peak).toBe(4)
})

test('without orca.exe every read fails with cli_unavailable', async () => {
  await expect(createCli(null).read('worktree ps', [], (r) => r)).rejects.toMatchObject({ code: 'cli_unavailable' })
})
