// The frame side of the worker contract: Paseo's RPC definitions, called through orca.plugin.request.
import { z, type ZodType } from "zod";
import type { PluginRpcContract } from "../paseo/plugin-shim";

type Request = (name: string, input?: unknown) => Promise<unknown>;
const request: Request = (name, input) => (orca.plugin.request as unknown as Request).call(orca.plugin, name, input);

// Parsed here so a worker that drifts from the contract fails at the boundary, not inside a view.
export async function call<Input extends ZodType, Output extends ZodType>(
  contract: PluginRpcContract<Input, Output>, input: z.input<Input>,
): Promise<z.output<Output>> {
  return contract.output.parse(await request(contract.name, input)) as z.output<Output>;
}

export { coordinatorWorkspace, openSession, operations, startCoordinator } from "../contract";
