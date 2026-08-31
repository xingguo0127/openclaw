import type { RealtimeVoiceTool } from "./provider-types.js";

export const FLOWGO_EXPRESSION_CAPABILITY = "flowgo.expression.v1";
export const FLOWGO_EXPRESSION_TOOL_NAME = "flowgo_show_expression";

export const FLOWGO_EXPRESSION_INSTRUCTIONS = [
  `When the emotional tone of your spoken reply is clearly happy, expectant, sad, embarrassed, shy, or angry, call ${FLOWGO_EXPRESSION_TOOL_NAME} exactly once before speaking the emotionally matching part.`,
  "Use the matching expression enum, a proportionate intensity, and a short duration that covers that part of the reply.",
  "Do not call it for a neutral reply, do not use default merely to add animation, and never describe the tool, parameters, or result aloud.",
].join(" ");

export const FLOWGO_EXPRESSION_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: FLOWGO_EXPRESSION_TOOL_NAME,
  description:
    "Show one short-lived high-level emotion on the paired FlowGo device while continuing the spoken reply. " +
    "Use happy for joy or praise, expectant for anticipation, sad for sorrow, embarrassed for awkwardness, " +
    "shy for bashfulness, and angry for anger. Call before speaking the matching emotional passage, at most " +
    "once per assistant turn. Do not call for a neutral reply or mention the tool or its result aloud.",
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
