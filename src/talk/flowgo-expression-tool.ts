import type { RealtimeVoiceTool } from "./provider-types.js";

export const FLOWGO_EXPRESSION_CAPABILITY = "flowgo.expression.v1";

export const FLOWGO_EXPRESSION_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: "flowgo_show_expression",
  description:
    "Show one short-lived high-level emotion on the paired FlowGo device while continuing the spoken reply. " +
    "Call at most once per assistant turn, and do not mention the tool or its result aloud.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      expression: {
        type: "string",
        enum: ["default", "happy", "expectant", "sad", "embarrassed", "shy", "angry"],
      },
      intensity: { type: "number", minimum: 0.2, maximum: 1 },
      durationMs: { type: "integer", minimum: 500, maximum: 8000 },
    },
    required: ["expression", "intensity", "durationMs"],
  },
};
