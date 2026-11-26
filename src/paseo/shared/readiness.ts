import { defineRpc } from "../plugin-shim";
import { z } from "zod";

export const boardReadiness = defineRpc({
  name: "board.readiness",
  input: z.strictObject({}),
  output: z.object({ configured: z.boolean(), coordinator: z.string().nullable(), decisionTitles: z.array(z.string()).max(3).optional() }),
});
export type BoardReadiness = z.output<typeof boardReadiness.output>;
