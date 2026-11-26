// Live proof of worker dispatch through the real coordinator. Run only once the loaded development plugin runs
// this code (board.operations lists Haiku). Steps, each its own run:
//   check  --coordinator <id> --path <workspace path>          read only: the coordinator, the workspace, Haiku in the catalog
//   send   --coordinator <id> --path <workspace path> --yes    routes grade D to Haiku (keeping the old value in the
//                                                              probe's folder) and sends the coordinator ONE work request
//   verify --coordinator <id>                                  read only: the board's launch journal, the worker's session,
//                                                              the coordinator's transcript entry kinds
//   close  --terminal <term_…> --yes                           closes the worker's terminal and restores grade D
// Prints ids, counts and states; never session text. The new worker's PATH: scripts/probe-path.mjs --match <marker>.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [step, ...args] = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const state = join(tmpdir(), 'board-dispatch-probe')
mkdirSync(state, { recursive: true })
const PLUGIN = 'local.coordinator-board'
const requestKey = 'probe-dispatch-' + createHash('sha256').update(flag('--coordinator') ?? '').digest('hex').slice(0, 16)

const bundle = join(state, 'probe.mjs')
await build({
  stdin: { contents: "export { createFleet } from './src/orca/index.ts'\nexport { cliEnv, execRunner, locateOrca, createCli } from './src/orca/cli.ts'", resolveDir: root, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: bundle, logLevel: 'error'
})
const m = await import(pathToFileURL(bundle).href)
const exe = m.locateOrca({ platform: process.platform, execPath: process.execPath, env: process.env, exists: existsSync })
if (!exe) throw new Error('orca CLI not found')
const env = m.cliEnv(process.env, process.platform)
const orca = (argv) => JSON.parse(execFileSync(exe, [...argv, '--json'], { env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 }))
const rpc = (name, data) => orca(['plugin', 'dev', 'request', PLUGIN, name, '--data', JSON.stringify(data)]).result.result
const fleet = m.createFleet(m.createCli(m.execRunner(exe, env)), Date.now, { dataDir: state })

async function target() {
  const coordinator = flag('--coordinator')
  const path = flag('--path')?.replace(/\\/g, '/').toLowerCase()
  const world = await fleet.view({ maxAgeMs: 0 })
  const session = world.sessions.get(coordinator)
  const workspace = [...world.workspaces.values()].find((w) => !w.archived && w.path.replace(/\\/g, '/').toLowerCase() === path)
  return { world, session, workspace }
}

if (step === 'check' || step === 'send') {
  const { session, workspace } = await target()
  const ops = rpc('board.operations', {})
  const haiku = ops.catalog.some((c) => c.provider === 'claude' && c.model === 'haiku')
  console.log({ coordinator: session ? { surface: session.surface, state: session.state, terminal: !!session.handle } : null,
    workspace: workspace?.id ?? null, haikuInCatalog: haiku, gradeD: ops.routing.D ?? 'recommended', revision: ops.revision })
  if (step === 'send') {
    if (!args.includes('--yes')) throw new Error('send needs --yes: it sends one message to the coordinator')
    if (!session || session.surface !== 'terminal' || !workspace || !haiku) throw new Error('not ready: see the check above')
    if (!existsSync(join(state, 'routing-d.json'))) writeFileSync(join(state, 'routing-d.json'), JSON.stringify({ candidates: ops.routing.D ?? [] }))
    rpc('board.update-routing', { grade: 'D', candidates: [{ provider: 'claude', model: 'haiku', effort: null }], expectedRevision: ops.revision })
    const prompt = '준비됨이라고만 답하세요. 파일을 읽거나 고치거나 명령을 실행하지 마세요.'
    const text = [
      '[보드 배정 실기 확인] 아래 순서대로 한 번씩만 하고 다른 일은 하지 마세요. coordinator-board가 PATH에 없으면 CB_BIN 폴더의 같은 이름 파일을 실행하세요.',
      '1. coordinator-board plan 을 실행하세요.',
      '2. 결과의 workspaces에서 id가 "::' + workspace.path.replace(/\\/g, '/') + '"로 끝나는 항목과 routes의 grade D 항목으로 아래 JSON을 만들어 coordinator-board assign --input-file - 에 표준 입력으로 넘기세요.',
      JSON.stringify({ job: { projectId: '<그 워크스페이스의 projectId>', workspaceId: '<그 워크스페이스의 id>', grade: 'D', title: '배정 실기 확인', prompt,
        requestKey, expectedRoute: '<grade D의 route>', expectedModeId: '<grade D의 expectedModeId>' } }),
      '3. assign이 출력한 JSON을 그대로 답하세요. 실패하면 오류 글을 그대로 답하고 다시 시도하지 마세요.'
    ].join('\n')
    const messageId = createHash('sha256').update('probe-dispatch/' + requestKey).digest('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*/, '$1-$2-4$3-8$4-$5')
    console.log('send:', await fleet.deliver({ messageId, to: session.id, text, subject: 'Coordinator Board', from: { kind: 'person' }, whenWorking: 'refuse' }))
  }
} else if (step === 'verify') {
  const journal = JSON.parse(readFileSync(join(homedir(), '.orca-coordinator-board', 'workers.json'), 'utf8'))
  const launches = Object.values(journal.launches).filter((l) => l.requestKey === requestKey)
  const launch = launches[0]
  const world = await fleet.view({ maxAgeMs: 0 })
  const worker = launch?.sessionId ? world.sessions.get(launch.sessionId) : null
  const read = orca(['agent', 'read', 'orca_session_id:' + flag('--coordinator'), '--limit', '30']).result
  console.log({
    launches: launches.length, state: launch?.state, mode: launch?.modeId, route: launch?.route, terminal: launch?.handle, marker: launch && '[coordinator-board:' + launch.launchId + ']',
    worker: worker ? { surface: worker.surface, state: worker.state, agent: worker.agent } : null, metadata: launch?.sessionId ? journal.workers[launch.sessionId] : null,
    coordinatorEntries: read.entries.slice(-12).map((e) => e.kind + (e.role ? ':' + e.role : '') + (e.toolName ? ':' + e.toolName : ''))
  })
} else if (step === 'close') {
  if (!args.includes('--yes') || !flag('--terminal')) throw new Error('close needs --terminal <term_…> --yes')
  console.log('close:', orca(['terminal', 'close', '--terminal', flag('--terminal')]).ok)
  const saved = join(state, 'routing-d.json')
  if (existsSync(saved)) {
    const { revision } = rpc('board.operations', {})
    rpc('board.update-routing', { grade: 'D', candidates: JSON.parse(readFileSync(saved, 'utf8')).candidates, expectedRevision: revision })
    console.log('grade D restored')
  }
} else {
  console.error('usage: node scripts/probe-dispatch.mjs check|send|verify|close (see the top of this file)')
  process.exit(1)
}
