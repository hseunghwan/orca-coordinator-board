// Live proof of the board's work items (src/server/work-items.ts) through the real coordinator. Run only once the
// loaded development plugin runs this code (board.work-items answers). Steps, each its own run:
//   send   --coordinator <id> --path <workspace path> --yes   routes grade D to Haiku (keeping the old value in the
//                                                             probe's folder) and asks the coordinator for ONE worker
//                                                             with a doneMeans; the worker answers once and runs nothing
//   items  --coordinator <id>                                 read only: the probe's work item and the worker's Orca state
//   report --coordinator <id> --yes                           asks the worker for one `report --kind done`
//   read   --coordinator <id> --yes                           asks the coordinator to run read and answer the worker's work field
//   answer --coordinator <id>                                 read only: the coordinator's last answer (the work field it read)
//   close  --terminal <term_…> --yes                          closes the worker's terminal and restores grade D
// Prints ids, phases and states; the only session text is the coordinator's answer to the read step.
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
const state = join(tmpdir(), 'board-work-probe')
mkdirSync(state, { recursive: true })
const PLUGIN = 'local.coordinator-board'
const requestKey = 'probe-work-' + createHash('sha256').update(flag('--coordinator') ?? '').digest('hex').slice(0, 16)
const doneMeans = '작업자가 준비됨이라고 답하고, 요청을 받으면 report --kind done으로 한 번 보고한다.'

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
const messageId = (key) => createHash('sha256').update('probe-work/' + key).digest('hex').replace(/^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*/, '$1-$2-4$3-8$4-$5')
const yes = () => { if (!args.includes('--yes')) throw new Error(step + ' needs --yes: it sends one message') }

function launch() {
  const journal = JSON.parse(readFileSync(join(homedir(), '.orca-coordinator-board', 'workers.json'), 'utf8'))
  return journal.launches[requestKey]
}

if (step === 'send') {
  yes()
  const coordinator = flag('--coordinator')
  const path = flag('--path')?.replace(/\\/g, '/').toLowerCase()
  const world = await fleet.view({ maxAgeMs: 0 })
  const session = world.sessions.get(coordinator)
  const workspace = [...world.workspaces.values()].find((w) => !w.archived && w.path.replace(/\\/g, '/').toLowerCase() === path)
  const ops = rpc('board.operations', {})
  if (!session || session.surface !== 'terminal' || !workspace || !ops.catalog.some((c) => c.provider === 'claude' && c.model === 'haiku')) throw new Error('not ready')
  if (!existsSync(join(state, 'routing-d.json'))) writeFileSync(join(state, 'routing-d.json'), JSON.stringify({ candidates: ops.routing.D ?? [] }))
  rpc('board.update-routing', { grade: 'D', candidates: [{ provider: 'claude', model: 'haiku', effort: null }], expectedRevision: ops.revision })
  const prompt = '준비됨이라고만 답하세요. 파일을 읽거나 고치거나 명령을 실행하지 마세요. 보드 보고도 아직 하지 마세요.'
  const text = [
    '[보드 작업 단계 실기 확인] 아래 순서대로 한 번씩만 하고 다른 일은 하지 마세요. coordinator-board가 PATH에 없으면 CB_BIN 폴더의 같은 이름 파일을 실행하세요.',
    '1. coordinator-board plan 을 실행하세요.',
    '2. 결과의 workspaces에서 id가 "::' + workspace.path.replace(/\\/g, '/') + '"로 끝나는 항목과 routes의 grade D 항목으로 아래 JSON을 만들어 coordinator-board assign --input-file - 에 표준 입력으로 넘기세요.',
    JSON.stringify({ job: { projectId: '<그 워크스페이스의 projectId>', workspaceId: '<그 워크스페이스의 id>', grade: 'D', title: '작업 단계 실기 확인', prompt, doneMeans,
      requestKey, expectedRoute: '<grade D의 route>', expectedModeId: '<grade D의 expectedModeId>' } }),
    '3. assign이 출력한 JSON을 그대로 답하세요. 실패하면 오류 글을 그대로 답하고 다시 시도하지 마세요.'
  ].join('\n')
  console.log('send:', await fleet.deliver({ messageId: messageId('send/' + requestKey), to: session.id, text, subject: 'Coordinator Board', from: { kind: 'person' }, whenWorking: 'refuse' }))
} else if (step === 'items') {
  const l = launch()
  const items = rpc('board.work-items', {}).items
  const world = await fleet.view({ maxAgeMs: 0 })
  const worker = l?.sessionId ? world.sessions.get(l.sessionId) : null
  console.log({ launch: l ? { state: l.state, sessionId: l.sessionId, terminal: l.handle } : null,
    item: l?.sessionId ? items[l.sessionId] ?? null : null,
    worker: worker ? { state: worker.state, unread: worker.unread, livePty: worker.livePty } : null })
} else if (step === 'report') {
  yes()
  const l = launch()
  if (!l?.sessionId) throw new Error('no worker session yet')
  const text = '[보드 작업 단계 실기 확인] 이제 맡은 일을 마친 것으로 보고하세요. 처음 프롬프트에 적힌 절대 경로의 coordinator-board로 report --kind done --text-file - 를 한 번 실행하고, 표준 입력으로 "준비됨이라고 답했습니다. 실기 확인용 완료 보고입니다."를 넘기세요. 다른 일은 하지 마세요.'
  console.log('report:', await fleet.deliver({ messageId: messageId('report/' + requestKey), to: l.sessionId, text, subject: 'Coordinator Board', from: { kind: 'person' }, whenWorking: 'refuse' }))
} else if (step === 'read') {
  yes()
  const l = launch()
  if (!l?.sessionId) throw new Error('no worker session yet')
  const text = '[보드 작업 단계 실기 확인] coordinator-board read 를 한 번 실행하고, 목록에서 id가 "' + l.sessionId + '"인 행의 work 필드만 JSON 그대로 답하세요. 다른 일은 하지 마세요.'
  console.log('read:', await fleet.deliver({ messageId: messageId('read/' + requestKey + '/' + Date.now()), to: flag('--coordinator'), text, subject: 'Coordinator Board', from: { kind: 'person' }, whenWorking: 'refuse' }))
} else if (step === 'answer') {
  const read = orca(['agent', 'read', 'orca_session_id:' + flag('--coordinator'), '--limit', '6']).result
  const last = read.entries.filter((e) => e.kind === 'message' && e.role === 'assistant').at(-1)
  console.log({ entries: read.entries.map((e) => e.kind + (e.role ? ':' + e.role : '') + (e.toolName ? ':' + e.toolName : '')), answer: last?.text?.slice(-600) ?? null })
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
  console.error('usage: node scripts/probe-work.mjs send|items|report|read|answer|close (see the top of this file)')
  process.exit(1)
}
