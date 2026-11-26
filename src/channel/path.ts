// Where the worker listens and the coordinator-board CLI connects. The name comes from the plugin
// folder alone, so a chat, which gets no launch environment, can still reach it from the CLI's location.
import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'

export function channelPath(pluginRoot: string, platform: NodeJS.Platform, tmp: string): string {
  const path = platform === 'win32' ? win32 : posix
  const root = path.resolve(pluginRoot)
  const id = createHash('sha256').update(platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 12)
  return platform === 'win32' ? `\\\\.\\pipe\\orca-coordinator-board-${id}` : path.join(tmp, `orca-coordinator-board-${id}.sock`)
}
