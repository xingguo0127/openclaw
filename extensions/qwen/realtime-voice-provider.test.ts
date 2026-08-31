import { describe, expect, it, vi } from "vitest";
import {
  buildQwenRealtimeVoiceProvider,
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

  it("preserves response identity on provider tool calls", () => {
    const onToolCall = vi.fn();
    const bridge = buildQwenRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-key" },
      onAudio: () => undefined,
      onClearAudio: () => undefined,
      onToolCall,
    } as never);
    const state = bridge as unknown as {
      handleEvent: (event: Record<string, unknown>) => void;
    };

    state.handleEvent({
      type: "response.function_call_arguments.delta",
      response_id: "response-1",
      item_id: "item-1",
      call_id: "call-1",
      name: "flowgo_show_expression",
      delta: '{"expression":"happy",',
    });
    state.handleEvent({
      type: "response.function_call_arguments.delta",
      response_id: "response-1",
      item_id: "item-1",
      delta: '"intensity":0.8,"durationMs":1200}',
    });
    state.handleEvent({
      type: "response.function_call_arguments.done",
      response_id: "response-1",
      item_id: "item-1",
      call_id: "call-1",
      name: "flowgo_show_expression",
    });

    expect(onToolCall).toHaveBeenCalledWith({
      itemId: "item-1",
      callId: "call-1",
      name: "flowgo_show_expression",
      args: { expression: "happy", intensity: 0.8, durationMs: 1200 },
      responseId: "response-1",
    });
  });

  it("drops a queued silent continuation on provider VAD barge-in", () => {
    const onAudio = vi.fn();
    const onEvent = vi.fn();
    const onToolCall = vi.fn();
    const bridge = buildQwenRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-key" },
      onAudio,
      onClearAudio: () => undefined,
      onToolCall,
      onEvent,
    } as never);
    const state = bridge as unknown as {
      responseCreatePending: boolean;
      responseCreateInFlight: boolean;
      responseCancelInFlight: boolean;
      discardResponseAfterCreate: boolean;
      pendingResponseInstructions?: string;
      continuingToolCallIds: Set<string>;
      sendEvent: ReturnType<typeof vi.fn>;
      handleEvent: (event: {
        type: string;
        delta?: string;
        response?: { id: string };
        error?: { message: string };
        item?: { id: string; type: string; call_id: string; name: string; arguments: string };
      }) => void;
    };
    state.responseCreatePending = true;
    state.responseCreateInFlight = true;
    state.pendingResponseInstructions = "continue stale expression turn";
    state.continuingToolCallIds.add("call-expression");
    state.sendEvent = vi.fn();

    state.handleEvent({ type: "input_audio_buffer.speech_started" });

    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "input_audio_buffer.speech_started",
      detail:
        "responseActive=false responseCreateInFlight=true playbackMarks=0 interruptEnabled=true",
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "response.barge_in",
      detail: "reason=provider-vad state=response-create-in-flight",
    });
    expect(state.responseCreatePending).toBe(false);
    expect(state.pendingResponseInstructions).toBeUndefined();
    expect(state.continuingToolCallIds.size).toBe(0);
    expect(state.discardResponseAfterCreate).toBe(true);
    onEvent.mockClear();

    state.handleEvent({ type: "response.created", response: { id: "stale-response" } });
    expect(state.sendEvent).toHaveBeenCalledWith(
      { type: "response.cancel" },
      "reason=discard-barge-in-response",
    );
    state.handleEvent({ type: "response.audio.delta", delta: "AAAA" });
    expect(onAudio).not.toHaveBeenCalled();
    state.handleEvent({
      type: "conversation.item.done",
      item: {
        id: "stale-tool-item",
        type: "function_call",
        call_id: "stale-tool-call",
        name: "flowgo_show_expression",
        arguments: '{"expression":"happy"}',
      },
    });
    expect(onToolCall).not.toHaveBeenCalled();
    state.handleEvent({ type: "response.cancelled" });
    expect(state.discardResponseAfterCreate).toBe(false);
    expect(onEvent).not.toHaveBeenCalled();

    state.discardResponseAfterCreate = true;
    state.responseCancelInFlight = true;
    state.handleEvent({
      type: "error",
      error: { message: "Cancellation failed: no active response found" },
    });
    expect(state.discardResponseAfterCreate).toBe(false);
    expect(state.responseCancelInFlight).toBe(false);
  });
});
