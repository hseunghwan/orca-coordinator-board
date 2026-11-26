// The frame side of the worker contract: Paseo's RPC definitions, called through orca.plugin.request.
import { z, type ZodType } from "zod";
import { defineRpc, type PluginRpcContract } from "../paseo/plugin-shim";

type Request = (name: string, input?: unknown) => Promise<unknown>;
const request: Request = (name, input) => (orca.plugin.request as unknown as Request).call(orca.plugin, name, input);

// Parsed here so a worker that drifts from the contract fails at the boundary, not inside a view.
export async function call<Input extends ZodType, Output extends ZodType>(
  contract: PluginRpcContract<Input, Output>, input: z.input<Input>,
): Promise<z.output<Output>> {
  return contract.output.parse(await request(contract.name, input)) as z.output<Output>;
}

// Orca-only: a terminal session is focused, a chat session's workspace is opened.
export const openSession = defineRpc({
  name: "board.open-session",
  input: z.object({ sessionId: z.string().min(1) }),
  output: z.object({ opened: z.boolean() }),
});
