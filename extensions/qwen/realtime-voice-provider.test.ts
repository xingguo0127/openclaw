import { describe, expect, it } from "vitest";
import {
  resolveQwenToolResultResponsePolicy,
  supportsQwenRealtimeToolCalls,
  toQwenRealtimeTools,
} from "./realtime-voice-provider.js";

describe("Qwen realtime tool contract", () => {
  it("projects shared tools to the nested DashScope wire format", () => {
    const tools = toQwenRealtimeTools([
      {
        type: "function",
        name: "flowgo_show_expression",
        description: "Show a bounded expression without speaking its result.",
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
      },
    ]);

    expect(tools).toEqual([
      {
        type: "function",
        function: expect.objectContaining({
          name: "flowgo_show_expression",
          parameters: expect.objectContaining({
            additionalProperties: false,
            required: ["expression", "intensity", "durationMs"],
          }),
        }),
      },
    ]);
    expect(tools[0]).not.toHaveProperty("name");
  });

  it("limits realtime tool support to the Qwen 3.5 Omni family", () => {
    expect(supportsQwenRealtimeToolCalls(undefined)).toBe(true);
    expect(supportsQwenRealtimeToolCalls("qwen3.5-omni-flash-realtime")).toBe(true);
    expect(supportsQwenRealtimeToolCalls("qwen3.5-omni-plus-realtime")).toBe(true);
    expect(supportsQwenRealtimeToolCalls("qwen3.5-omni-flash-realtime-2026-02-23")).toBe(true);
    expect(supportsQwenRealtimeToolCalls("qwen3-omni-flash-realtime")).toBe(false);
    expect(supportsQwenRealtimeToolCalls("qwen3.5-omni-flash")).toBe(false);
    expect(supportsQwenRealtimeToolCalls("qwen3.5-omni-pro-realtime")).toBe(false);
  });

  it("continues silent side effects without cancelling or reading their result", () => {
    const policy = resolveQwenToolResultResponsePolicy({
      responseMode: "silent-side-effect",
    });
    expect(policy.respond).toBe(true);
    expect(policy.cancelActive).toBe(false);
    expect(policy.instructions).toContain("继续自然完成");
    expect(policy.instructions).toContain("不要提及");

    const consultPolicy = resolveQwenToolResultResponsePolicy(undefined);
    expect(consultPolicy.cancelActive).toBe(true);
    expect(consultPolicy.instructions).toContain("把这个结果");
  });
});
