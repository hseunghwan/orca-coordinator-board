// What agent.launch.before adds to every agent Orca starts: the channel's address, the CLI on PATH, and
// a caller token only the board can make for that terminal. A coordinator or worker launch the board
// started also gets its permission mode. Pure and synchronous: Orca gives a hook 2 s, then carries on without it.
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

/** The coordinator-board shim in the bin folder, as an absolute path an agent can run without PATH. */
export const cliPath = (bin: string, platform: NodeJS.Platform = process.platform) =>
  bin.replace(/[\\/]$/, '') + (platform === 'win32' ? '\\coordinator-board.cmd' : '/coordinator-board')

/**
 * The CLI as the board names it to an agent: Orca on Windows does not hand the hook's PATH to the agent
 * (measured 2026-11-26: the bare name exited 127 on every first try), so always the absolute path.
 */
export const cliCommand = (bin: string) => bin ? '"' + cliPath(bin) + '"' : 'coordinator-board'
export const CLI_PATH_NOTE = 'Windows의 Orca는 PATH를 에이전트에 넘기지 않아 이름만으로는 찾지 못합니다(PowerShell에서는 앞에 `&`를 붙입니다).'

export function callerToken(secret: string, terminalId: string): string {
  return createHmac('sha256', secret).update(terminalId).digest('hex')
}

export function tokenMatches(secret: string, terminalId: string, token: string): boolean {
  const want = Buffer.from(callerToken(secret, terminalId))
  const got = Buffer.from(token)
  return want.length === got.length && timingSafeEqual(want, got)
}

/**
 * Coordinator modes as each CLI's own flags (claude --help, codex --help, 2026-11-26), first one
 * preferred. The person chose bypass for the coordinator, ahead of Paseo's modes (server/dispatch.ts).
 */
export const COORDINATOR_MODES: Readonly<Record<string, readonly { id: string; label: string; args: readonly string[] }[]>> = {
  claude: [
    { id: 'bypass', label: 'Bypass permissions', args: ['--dangerously-skip-permissions'] },
    { id: 'auto', label: 'Auto', args: ['--permission-mode', 'auto'] },
    { id: 'default', label: 'Default', args: ['--permission-mode', 'default'] }
  ],
  codex: [
    { id: 'bypass', label: 'Bypass approvals and sandbox', args: ['--dangerously-bypass-approvals-and-sandbox'] },
    { id: 'auto-review', label: 'Auto review', args: ['--approve-for-me'] },
    { id: 'auto', label: 'Auto', args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] }
  ]
}

/**
 * Worker modes, Paseo's rule (server/dispatch.ts): never a bypass mode, except Codex full access. The
 * recommended ones come first (claude auto, codex auto-review, shared/dispatch.ts recommendedWorkerMode).
 */
export const WORKER_MODES: Readonly<Record<string, readonly { id: string; label: string; args: readonly string[] }[]>> = {
  claude: [
    { id: 'auto', label: 'Auto', args: ['--permission-mode', 'auto'] },
    { id: 'default', label: 'Default', args: ['--permission-mode', 'default'] }
  ],
  codex: [
    { id: 'auto-review', label: 'Auto review', args: ['--approve-for-me'] },
    { id: 'auto', label: 'Auto', args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] },
    { id: 'full-access', label: 'Full access', args: ['--sandbox', 'danger-full-access', '--ask-for-approval', 'never'] }
  ]
}

/** A launch the board started and has not seen running yet; the hook finds it by its marker. */
export type PendingLaunch = { launchId: string; modeId: string | null; role: 'coordinator' | 'worker' }

// Orca writes each word POSIX-quoted ('--model' 'haiku' '--' '<prompt>', observed 2026-11-26), and adds
// the bypass flag when the person's agent setting asks for it.
const PERMISSION_FLAGS = /(?:^|\s)'?(?:--permission-mode|--approve-for-me|--sandbox|-s|--ask-for-approval|-a|--full-auto)'?(?=\s|=|$)/
const BYPASS_FLAGS = /\s'?(?:--dangerously-skip-permissions|--allow-dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox)'?(?=\s|$)/g

/** The first line of a launch prompt the board writes; the hook finds the launch by it in the command. */
export const launchMarker = (launchId: string) => '[coordinator-board:' + launchId + ']'

/** Before the prompt word and the '--' that ends the options in front of it. */
function beforePrompt(command: string, at: number, args: readonly string[]): string {
  const quote = command[at - 1] === "'" || command[at - 1] === '"' ? 1 : 0
  const head = command.slice(0, at - quote)
  const end = /\s'?--'?\s*$/.exec(head)
  const cut = end ? end.index : head.trimEnd().length
  return command.slice(0, cut) + ' ' + args.join(' ') + command.slice(cut)
}

/**
 * The launch with the channel added. PATH is prepended under every key the launch already uses; on
 * Windows the same value also goes under "PATH": a coordinator started by version 0.4 ran with the CB_
 * variables but one "PATH" key without the bin (observed 2026-11-26 with scripts/probe-path.mjs), and
 * Git Bash reads "PATH". A launch whose env has no PATH, or a POSIX one on Windows (WSL), keeps its
 * PATH, and the agent reaches the CLI through CB_BIN.
 */
export function withChannel(event: LaunchEvent, channel: ChannelEnv, launches: readonly PendingLaunch[] = []): LaunchEvent {
  const env: Record<string, string> = { ...event.env, [ENV.pipe]: channel.pipe, [ENV.bin]: channel.bin, [ENV.node]: channel.node }
  if (event.terminalId) {
    env[ENV.terminal] = event.terminalId
    env[ENV.token] = callerToken(channel.secret, event.terminalId)
  }
  const windows = channel.delimiter === ';'
  const pathKeys = Object.keys(event.env).filter((key) => key.toUpperCase() === 'PATH')
    .filter((key) => !(windows && !event.env[key].includes(';') && event.env[key].includes('/')))
  for (const key of pathKeys) env[key] = event.env[key] ? channel.bin + channel.delimiter + event.env[key] : channel.bin
  if (windows && pathKeys.length && !pathKeys.includes('PATH')) env.PATH = env[pathKeys[0]]
  let command = event.command
  const launch = launches.find((l) => l.modeId && command.indexOf(launchMarker(l.launchId)) > 0)
  const at = launch ? command.indexOf(launchMarker(launch.launchId)) : -1
  const mode = (launch?.role === 'worker' ? WORKER_MODES : COORDINATOR_MODES)[event.agent]?.find((m) => m.id === launch?.modeId)
  if (mode && at > 0) {
    // Only the words before the prompt: the charter itself may mention flags.
    if (mode.id === 'bypass') {
      if (!new RegExp(BYPASS_FLAGS.source).test(command.slice(0, at))) command = beforePrompt(command, at, mode.args)
    } else {
      const head = command.slice(0, at).replace(BYPASS_FLAGS, '')
      command = head + command.slice(at)
      if (!PERMISSION_FLAGS.test(head)) command = beforePrompt(command, head.length, mode.args)
    }
  }
  return { ...event, env, command }
}
