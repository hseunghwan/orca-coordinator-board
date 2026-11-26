// Paseo's server.handle(rpc, fn) on top of Orca's panels.handle(name, fn): input parsed by the
// contract, output checked against it, so a panel gets exactly the Paseo shape or an error.
import type { PaseoReads, PluginServerContext } from '../orca'

export type Handle = (name: string, handler: (input: unknown) => Promise<unknown>) => void

export function rpcServer(handle: Handle, paseo: PaseoReads): PluginServerContext {
  return {
    handle(rpc, handler) {
      handle(rpc.name, async (input) => rpc.output.parse(await handler(rpc.input.parse(input ?? {}), { paseo })))
    }
  }
}
