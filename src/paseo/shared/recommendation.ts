import { defineRpc } from "../plugin-shim";
import { z } from "zod";
import { decisionRequest, sendDecision } from "./decision-actions";

export const requestRecommendation = defineRpc({
  name: "board.request-recommendation",
  input: decisionRequest.pick({
    projectId: true, sessionId: true, version: true, requestKey: true,
  }).extend({
    coordinator: z.string().min(1).max(256),
    language: z.enum(["ko", "en"]),
  }),
  output: sendDecision.output,
});
