// The worker's end of the channel: one request line in, one reply line out, then the connection closes.
// A protocol 2 request also lets the worker run orca in the caller's shell meanwhile (ExecFrame).
import { rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { CliError, type Runner } from '../orca/cli'
import { channelRequest, execResult, EXIT, MAX_LINE, type ChannelReply, type ChannelRequest, type ExecFrame } from './protocol'

/** exec runs orca in the caller's shell; null for a protocol 1 request. */
export type Answer = (request: ChannelRequest, exec: Runner | null) => Promise<ChannelReply>

function reply(socket: Socket, value: ChannelReply): void {
  socket.end(JSON.stringify(value) + '\n')
}

function serve(socket: Socket, answer: Answer): void {
  let buffer = ''
  let request: ChannelRequest | null = null
  let done = false
  let nextId = 0
  const pending = new Map<number, { resolve(stdout: string): void; reject(error: Error): void }>()
  const dropAll = () => {
    for (const entry of pending.values()) entry.reject(new CliError('the caller\'s command went away while orca ran', 'exec_failed'))
    pending.clear()
  }
  const exec: Runner = (args, timeoutMs) => new Promise((resolve, reject) => {
    if (done || socket.destroyed) return reject(new CliError('the caller\'s command went away', 'exec_failed'))
    const id = ++nextId
    pending.set(id, { resolve, reject })
    const frame: ExecFrame = { kind: 'exec', id, args: [...args], timeoutMs }
    socket.write(JSON.stringify(frame) + '\n')
  })
  const finish = (value: ChannelReply) => {
    if (done) return
    done = true
    dropAll()
    reply(socket, value)
  }
  socket.setEncoding('utf8')
  socket.on('error', () => undefined)
  socket.on('close', () => { done = true; dropAll() })
  socket.on('data', (chunk: string) => {
    if (done) return
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0 && !done; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (request) {
        let parsed: ReturnType<typeof execResult.safeParse>
        try { parsed = execResult.safeParse(JSON.parse(line)) } catch { continue }
        if (!parsed.success) continue
        const entry = pending.get(parsed.data.id)
        if (!entry) continue
        pending.delete(parsed.data.id)
        if (parsed.data.error) entry.reject(new CliError(parsed.data.error.message, parsed.data.error.code))
        else entry.resolve(parsed.data.stdout)
        continue
      }
      let parsed: ReturnType<typeof channelRequest.safeParse>
      try {
        parsed = channelRequest.safeParse(JSON.parse(line))
      } catch {
        return finish({ exit: EXIT.error, text: 'request is not JSON' })
      }
      if (!parsed.success) return finish({ exit: EXIT.error, text: 'malformed request: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ') })
      request = parsed.data
      answer(request, request.v === 2 ? exec : null).then(finish, (error: unknown) =>
        finish({ exit: EXIT.error, text: error instanceof Error ? error.message : String(error) }))
    }
    if (buffer.length > MAX_LINE) finish({ exit: EXIT.error, text: request ? 'exec answer too long' : 'request too long' })
  })
}

export function serveChannel(path: string, answer: Answer): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer((socket) => serve(socket, answer))
  // A socket file left by a worker that died keeps listen from binding; a named pipe leaves none.
  if (process.platform !== 'win32') rmSync(path, { force: true })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) })
    })
  })
}
