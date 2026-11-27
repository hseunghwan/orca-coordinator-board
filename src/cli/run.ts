// The coordinator-board command an agent runs: reads its input from flags, files and stdin, sends one
// request to the board's worker, and prints the reply. Exit codes: 0 done, 1 the command failed,
// 2 the board is not running, 3 the connection broke after sending (it may have been done), 4 refused.
import { connect } from 'node:net'
import { COMMANDS, EXIT, MAX_LINE, type Command, type ExecFrame, type ExecResult } from '../channel/names'
import type { CallerClaim } from '../channel/protocol'

export const USAGE = [
  'Usage: coordinator-board <command> [options]',
  '',
  'Commands (one per Paseo coordinator tool):',
  '  read [--session <id>]                     list managed sessions (your own row has "self": true), or read one',
  '                                            session\'s recent turns and evidenceId',
  '  classify --session <id> --evidence <id> --kind question|review|idle --text-file <path|->',
  '                                            record a judgment on the session\'s card (content via --input-file)',
  '  report --kind question|review|done --text-file <path|->',
  '                                            post a question or a result on your own card',
  '  fact --cycle <cycleId> --session <id> --evidence <id>',
  '                                            during a digest that names a cycle, answer a board fact for that session',
  '  review [--input-file <path|->]            without input, close merged-only records and list checks to review;',
  '                                            with {"review":{key,fingerprint,evidenceId,quote}}, close one finished check',
  '  plan [--input-file <path|->]               list managed projects, workspaces, sessions and the route for each grade',
  '                                            ({"needsHooks":true} when the work needs Claude Code or Codex hooks)',
  '  assign --input-file <path|->              start one worker for a job: {"job":{projectId,workspaceId,grade,title,prompt,',
  '                                            requestKey,expectedRoute,expectedModeId?,doneMeans?}}; the same requestKey never starts twice',
  '  verify --item <itemId> --result pass|fail --text-file <path|->',
  '                                            confirm a reported work item (done), or send it back with the reason',
  '',
  'Options:',
  '  --input-file <path|->   the full input as a JSON object; flags override its fields',
  '  --text-file <path|->    free text (\'-\' reads stdin); never pass free text as an argument',
  '  --as <sessionId>        a chat session reporting on its own card (report only)',
  '',
  'Exit codes: 0 done, 1 command error, 2 board not running, 3 connection lost after sending, 4 not allowed.'
].join('\n')

const FLAGS: Readonly<Record<string, string>> = { '--session': 'sessionId', '--evidence': 'evidenceId', '--kind': 'kind', '--cycle': 'cycleId', '--item': 'itemId', '--result': 'result' }

export type CliIo = {
  env: Readonly<Record<string, string | undefined>>
  /** A path, or '-' for stdin. */
  readText(path: string): Promise<string>
  stdout(text: string): void
  stderr(text: string): void
  /** Where the worker listens when CB_PIPE is not set. */
  defaultPipe: string
  timeoutMs?: number
  /** Runs orca with these arguments in this shell, for the board (protocol 2). */
  runOrca?(args: readonly string[], timeoutMs: number): Promise<Pick<ExecResult, 'stdout' | 'error'>>
}

type Parsed = { command: Command; input: Record<string, unknown>; as: string | null } | { help: true } | { error: string }

export async function parseArgs(argv: readonly string[], io: Pick<CliIo, 'readText'>): Promise<Parsed> {
  const [command, ...rest] = argv
  if (!command || command === '--help' || command === 'help') return { help: true }
  if (!(COMMANDS as readonly string[]).includes(command)) return { error: 'unknown command: ' + command }
  let input: Record<string, unknown> = {}
  const set: Record<string, unknown> = {}
  let as: string | null = null
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i]
    const value = rest[i + 1]
    if (name === '--help') return { help: true }
    if (value === undefined) return { error: 'missing value for ' + name }
    if (name === '--input-file') {
      const parsed: unknown = JSON.parse(await io.readText(value))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: '--input-file must hold a JSON object' }
      input = parsed as Record<string, unknown>
    } else if (name === '--text-file') set.text = await io.readText(value)
    else if (name === '--as') as = value
    else if (FLAGS[name]) set[FLAGS[name]] = value
    else return { error: 'unknown option: ' + name }
  }
  return { command: command as Command, input: { ...input, ...set }, as }
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: Parsed
  try {
    parsed = await parseArgs(argv, io)
  } catch (error) {
    io.stderr('coordinator-board: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    return EXIT.error
  }
  if ('help' in parsed) {
    io.stdout(USAGE + '\n')
    return EXIT.ok
  }
  if ('error' in parsed) {
    io.stderr('coordinator-board: ' + parsed.error + '\n\n' + USAGE + '\n')
    return EXIT.error
  }
  const caller: CallerClaim = {
    terminal: io.env.CB_TERMINAL || null,
    token: io.env.CB_CALLER_TOKEN || null,
    session: parsed.as
  }
  const line = JSON.stringify({ v: 2, command: parsed.command, input: parsed.input, caller }) + '\n'
  if (line.length > MAX_LINE) {
    io.stderr('coordinator-board: input too long\n')
    return EXIT.error
  }
  const path = io.env.CB_PIPE || io.defaultPipe
  return new Promise<number>((resolve) => {
    let sent = false
    let buffer = ''
    let settled = false
    const finish = (code: number, text: string, toErr: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (text) (toErr ? io.stderr : io.stdout)(text.endsWith('\n') ? text : text + '\n')
      resolve(code)
    }
    const socket = connect(path, () => {
      sent = true
      socket.write(line)
    })
    const timer = setTimeout(() => finish(sent ? EXIT.dropped : EXIT.absent, sent
      ? 'coordinator-board: no answer from the board in time; the command may have run. Read the board before running it again.'
      : 'coordinator-board: the Coordinator Board plugin did not answer.', true), io.timeoutMs ?? 120_000)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0 && !settled; end = buffer.indexOf('\n')) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: (ExecFrame | { exit: number; text: string }) & { kind?: string }
        try {
          message = JSON.parse(text)
        } catch {
          return finish(EXIT.dropped, 'coordinator-board: the board sent an unreadable answer; the command may have run.', true)
        }
        if (message.kind === 'exec') {
          const frame = message as ExecFrame
          const run = io.runOrca ? io.runOrca(frame.args, frame.timeoutMs) : Promise.resolve({ stdout: '', error: { code: 'spawn_failed' as const, message: 'this command cannot run orca' } })
          void run.catch((error: unknown) => ({ stdout: '', error: { code: 'exec_failed' as const, message: error instanceof Error ? error.message : String(error) } }))
            .then(({ stdout, error }) => {
              const result: ExecResult = { kind: 'exec-result', id: frame.id, stdout, error }
              if (!socket.destroyed) socket.write(JSON.stringify(result) + '\n')
            })
          continue
        }
        const reply = message as { exit: number; text: string }
        return finish(reply.exit, reply.text, reply.exit !== EXIT.ok)
      }
    })
    socket.on('error', () => finish(sent ? EXIT.dropped : EXIT.absent, sent
      ? 'coordinator-board: the connection broke; the command may have run. Read the board before running it again.'
      : 'coordinator-board: the Coordinator Board plugin is not running in Orca.', true))
    socket.on('close', () => finish(sent ? EXIT.dropped : EXIT.absent, sent
      ? 'coordinator-board: the board closed the connection; the command may have run.'
      : 'coordinator-board: the Coordinator Board plugin is not running in Orca.', true))
  })
}
