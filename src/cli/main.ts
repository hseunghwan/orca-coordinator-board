// Entry of dist/cli.cjs, which bin/coordinator-board(.cmd) runs with Orca's runtime or node.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { channelPath } from '../channel/path'
import { runCli } from './run'

void runCli(process.argv.slice(2), {
  env: process.env,
  readText: async (path) => readFileSync(path === '-' ? 0 : path, 'utf8'),
  stdout: (text) => { process.stdout.write(text) },
  stderr: (text) => { process.stderr.write(text) },
  defaultPipe: channelPath(dirname(__dirname), process.platform, tmpdir())
}).then((code) => { process.exitCode = code })
