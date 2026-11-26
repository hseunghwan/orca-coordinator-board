// Runs orca for the board in the caller's shell (protocol 2): the agent's own environment, so Orca sees the
// agent as the one acting. Orca's executable sits beside the runtime the shim started this command with.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ExecResult } from '../channel/names'
import { locateOrca } from '../orca/locate'

export function runOrcaHere(env: NodeJS.ProcessEnv): (args: readonly string[], timeoutMs: number) => Promise<Pick<ExecResult, 'stdout' | 'error'>> {
  const exe = locateOrca({ platform: process.platform, execPath: env.CB_NODE || process.execPath, env, exists: existsSync })
  // The shim set this to run Orca's executable as Node; orca itself must not inherit it.
  const childEnv = { ...env }
  delete childEnv.ELECTRON_RUN_AS_NODE
  return (args, timeoutMs) => new Promise((resolve) => {
    if (!exe) return resolve({ stdout: '', error: { code: 'spawn_failed', message: 'orca not found beside ' + (env.CB_NODE || process.execPath) } })
    execFile(exe, [...args], { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: childEnv, encoding: 'utf8' }, (error, stdout) => {
      if (error && (error as { killed?: boolean }).killed) return resolve({ stdout: '', error: { code: 'timeout', message: 'orca did not answer in time' } })
      if (stdout || !error) return resolve({ stdout, error: null })
      const errno = (error as { code?: unknown }).code
      resolve({ stdout: '', error: { code: errno === 'ENOENT' || errno === 'EACCES' ? 'spawn_failed' : 'exec_failed', message: error.message } })
    })
  })
}
