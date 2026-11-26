// What agent.launch.before adds to every agent Orca starts: the channel's address, the CLI on PATH, and
// a caller token only the board can make for that terminal. A coordinator launch also gets its
// permission mode. Pure and synchronous: Orca gives a hook 2 s, then carries on without it.
import { createHmac, timingSafeEqual } from 'node:crypto'

export type LaunchEvent = {
  agent: string
  workspaceId: string | null
  workspaceKind: 'worktree' | 'folder' | null
  terminalId?: string
  command: string
  env: Record<string, string>
}

export type ChannelEnv = {
  /** The pipe or socket the worker listens on. */
  pipe: string
  /** The plugin's bin folder, holding the coordinator-board shims. */
  bin: string
  /** The runtime the shims start the CLI with (Orca's own, as Node). */
  node: string
  secret: string
  /** path.delimiter of the machine the agent runs on. */
  delimiter: string
}

export const ENV = {
  pipe: 'CB_PIPE', bin: 'CB_BIN', node: 'CB_NODE', terminal: 'CB_TERMINAL', token: 'CB_CALLER_TOKEN'
} as const

export function callerToken(secret: string, terminalId: string): string {
  return createHmac('sha256', secret).update(terminalId).digest('hex')
}

export function tokenMatches(secret: string, terminalId: string, token: string): boolean {
  const want = Buffer.from(callerToken(secret, terminalId))
  const got = Buffer.from(token)
  return want.length === got.length && timingSafeEqual(want, got)
}

/**
 * Paseo's coordinator modes (server/dispatch.ts), first one preferred, as each CLI's own flags
 * (claude --help, codex --help, 2026-11-26). No bypass flag is ever added.
 */
export const COORDINATOR_MODES: Readonly<Record<string, readonly { id: string; label: string; args: readonly string[] }[]>> = {
  claude: [
    { id: 'auto', label: 'Auto', args: ['--permission-mode', 'auto'] },
    { id: 'default', label: 'Default', args: ['--permission-mode', 'default'] }
  ],
  codex: [
    { id: 'auto-review', label: 'Auto review', args: ['--approve-for-me'] },
    { id: 'auto', label: 'Auto', args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] }
  ]
}

const PERMISSION_FLAGS = /(?:^|\s)(?:--permission-mode|--dangerously-skip-permissions|--approve-for-me|--sandbox|-s|--ask-for-approval|-a|--dangerously-bypass-approvals-and-sandbox|--full-auto)(?=\s|=|$)/

/** The first line of a coordinator's launch prompt; the hook finds the launch by it in the command. */
export const launchMarker = (launchId: string) => '[coordinator-board:' + launchId + ']'

/** After the program, which may be a quoted path: flags placed there reach the CLI whatever comes after. */
function afterProgram(command: string, args: readonly string[]): string {
  const end = command.startsWith('"') ? command.indexOf('"', 1) + 1 : command.search(/\s|$/)
  if (end <= 0) return command
  return command.slice(0, end) + ' ' + args.join(' ') + command.slice(end)
}

/**
 * The launch with the channel added. PATH is prepended under the key the launch already uses
 * (Windows names it "Path"); a launch whose env has no PATH, or a POSIX one on Windows (WSL), keeps
 * its PATH, and the agent reaches the CLI through CB_BIN.
 */
export function withChannel(event: LaunchEvent, channel: ChannelEnv, coordinator?: { launchId: string; modeId: string | null }): LaunchEvent {
  const env: Record<string, string> = { ...event.env, [ENV.pipe]: channel.pipe, [ENV.bin]: channel.bin, [ENV.node]: channel.node }
  if (event.terminalId) {
    env[ENV.terminal] = event.terminalId
    env[ENV.token] = callerToken(channel.secret, event.terminalId)
  }
  const pathKey = Object.keys(event.env).find((key) => key.toUpperCase() === 'PATH')
  const foreign = channel.delimiter === ';' && pathKey !== undefined && !event.env[pathKey].includes(';') && event.env[pathKey].includes('/')
  if (pathKey && !foreign) env[pathKey] = event.env[pathKey] ? channel.bin + channel.delimiter + event.env[pathKey] : channel.bin
  let command = event.command
  const at = coordinator?.modeId ? command.indexOf(launchMarker(coordinator.launchId)) : -1
  // Only the words before the prompt: the charter itself may mention flags.
  if (coordinator?.modeId && at > 0 && !PERMISSION_FLAGS.test(command.slice(0, at))) {
    const mode = COORDINATOR_MODES[event.agent]?.find((m) => m.id === coordinator.modeId)
    if (mode) command = afterProgram(command, mode.args)
  }
  return { ...event, env, command }
}
