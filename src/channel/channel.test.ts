import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { runCli, type CliIo } from '../cli/run'
import type { ChannelRequest } from './protocol'
import { serveChannel } from './server'
import { createCli } from '../orca/cli'

const closers: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

const pipe = () => process.platform === 'win32' ? '\\\\.\\pipe\\cb-test-' + randomUUID() : join(tmpdir(), 'cb-test-' + randomUUID() + '.sock')

function io(path: string, env: Record<string, string> = {}, files: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  const value: CliIo = {
    env: { CB_PIPE: path, CB_TERMINAL: 'term_1', CB_CALLER_TOKEN: 'tok', ...env },
    readText: async (name) => { if (!(name in files)) throw new Error('no file ' + name); return files[name] },
    stdout: (t) => { out.push(t) }, stderr: (t) => { err.push(t) }, defaultPipe: path, timeoutMs: 2_000
  }
  return { value, out, err }
}

test('a command reaches the worker as one request with its caller, input from flags and files, and prints the reply', async () => {
  const path = pipe()
  const seen: ChannelRequest[] = []
  const server = await serveChannel(path, async (request) => { seen.push(request); return { exit: 0, text: '[]' } })
  closers.push(server.close)
  const t = io(path, {}, { '-': 'Ship it?\n100% & ^done', 'in.json': '{"content":{"question":"Ship?"},"kind":"review"}' })
  expect(await runCli(['classify', '--input-file', 'in.json', '--session', 's1', '--evidence', 'e1', '--kind', 'question', '--text-file', '-'], t.value)).toBe(0)
  expect(t.out.join('')).toBe('[]\n')
  expect(seen).toEqual([{ v: 2, command: 'classify', caller: { terminal: 'term_1', token: 'tok', session: null },
    input: { content: { question: 'Ship?' }, kind: 'question', sessionId: 's1', evidenceId: 'e1', text: 'Ship it?\n100% & ^done' } }])
})

test('exit codes: refused, failed, board not running, and a connection lost after sending', async () => {
  const path = pipe()
  const server = await serveChannel(path, async (request) => request.command === 'read'
    ? { exit: 4, text: 'not the coordinator' } : { exit: 1, text: 'not yet' })
  closers.push(server.close)
  const denied = io(path)
  expect(await runCli(['read'], denied.value)).toBe(4)
  expect(denied.err.join('')).toBe('not the coordinator\n')
  expect(await runCli(['plan'], io(path).value)).toBe(1)
  expect(await runCli(['nope'], io(path).value)).toBe(1)
  expect(await runCli(['read'], io(pipe()).value)).toBe(2)

  const silent = pipe()
  const mute = createServer((socket) => socket.once('data', () => socket.destroy()))
  await new Promise<void>((done) => mute.listen(silent, done))
  closers.push(() => new Promise<void>((done) => mute.close(() => done())))
  expect(await runCli(['report', '--kind', 'review', '--text-file', '-'], io(silent, {}, { '-': 'done' }).value)).toBe(3)
})

test('protocol 2: the worker runs orca in the caller\'s shell while it answers, and a lost caller fails the run', async () => {
  const path = pipe()
  const server = await serveChannel(path, async (_request, exec) => {
    const cli = createCli(exec)
    const launched = await cli.write('agent launch', ['--agent', 'claude', '--prompt', 'one\ntwo'])
    return { exit: 0, text: JSON.stringify(launched) }
  })
  closers.push(server.close)
  const ran: { args: readonly string[]; timeoutMs: number }[] = []
  const t = io(path)
  t.value.runOrca = async (args, timeoutMs) => {
    ran.push({ args, timeoutMs })
    return { stdout: JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal', handle: 'term_9' } } }), error: null }
  }
  expect(await runCli(['assign', '--input-file', 'job.json'], { ...t.value, readText: async () => '{"job":{}}' })).toBe(0)
  expect(ran).toEqual([{ args: ['agent', 'launch', '--agent', 'claude', '--prompt', 'one\ntwo', '--json'], timeoutMs: 60_000 }])
  expect(JSON.parse(t.out.join(''))).toEqual({ kind: 'ok', result: { outcome: { kind: 'terminal', handle: 'term_9' } } })

  const lost = pipe()
  let outcome: unknown
  const second = await serveChannel(lost, async (_request, exec) => {
    outcome = await createCli(exec).write('agent launch', ['--agent', 'claude'])
    return { exit: 0, text: 'late' }
  })
  closers.push(second.close)
  const { connect } = await import('node:net')
  await new Promise<void>((done) => {
    const socket = connect(lost, () => socket.write(JSON.stringify({ v: 2, command: 'assign', input: {}, caller: { terminal: null, token: null, session: null } }) + '\n'))
    socket.on('data', () => { socket.destroy(); setTimeout(done, 50) })
  })
  expect(outcome).toMatchObject({ kind: 'ambiguous' })
  const v1 = pipe()
  const third = await serveChannel(v1, async (_request, exec) => ({ exit: 0, text: String(exec) }))
  closers.push(third.close)
  const reply = await new Promise<string>((done) => {
    let data = ''
    const socket = connect(v1, () => socket.write(JSON.stringify({ v: 1, command: 'read', input: {}, caller: { terminal: null, token: null, session: null } }) + '\n'))
    socket.on('data', (chunk) => { data += chunk })
    socket.on('close', () => done(data))
  })
  expect(JSON.parse(reply)).toEqual({ exit: 0, text: 'null' })
})

test('the worker end refuses a request that is not one JSON line of the protocol', async () => {
  const path = pipe()
  const server = await serveChannel(path, async () => ({ exit: 0, text: 'ok' }))
  closers.push(server.close)
  const { connect } = await import('node:net')
  const ask = (line: string) => new Promise<string>((resolve) => {
    let data = ''
    const socket = connect(path, () => socket.write(line))
    socket.on('data', (chunk) => { data += chunk })
    socket.on('close', () => resolve(data))
  })
  expect(JSON.parse(await ask('nope\n'))).toEqual({ exit: 1, text: 'request is not JSON' })
  expect(JSON.parse(await ask('{"v":1,"command":"rm","input":{},"caller":{"terminal":null,"token":null,"session":null}}\n')).exit).toBe(1)
})
