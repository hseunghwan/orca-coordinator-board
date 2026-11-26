// Paseo's server.handle(rpc, fn) on top of Orca's panels.handle(name, fn): input parsed by the
// contract, output checked against it, so a panel gets exactly the Paseo shape or an error.
import type { PaseoReads, PluginServerContext } from '../orca'

export type Handle = (name: string, handler: (input: unknown) => Promise<unknown>) => void

// Paseo sends RPC output as JSON, which drops undefined fields. Orca refuses a reply that still
// holds one, so the output goes through the same round trip before it leaves the worker.
export function toWire(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

export function rpcServer(handle: Handle, paseo: PaseoReads): PluginServerContext {
  return {
    handle(rpc, handler) {
      handle(rpc.name, async (input) => toWire(rpc.output.parse(await handler(rpc.input.parse(input ?? {}), { paseo }))))
    }
  }
}
