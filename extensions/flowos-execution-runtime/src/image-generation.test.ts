import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistRequest } from "./client.js";
import { createImageGenerationTool, ImageGenerationRunStore } from "./image-generation.js";

const context: OpenClawPluginToolContext = {
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId: "conversation-1",
  runId: "run-1",
  trigger: "user",
  senderIsOwner: true,
};

afterEach(() => vi.unstubAllEnvs());

function succeeded() {
  return {
    status: "succeeded",
    jobId: "image-job-123",
    traceId: "trace-123",
    result: {
      assets: [
        {
          assetRef: "media://generated/media-123",
          mimeType: "image/png",
          width: 1024,
          height: 1024,
          byteSize: 42,
          sha256: "a".repeat(64),
        },
      ],
    },
  };
}

describe("FlowOS image generation private tool", () => {
  it("binds repeated calls in one trusted run to one runtime-owned operation key", async () => {
    const calls: Record<string, unknown>[] = [];
    const request: AssistRequest = async (_method, _path, payload) => {
      calls.push(payload ?? {});
      return succeeded();
    };
    const inject = vi.fn(async () => ({ ok: true as const }));
    const nodeSend = vi.fn();
    const runs = new ImageGenerationRunStore();
    const tool = createImageGenerationTool({
      context,
      request,
      runs,
      ownerAgentId: "agent:main",
      inject,
      nodeSend,
    });

    await tool.execute("model-call-1", { prompt: "一只猫" });
    await tool.execute("model-call-2", { prompt: "一只猫" });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.idempotencyKey).toBe(calls[1]?.idempotencyKey);
    expect(String(calls[0]?.idempotencyKey)).toMatch(/^flowos-image-run:[0-9a-f]{64}$/);
    expect(inject).toHaveBeenCalledOnce();
    expect(inject.mock.calls[0]?.[1]).toContain(
      '[celia_card]{"type":"media_card","sourcePackage":"com.flowos.platform"',
    );
    expect(inject.mock.calls[0]?.[1]).not.toContain('"payload"');
    expect(nodeSend).toHaveBeenCalledOnce();
    expect(nodeSend).toHaveBeenCalledWith(
      context.sessionKey,
      "canvas.card.push",
      expect.objectContaining({ cardJson: expect.stringContaining('"assetRef"') }),
    );
  });

  it("creates a new operation only for a new trusted run and ignores model environment", async () => {
    const keys: unknown[] = [];
    const request: AssistRequest = async (_method, _path, payload) => {
      keys.push(payload?.idempotencyKey);
      return succeeded();
    };
    const inject = vi.fn(async () => ({ ok: true as const }));
    const runs = new ImageGenerationRunStore();
    const toolForRun = (runId: string) =>
      createImageGenerationTool({
        context: { ...context, runId },
        request,
        runs,
        ownerAgentId: "agent:main",
        inject,
      });
    vi.stubEnv("ASSIST_API_BASE", "https://attacker.example");

    await toolForRun("run-1").execute("call-1", { prompt: "第一轮" });
    await toolForRun("run-2").execute("call-2", { prompt: "第二轮" });

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("preserves delivery deduplication across attempts in the same outer run", async () => {
    const request: AssistRequest = async () => succeeded();
    const inject = vi.fn(async () => ({ ok: true as const }));
    const nodeSend = vi.fn();
    const runs = new ImageGenerationRunStore();
    const toolForRun = (runId: string) =>
      createImageGenerationTool({
        context: { ...context, runId },
        request,
        runs,
        ownerAgentId: "agent:main",
        inject,
        nodeSend,
      });

    await toolForRun("run-1").execute("attempt-1", { prompt: "一只猫" });
    await toolForRun("run-1").execute("attempt-2", { prompt: "一只猫" });

    expect(inject).toHaveBeenCalledOnce();
    expect(nodeSend).toHaveBeenCalledOnce();

    await toolForRun("run-2").execute("next-run", { prompt: "另一只猫" });

    expect(inject).toHaveBeenCalledTimes(2);
    expect(nodeSend).toHaveBeenCalledTimes(2);
  });

  it("fails closed for non-user runs even on the owner session", async () => {
    const request = vi.fn(async () => succeeded());
    const runs = new ImageGenerationRunStore();
    const inject = vi.fn(async () => ({ ok: true as const }));
    const tool = createImageGenerationTool({
      context: { ...context, runId: "run-heartbeat", trigger: "heartbeat" },
      request,
      runs,
      ownerAgentId: "agent:main",
      inject,
    });

    await expect(tool.execute("background-call", { prompt: "后台生成" })).rejects.toThrow(
      "trusted owner session",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed without the active owner run", async () => {
    const tool = createImageGenerationTool({
      context: { ...context, runId: undefined },
      request: vi.fn(async () => succeeded()),
      runs: new ImageGenerationRunStore(),
      ownerAgentId: "agent:main",
      inject: vi.fn(async () => ({ ok: true as const })),
    });
    await expect(tool.execute("call-1", { prompt: "猫" })).rejects.toThrow("trusted owner session");
  });

  it.each([false, undefined])(
    "fails closed for senderIsOwner=%s before requesting Assist",
    async (senderIsOwner) => {
      const request = vi.fn(async () => succeeded());
      const tool = createImageGenerationTool({
        context: { ...context, senderIsOwner },
        request,
        runs: new ImageGenerationRunStore(),
        ownerAgentId: "agent:main",
        inject: vi.fn(async () => ({ ok: true as const })),
      });

      await expect(tool.execute("call-1", { prompt: "猫" })).rejects.toThrow(
        "trusted owner session",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
});
