// Sends ONE decision reply through the worker's real send path (board.send-decision -> fleet.deliver ->
// orca CLI) to the session named, then prints the receipt, the outbox record and what reconciling with
// the session's transcript finds. It sends a real message, so it refuses without --session and --yes.
// Usage: node scripts/probe-send.mjs --session <orcaSessionId> --yes [--from <term_handle>] [--data <dir>] [--key <requestKey>]
// --from stands in for the board's own mail terminal on the chat route (the worker opens one; a probe
// must not), so give the handle of a terminal you own.
// --data keeps the board data (outbox, receipts) to run again: the same --key then only reconciles.
// The output names real sessions: read it, do not commit it.
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const session = flag('--session')
if (!session || !args.includes('--yes')) {
  console.error('refusing: give --session <orcaSessionId> and --yes; this sends a real message')
  process.exit(2)
}
const data = flag('--data') ?? mkdtempSync(join(tmpdir(), 'board-send-probe-'))
mkdirSync(data, { recursive: true })
const key = flag('--key') ?? 'probe-' + randomUUID().replace(/-/g, '').slice(0, 24)
const NOTE = '코디네이터 보드 전송 시험입니다. 답하지 않아도 됩니다.'
const TEXT = '코디네이터 보드의 전송 시험 메시지입니다(보드 워커 경로). 작업과 관계없으니 답하거나 행동하지 않아도 됩니다.'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'board-probe-build-'))
try {
  const bundle = join(scratch, 'probe.mjs')
  await build({
    stdin: {
      contents: [
        "export { createFleet } from './src/orca/index.ts'",
        "export { cliEnv, createCli, execRunner, locateOrca } from './src/orca/cli.ts'",
        "export { readMarked } from './src/orca/conversation.ts'",
        "export { Outbox } from './src/orca/deliver.ts'",
        "export { contribute } from './src/server/board.ts'",
        "export { rpcServer } from './src/server/rpc.ts'",
        "export { NoteStore } from './src/paseo/server/notes.ts'"
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
  const from = flag('--from') ?? null
  const fleet = m.createFleet(cli, Date.now, { dataDir: data, mailSender: async () => from })
  const deliver = fleet.deliver
  fleet.deliver = async (delivery) => {
    const outcome = await deliver(delivery)
    console.log('deliver:', outcome)
    return outcome
  }
  const handlers = new Map()
  m.contribute(m.rpcServer((name, fn) => handlers.set(name, fn), fleet.paseo), fleet, data)
  const request = (name, input = {}) => handlers.get(name)(input)

  const world = await fleet.view({ maxAgeMs: 0 })
  const target = world.sessions.get(session)
  if (!target) throw new Error('no such session in orca worktree ps')
  const projectId = world.workspaces.get(target.worktree)?.projectId
  console.log('target:', { surface: target.surface, state: target.state, handle: !!target.handle, projectId })
  await request('board.scope', { kind: 'project', projectId, enabled: true })

  let row = (await request('board.snapshot', { fresh: true })).sessions.find((s) => s.id === session)
  if (!row?.decision) {
    const notes = new m.NoteStore(join(data, 'notes.json'))
    const current = notes.visible(new Set([session]))[session]?.revision ?? 0
    notes.update({ sessionId: session, kind: 'question', text: NOTE, expectedRevision: current }, 'person')
    row = (await request('board.snapshot', { fresh: true })).sessions.find((s) => s.id === session)
  }
  if (!row?.decision) throw new Error('the board shows no card for this session: ' + (row ? row.lane + ' / ' + row.detail : 'not boarded'))
  console.log('card:', { lane: row.lane, source: row.decision.source, version: row.decision.version })

  const input = { projectId: row.projectId, sessionId: session, recipientId: session, version: row.decision.version, action: 'reply', text: TEXT, requestKey: key }
  let receipt = null
  try {
    receipt = await request('board.send-decision', input)
    console.log('receipt:', receipt)
  } catch (error) {
    console.log('send failed:', error instanceof Error ? error.message : String(error))
  }
  const records = new m.Outbox(join(data, 'outbox.json')).read()
  const record = Object.values(records).at(-1)
  console.log('outbox:', record ? { messageId: record.messageId, route: record.route, state: record.state, proof: record.proof, mailId: record.mailId } : 'none')
  if (record) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    console.log('reconcile:', await fleet.reconcile(record.messageId))
    const read = await cli.read('agent read', ['orca_session_id:' + session, '--limit', '100'], (r) => r)
    const entry = read.entries.find((e) => e.role === 'user' && e.text && m.readMarked(e.text)?.messageId === record.messageId)
    console.log('transcript entry first line:', entry ? entry.text.split('\n')[0] : 'not found')
  }
  console.log('data folder (pass as --data to reconcile again):', data)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
