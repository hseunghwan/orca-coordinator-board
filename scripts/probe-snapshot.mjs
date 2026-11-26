// Builds one board snapshot against the real orca CLI on this machine, with every project selected,
// and prints what the board would show. Reads only; preferences go to a temporary folder.
// Usage: node scripts/probe-snapshot.mjs
// The output names real sessions: read it, do not commit it.
import { build } from 'esbuild'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'board-probe-'))
try {
  const bundle = join(scratch, 'probe.mjs')
  await build({
    stdin: {
      contents: [
        "export { createFleet } from './src/orca/index.ts'",
        "export { cliEnv, createCli, execRunner, locateOrca } from './src/orca/cli.ts'",
        "export { contribute } from './src/server/board.ts'",
        "export { rpcServer } from './src/server/rpc.ts'",
        "export { displayLane } from './src/paseo/shared/decision-count.ts'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: bundle, logLevel: 'error'
  })
  const m = await import(pathToFileURL(bundle).href)

  const exe = m.locateOrca({ platform: process.platform, execPath: process.execPath, env: process.env, exists: existsSync })
  if (!exe) throw new Error('orca CLI not found')
  const raw = m.execRunner(exe, m.cliEnv(process.env, process.platform))
  const calls = []
  const runner = async (args, timeoutMs) => {
    const start = performance.now()
    try { return await raw(args, timeoutMs) } finally { calls.push({ verb: args.slice(0, 2).join(' '), ms: performance.now() - start }) }
  }
  const fleet = m.createFleet(m.createCli(runner))
  const handlers = new Map()
  m.contribute(m.rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, join(scratch, 'data'))
  const request = (name, input = {}) => handlers.get(name)(input)

  const world = await fleet.view()
  const projectIds = new Set([...world.projects.keys(), ...[...world.workspaces.values()].map((w) => w.projectId)])
  for (const projectId of projectIds) await request('board.scope', { kind: 'project', projectId, enabled: true })

  calls.length = 0
  const start = performance.now()
  const snapshot = await request('board.snapshot', { fresh: true })
  const wall = performance.now() - start
  const { count } = await request('board.decision-count')
  const nonJson = []
  const walk = (v, path) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number') { if (!Number.isFinite(v)) nonJson.push(path + ' = ' + v); return }
    if (v === undefined || typeof v === 'function' || typeof v === 'bigint' || typeof v === 'symbol') { nonJson.push(path + ' : ' + typeof v); return }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + '[' + i + ']')); return }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) { nonJson.push(path + ' : ' + (v.constructor?.name ?? 'object')); return }
    for (const [k, x] of Object.entries(v)) walk(x, path + '.' + k)
  }
  walk(snapshot, 'snapshot')
  console.log('non-JSON values:', nonJson.length, nonJson.slice(0, 15))

  const tally = (pick) => snapshot.sessions.reduce((acc, row) => ({ ...acc, [pick(row)]: (acc[pick(row)] ?? 0) + 1 }), {})
  const byVerb = calls.reduce((acc, c) => {
    acc[c.verb] ??= { calls: 0, ms: 0 }
    acc[c.verb].calls++
    acc[c.verb].ms += c.ms
    return acc
  }, {})
  console.log('orca:', exe)
  console.log('projects selected:', projectIds.size, '| sessions boarded:', snapshot.sessions.length, '| no orca_session_id yet:', world.unidentified)
  console.log('lanes:', tally((row) => row.lane))
  console.log('display lanes:', tally((row) => m.displayLane(row, snapshot.notes[row.id])))
  console.log('decision count:', count)
  console.log('human lane:')
  for (const row of snapshot.sessions.filter((r) => r.lane === 'human')) {
    console.log('  -', row.projectTitle, '/', row.title, '|', row.decision?.source ?? 'no card', '|', row.detail.replace(/\s+/g, ' ').slice(0, 140))
  }
  console.log('pull requests:', snapshot.pullRequests?.items.length ?? 0, 'open,', snapshot.pullRequests?.projects.map((p) => p.status).join(' ') ?? '')
  console.log('cold snapshot wall ms:', Math.round(wall))
  console.log('cold CLI calls:', calls.length, Object.fromEntries(Object.entries(byVerb).map(([verb, v]) => [verb, `${v.calls} calls, ${Math.round(v.ms)} ms`])))
  calls.length = 0
  const again = performance.now()
  await request('board.snapshot', { fresh: true })
  console.log('warm snapshot wall ms:', Math.round(performance.now() - again), '| CLI calls:', calls.map((c) => c.verb).join(', '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
