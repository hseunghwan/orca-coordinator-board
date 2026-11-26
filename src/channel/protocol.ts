// The coordinator channel's wire: one NDJSON request line from the coordinator-board CLI, one reply
// line from the worker. Free text travels inside the JSON, never on a command line, because a .cmd
// shim would read % ^ & in it again.
import { z } from 'zod'
import { COMMANDS, EXIT } from './names'

export { COMMANDS, EXIT, MAX_LINE, type Command, type ExecFrame, type ExecResult } from './names'

/** What the caller says about itself. Only a terminal's token is checked; a chat's session is taken at its word. */
export const callerClaim = z.object({
  terminal: z.string().max(256).nullable(),
  token: z.string().max(256).nullable(),
  session: z.string().max(256).nullable()
})
export type CallerClaim = z.output<typeof callerClaim>

export const channelRequest = z.object({
  /** 2: the command runs orca for the worker (ExecFrame). */
  v: z.union([z.literal(1), z.literal(2)]),
  command: z.enum(COMMANDS),
  input: z.record(z.string(), z.unknown()),
  caller: callerClaim
})
export type ChannelRequest = z.output<typeof channelRequest>

export const channelReply = z.object({
  exit: z.union([z.literal(EXIT.ok), z.literal(EXIT.error), z.literal(EXIT.denied)]),
  text: z.string()
})
export type ChannelReply = z.output<typeof channelReply>

export const execResult = z.object({
  kind: z.literal('exec-result'),
  id: z.number().int(),
  stdout: z.string(),
  error: z.object({ code: z.enum(['timeout', 'spawn_failed', 'exec_failed']), message: z.string() }).nullable()
})
