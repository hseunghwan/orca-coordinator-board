// The worker's end of the channel: one request line in, one reply line out, then the connection closes.
import { rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { channelRequest, EXIT, MAX_LINE, type ChannelReply, type ChannelRequest } from './protocol'

export type Answer = (request: ChannelRequest) => Promise<ChannelReply>

function reply(socket: Socket, value: ChannelReply): void {
  socket.end(JSON.stringify(value) + '\n')
}

export function serveChannel(path: string, answer: Answer): Promise<{ close(): Promise<void> }> {
  const server: Server = createServer((socket) => {
    let buffer = ''
    let done = false
    socket.setEncoding('utf8')
    socket.on('error', () => undefined)
    socket.on('data', (chunk: string) => {
      if (done) return
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0 && buffer.length <= MAX_LINE) return
      done = true
      if (end < 0) return reply(socket, { exit: EXIT.error, text: 'request too long' })
      let parsed: ReturnType<typeof channelRequest.safeParse>
      try {
        parsed = channelRequest.safeParse(JSON.parse(buffer.slice(0, end)))
      } catch {
        return reply(socket, { exit: EXIT.error, text: 'request is not JSON' })
      }
      if (!parsed.success) return reply(socket, { exit: EXIT.error, text: 'malformed request: ' + parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ') })
      answer(parsed.data).then((value) => reply(socket, value), (error: unknown) =>
        reply(socket, { exit: EXIT.error, text: error instanceof Error ? error.message : String(error) }))
    })
  })
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
