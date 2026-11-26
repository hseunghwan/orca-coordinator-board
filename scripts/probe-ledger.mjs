// Live checks for board facts, the ledger and pull requests, on the real orca CLI and gh, with the
// board data in a temporary folder so the person's own board is untouched. The output names real
// sessions and repositories: read it, do not commit it.
//
//   prs --scope <scope.json> [--pr <owner/repo>#<n>]
//                                    read only: each project's repository mapping, the open PR count,
//                                    and for one open PR (or the one named) its lifecycle and a merge
//                                    preview (GitHub GraphQL read; no merge is ever confirmed here)
//   mail --to <session> --as-agent <session> --yes
//   mail --to <session> --as-board <term_handle> --yes
//                                    sends ONE information-only mail signed by that agent's terminal or by
//                                    the given board terminal, then reads it back as the recipient's
//                                    evidence. Run it from a process outside every Orca terminal (as the
//                                    worker is), or Orca may take the calling terminal as the sender.
//   review --coordinator <session> [--ledger-session <session>] [--send --yes] [--wait <s>]
//                                    serves this checkout's worker on a temporary pipe, names the session
//                                    coordinator of its project there, and checks `coordinator-board review`
//                                    as that terminal; with --send it asks the coordinator ONCE to run the
//                                    same command and waits for the call. Run `npm run build` first.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [mode, ...args] = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'board-ledger-probe-'))
const data = join(scratch, 'data')
mkdirSync(data)

async function load() {
  const bundle = join(scratch, 'probe.mjs')
  await build({
    stdin: {
      contents: [
        "export { activateWith, hostFiles } from './src/worker.ts'",
        "export { createFleet } from './src/orca/index.ts'",
        "export { cliEnv, createCli, execRunner, locateOrca } from './src/orca/cli.ts'",
        "export { contribute } from './src/server/board.ts'",
        "export { rpcServer } from './src/server/rpc.ts'",
        "export { excerpt } from './src/server/conversation.ts'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: bundle, logLevel: 'error'
  })
  const m = await import(pathToFileURL(bundle).href)
  const exe = m.locateOrca({ platform: process.platform, execPath: process.execPath, env: process.env, exists: existsSync })
  if (!exe) throw new Error('orca CLI not found')
  return { m, cli: m.createCli(m.execRunner(exe, m.cliEnv(process.env, process.platform))) }
}

function board(m, fleet) {
  const handlers = new Map()
  const live = m.contribute(m.rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, data)
  return { live, request: (name, input = {}) => handlers.get(name)(input) }
}

async function prs() {
  const scope = JSON.parse(readFileSync(flag('--scope'), 'utf8'))
  const { m, cli } = await load()
  const fleet = m.createFleet(cli, Date.now, { dataDir: data })
  const { request } = board(m, fleet)
  for (const projectId of scope.projects) await request('board.scope', { kind: 'project', projectId, enabled: true })
  const snap = await request('board.snapshot', { fresh: true })
  console.log('projects:', snap.pullRequests.projects.map((p) => ({ projectId: p.projectId.slice(0, 8), mode: p.mode, status: p.status, repo: p.repo })))
  console.log('open PRs:', snap.pullRequests.items.length, 'ready:', snap.pullRequests.items.filter((p) => p.lane === 'review').length)
  const named = flag('--pr')?.split('#')
  const mapped = named && snap.pullRequests.projects.find((p) => p.repo === named[0])
  const pr = named ? (mapped && { projectIds: [mapped.projectId], repo: named[0], number: Number(named[1]), reason: 'named' })
    : snap.pullRequests.items.find((p) => p.lane === 'review') ?? snap.pullRequests.items[0]
  if (!pr) return
  const target = { projectId: pr.projectIds[0], repo: pr.repo, number: pr.number }
  console.log('target:', { repo: pr.repo, number: pr.number, reason: pr.reason })
  console.log('lifecycle:', await request('board.read-pull-lifecycle', target))
  const preview = await request('board.preview-pull-request-merge', target)
  console.log('preview:', { status: preview.status, reason: preview.reason, methods: preview.methods, defaultMethod: preview.defaultMethod, voucher: !!preview.token })
}

async function mail() {
  const to = flag('--to'), agent = flag('--as-agent'), boardTerminal = flag('--as-board')
  if (!to || !(agent || boardTerminal) || !args.includes('--yes')) throw new Error('give --to, --as-agent or --as-board, and --yes: this sends a real message')
  const { m, cli } = await load()
  const fleet = m.createFleet(cli, Date.now, { dataDir: data, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), mailSender: async () => boardTerminal ?? null })
  const messageId = randomUUID()
  const text = agent
    ? JSON.stringify({ type: 'coordinator-board.fact', authority: 'information-only', evidenceId: 'probe', answer: '코디네이터 보드 발신자 시험입니다. 답하거나 행동하지 않아도 됩니다.', source: 'Coordinator Board probe' })
    : '[Coordinator Board · probe]\n보드 메일 발신자 시험입니다. 답하거나 행동하지 않아도 됩니다.'
  const outcome = await fleet.deliver({ messageId, to, text, subject: 'Coordinator Board probe', from: agent ? { kind: 'agent', session: agent } : { kind: 'board' }, whenWorking: 'refuse' })
  console.log('deliver:', outcome)
  await new Promise((r) => setTimeout(r, 2000))
  fleet.invalidate()
  await fleet.view({ maxAgeMs: 0 })
  const page = await fleet.paseo.agents.ref(to).timeline.refetch({ direction: 'tail', projection: 'projected', limit: 48 })
  const found = page.entries.map((e) => e.item).find((i) => (i.type === 'tool_call' && i.callId === 'paseo-agent-message:' + messageId) || (i.type === 'user_message' && i.messageId === messageId))
  console.log('read back as:', found ? (found.type === 'tool_call' ? { type: found.type, sender: found.agentMessage.sender.id, sameBody: createHash('sha256').update(found.agentMessage.text).digest('hex') === createHash('sha256').update(text).digest('hex') } : { type: found.type }) : 'not found')
  if (!page.gap) console.log('evidence deliveries:', (m.excerpt(page).deliveries ?? []).filter((d) => d.id === messageId))
}

async function review() {
  const coordinator = flag('--coordinator')
  if (!coordinator) throw new Error('give --coordinator <session>')
  if (!existsSync(join(root, 'dist', 'cli.cjs'))) throw new Error('run npm run build first')
  const { m, cli } = await load()
  const storage = new Map(), handlers = new Map(), hooks = new Map()
  const orca = {
    storage: { get: async (k) => storage.get(k) ?? null, set: async (k, v) => { storage.set(k, v) }, delete: async (k) => { storage.delete(k) }, onDidChange: () => ({ dispose() {} }) },
    hooks: { on: (name, fn) => { hooks.set(name, fn); return { dispose() {} } } },
    events: { on: () => ({ dispose() {} }) },
    commands: { register: () => ({ dispose() {} }) },
    panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } }, post() {} },
    host: { call: async (method) => { if (method === 'workspace.list') return { workspaces: [], truncated: false }; if (method === 'statusBar.update') return { ok: true }; if (method === 'workspace.readContext') return null; throw new Error('not in the probe host: ' + method) } },
    log: (message) => { if (!message.startsWith('launch hook')) console.log('[worker]', message) }
  }
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\cb-probe-' + randomUUID() : join(scratch, 'channel.sock')
  const stop = m.activateWith(orca, { cli, dataDir: data, files: m.hostFiles, pollMs: 0, channel: { path: pipe, bin: join(root, 'bin'), node: process.execPath } })
  const request = (name, input = {}) => handlers.get(name)(input, {})
  const fleet = m.createFleet(cli, Date.now, { dataDir: join(scratch, 'send') })
  const world = await fleet.view({ maxAgeMs: 0 })
  const session = world.sessions.get(coordinator)
  if (!session?.handle) throw new Error('the coordinator is not a terminal session Orca lists')
  const projectId = world.workspaces.get(session.worktree).projectId
  const ledgerSession = flag('--ledger-session')
  if (ledgerSession) writeFileSync(join(data, 'tracked-decisions.json'), JSON.stringify({ version: 1, items: [
    { source: 'probe', projectId, id: 'probe-check', title: 'Probe check (no action needed)', where: 'manager', kind: 'check', sessionId: ledgerSession }
  ] }))
  await request('board.scope', { kind: 'project', projectId, enabled: true })
  await request('board.scope', { kind: 'coordinator', sessionId: coordinator })
  const decided = await hooks.get('agent.launch.before')({ agent: 'claude', workspaceId: null, workspaceKind: null, terminalId: session.handle, command: "claude 'x'", env: {} }, (event) => ({ continued: event }))
  const env = decided.continued.env
  const shim = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', join(root, 'bin', 'coordinator-board.cmd')]] : ['sh', [join(root, 'bin', 'coordinator-board')]]
  const local = await new Promise((resolve) => {
    const child = spawn(shim[0], [...shim[1], 'review'], { env: { ...process.env, ...env }, windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ exit: code, text: out.trim() }))
  })
  console.log('review as that terminal, from here:', local)
  const bin = join(root, 'bin', 'coordinator-board').replace(/\\/g, '/')
  const command = "CB_PIPE='" + env.CB_PIPE + "' CB_TERMINAL='" + env.CB_TERMINAL + "' CB_CALLER_TOKEN='" + env.CB_CALLER_TOKEN + "' '" + bin + "' review"
  if (flag('--hold')) {
    console.log('serving for ' + flag('--hold') + ' s; the command:\n' + command)
    await new Promise((r) => setTimeout(r, Number(flag('--hold')) * 1000))
  }
  if (!args.includes('--send')) return stop()
  if (!args.includes('--yes')) throw new Error('--send needs --yes: it sends the coordinator one request')
  // Claude Code's Bash tool on Windows turns \\ into \ in a command line (observed 2026-11-26), which breaks an
  // inline pipe name; a script file keeps it whole.
  const script = join(scratch, 'review.sh')
  writeFileSync(script, command + '\necho "EXIT=$?"\n')
  const text = '[coordinator-board]\n보드 시험 요청입니다. Bash에서 `bash \'' + script.replace(/\\/g, '/') + '\'` 를 한 번만 실행하고, 출력을 그대로 보고해 주세요. 다른 명령이나 작업은 하지 마세요.'
  const outcome = await fleet.deliver({ messageId: randomUUID(), to: coordinator, text, subject: 'Coordinator Board probe', from: { kind: 'person' }, whenWorking: 'refuse' })
  console.log('request:', outcome)
  const wait = Number(flag('--wait') ?? 240) * 1000
  const started = Date.now()
  let answered = null
  while (Date.now() - started < wait) {
    await new Promise((r) => setTimeout(r, 5000))
    fleet.invalidate()
    const now = (await fleet.view({ maxAgeMs: 0 })).sessions.get(coordinator)
    if (now?.state === 'done' && now.lastAssistant !== session.lastAssistant) { answered = now.lastAssistant; break }
  }
  console.log('coordinator answer:', answered ?? 'none within the wait')
  stop()
}

try {
  if (mode === 'prs') await prs()
  else if (mode === 'mail') await mail()
  else if (mode === 'review') await review()
  else { console.error('usage: node scripts/probe-ledger.mjs prs|mail|review ... (see the head of this file)'); process.exitCode = 2 }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
