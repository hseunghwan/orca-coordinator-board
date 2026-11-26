// Proves the coordinator channel end to end without reloading the plugin: runs the real worker
// (activateWith) over the real orca CLI with a stand-in Orca host, fires its agent.launch.before hook
// for a terminal, and runs bin/coordinator-board(.cmd) as a child with the env the hook returned.
// The board data lives in a temporary folder, so the person's own board is untouched. The caller is
// your terminal (--terminal, default ORCA_TERMINAL_HANDLE), named coordinator in that temporary board.
// Run `npm run build` first (the shim runs dist/cli.cjs). Prints counts and exit codes, no session names.
// Usage: node scripts/probe-channel.mjs [--terminal <term_handle>] [--node <runtime>]
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const terminal = flag('--terminal') ?? process.env.ORCA_TERMINAL_HANDLE
if (!terminal) {
  console.error('give --terminal <term_handle>: the probe calls as that terminal')
  process.exit(2)
}
const root = dirname(dirname(fileURLToPath(import.meta.url)))
if (!existsSync(join(root, 'dist', 'cli.cjs'))) {
  console.error('run npm run build first')
  process.exit(2)
}
const scratch = mkdtempSync(join(tmpdir(), 'board-channel-probe-'))
const data = join(scratch, 'data')
try {
  const bundle = join(scratch, 'probe.mjs')
  await build({
    stdin: {
      contents: [
        "export { activateWith, hostFiles } from './src/worker.ts'",
        "export { hostCli } from './src/orca/cli.ts'",
        "export { createFleet } from './src/orca/index.ts'",
        "export { cliEnv, execRunner, locateOrca, createCli } from './src/orca/cli.ts'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: bundle, logLevel: 'error'
  })
  const m = await import(pathToFileURL(bundle).href)
  const exe = m.locateOrca({ platform: process.platform, execPath: process.execPath, env: process.env, exists: existsSync })
  if (!exe) throw new Error('orca CLI not found')
  const cli = m.createCli(m.execRunner(exe, m.cliEnv(process.env, process.platform)))

  const storage = new Map()
  const handlers = new Map()
  const hooks = new Map()
  const host = {
    'workspace.readContext': () => null,
    'statusBar.update': () => ({ ok: true }),
    'workspace.list': () => ({ workspaces: [], truncated: false })
  }
  const orca = {
    storage: {
      get: async (key) => storage.get(key) ?? null,
      set: async (key, value) => { storage.set(key, value) },
      delete: async (key) => { storage.delete(key) },
      onDidChange: () => ({ dispose() {} })
    },
    hooks: { on: (name, fn) => { hooks.set(name, fn); return { dispose() {} } } },
    events: { on: () => ({ dispose() {} }) },
    commands: { register: () => ({ dispose() {} }) },
    panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } }, post() {} },
    host: { call: async (method, params) => { if (!host[method]) throw new Error('not in the probe host: ' + method); return host[method](params) } },
    log: (message) => console.log('[worker]', message)
  }
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\cb-probe-' + randomUUID() : join(scratch, 'channel.sock')
  const node = flag('--node') ?? process.env.ORCA_AGENT_HOOK_NODE ?? process.execPath
  const stop = m.activateWith(orca, { cli, dataDir: data, files: m.hostFiles, pollMs: 0, channel: { path: pipe, bin: join(root, 'bin'), node } })
  const request = (name, input = {}) => handlers.get(name)(input, {})

  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const launch = { agent: 'claude', workspaceId: null, workspaceKind: null, terminalId: terminal, command: "claude '--' 'hello'", env: { [pathKey]: process.env.PATH ?? '' } }
  const decided = await hooks.get('agent.launch.before')(launch, (event) => ({ continued: event }))
  const env = decided.continued.env
  console.log('hook env keys:', Object.keys(env).filter((k) => k.startsWith('CB_')).sort().join(' '))
  console.log('PATH starts with bin:', env[pathKey].split(delimiter)[0] === join(root, 'bin'))

  const fleet = m.createFleet(cli)
  const world = await fleet.view({ maxAgeMs: 0 })
  const me = [...world.sessions.values()].filter((s) => s.handle === terminal).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!me) throw new Error('no session reported in that terminal')
  const ws = world.workspaces.get(me.worktree)
  await request('board.scope', { kind: 'project', projectId: ws.projectId, enabled: true })
  await request('board.scope', { kind: 'coordinator', sessionId: me.id })

  const shim = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', join(root, 'bin', 'coordinator-board.cmd')]] : ['sh', [join(root, 'bin', 'coordinator-board')]]
  // Asynchronous: the worker answering it runs in this process.
  const run = (argv, extra = {}) => new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(shim[0], [...shim[1], ...argv], { env: { ...process.env, ...env, ...extra }, windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, text: (out || err).trim(), ms: Date.now() - started }))
  })
  const listing = await run(['read'])
  const rows = listing.code === 0 ? JSON.parse(listing.text) : []
  console.log('read:', { exit: listing.code, sessions: rows.length, ms: listing.ms })
  const target = rows.find((r) => r.id !== me.id) ?? rows[0]
  if (target) {
    const one = await run(['read', '--session', target.id])
    const parsed = one.code === 0 ? JSON.parse(one.text) : null
    console.log('read --session:', { exit: one.code, evidenceId: !!parsed?.evidenceId, turns: parsed?.turns?.length ?? 0, ms: one.ms })
  }
  console.log('wrong token:', (await run(['read'], { CB_CALLER_TOKEN: 'f'.repeat(64) })).code)
  console.log('not yet:', (await run(['plan'])).code)
  console.log('no board:', (await run(['read'], { CB_PIPE: pipe + '-gone' })).code)
  stop()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
