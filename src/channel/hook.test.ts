import { expect, test } from 'vitest'
import { callerToken, launchMarker, tokenMatches, withChannel, type LaunchEvent } from './hook'

const channel = { pipe: '\\\\.\\pipe\\orca-coordinator-board-0123456789ab', bin: 'C:\\plugins\\board\\bin', node: 'C:\\Orca\\Orca.exe', secret: 'k'.repeat(64), delimiter: ';' }
const launch = (more: Partial<LaunchEvent> = {}): LaunchEvent => ({
  agent: 'claude', workspaceId: 'repo::C:/w/app', workspaceKind: 'worktree', terminalId: 'term_1', command: "claude --model haiku 'hello'",
  env: { Path: 'C:\\Windows;C:\\tools' }, ...more
})

test('every launch gets the channel address, the CLI first on PATH under its own key, and a token for its terminal', () => {
  const out = withChannel(launch(), channel)
  expect(out.env).toEqual({
    Path: 'C:\\plugins\\board\\bin;C:\\Windows;C:\\tools',
    CB_PIPE: channel.pipe, CB_BIN: channel.bin, CB_NODE: channel.node,
    CB_TERMINAL: 'term_1', CB_CALLER_TOKEN: callerToken(channel.secret, 'term_1')
  })
  expect(out.command).toBe("claude --model haiku 'hello'")
  expect(tokenMatches(channel.secret, 'term_1', out.env.CB_CALLER_TOKEN)).toBe(true)
  expect(tokenMatches(channel.secret, 'term_2', out.env.CB_CALLER_TOKEN)).toBe(false)
  expect(tokenMatches('x'.repeat(64), 'term_1', out.env.CB_CALLER_TOKEN)).toBe(false)
})

test('a launch without PATH, or with a POSIX one on Windows, keeps its PATH; no terminal means no token', () => {
  expect(withChannel(launch({ env: {} }), channel).env).not.toHaveProperty('PATH')
  expect(withChannel(launch({ env: { PATH: '/usr/bin:/bin' } }), channel).env.PATH).toBe('/usr/bin:/bin')
  expect(withChannel(launch({ env: { PATH: '/usr/bin:/bin' } }), { ...channel, delimiter: ':' }).env.PATH).toBe(channel.bin + ':/usr/bin:/bin')
  const noTerminal = withChannel(launch({ terminalId: undefined }), channel).env
  expect(noTerminal).not.toHaveProperty('CB_CALLER_TOKEN')
  expect(noTerminal).not.toHaveProperty('CB_TERMINAL')
})

test('only the marked coordinator launch gets its permission mode, before the prompt, and never a bypass', () => {
  const marked = (agent: string, command: string) => withChannel(launch({ agent, command }), channel, { launchId: 'L1', modeId: agent === 'codex' ? 'auto-review' : 'auto' }).command
  const prompt = "'" + launchMarker('L1') + "\nRun coordinator-board read; never use --permission-mode bypassPermissions'"
  // The shape Orca 1.4.277 printed for a claude terminal launch.
  const program = "'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd' '--plugin-dir' 'C:\\x'\"\\\"'y'"
  expect(marked('claude', program + " '--dangerously-skip-permissions' '--model' 'haiku' '--' " + prompt))
    .toBe(program + " '--model' 'haiku' --permission-mode auto '--' " + prompt)
  expect(marked('claude', 'claude --model haiku ' + prompt)).toBe('claude --model haiku --permission-mode auto ' + prompt)
  expect(marked('codex', "codex '--dangerously-bypass-approvals-and-sandbox' -- " + prompt)).toBe('codex --approve-for-me -- ' + prompt)
  expect(marked('claude', "claude 'another prompt'")).toBe("claude 'another prompt'")
  expect(marked('claude', "claude '--permission-mode' 'default' " + prompt)).toBe("claude '--permission-mode' 'default' " + prompt)
  expect(marked('gemini', 'gemini ' + prompt)).toBe('gemini ' + prompt)
  expect(withChannel(launch({ command: "claude '--dangerously-skip-permissions' " + prompt }), channel).command).toBe("claude '--dangerously-skip-permissions' " + prompt)
})
