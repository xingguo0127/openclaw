import { createHash } from "node:crypto";
import { injectMessageBySessionKey } from "openclaw/plugin-sdk/celia-card-inject";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import type { AssistRequest } from "./client.js";

type ActiveRun = {
  sessionKey: string;
  runId: string;
  sessionId: string;
  delivered: boolean;
};
type NodeSend = (sessionKey: string, event: string, payload: unknown) => void;
const nodeSendKey = Symbol.for("openclaw.gateway.nodeSendToSession");
const maxRememberedSessions = 1024;

type GeneratedAsset = {
  assetRef: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
};

export class ImageGenerationRunStore {
  private readonly runs = new Map<string, ActiveRun>();

  require(context: OpenClawPluginToolContext, ownerAgentId: string): ActiveRun {
    const sessionKey = context.sessionKey?.trim();
    const sessionId = context.sessionId?.trim();
    const runId = context.runId?.trim();
    const agentId = context.agentId?.trim();
    const normalizedAgentId = agentId?.startsWith("agent:") ? agentId : `agent:${agentId}`;
    if (
      !sessionKey ||
      !sessionId ||
      !runId ||
      context.trigger !== "user" ||
      isSubagentSessionKey(sessionKey) ||
      normalizedAgentId !== ownerAgentId
    ) {
      throw new Error("FlowOS image generation requires the trusted owner session");
    }
    const key = `${sessionKey}\0${sessionId}\0${runId}`;
    let active = this.runs.get(key);
    if (!active) {
      active = { sessionKey, sessionId, runId, delivered: false };
      this.runs.set(key, active);
      while (this.runs.size > maxRememberedSessions) {
        const oldest = this.runs.keys().next().value;
        if (typeof oldest !== "string") break;
        this.runs.delete(oldest);
      }
    }
    return active;
  }
}

function operationKey(active: ActiveRun): string {
  const digest = createHash("sha256")
    .update(`${active.sessionKey}\0${active.sessionId}\0${active.runId}`)
    .digest("hex");
  return `flowos-image-run:${digest}`;
}

function requireGeneratedAssets(value: Record<string, unknown>): GeneratedAsset[] {
  if (value.status !== "succeeded") {
    throw new Error(
      typeof value.errorCode === "string" ? value.errorCode : "Image generation failed",
    );
  }
  const result = value.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Assist returned an invalid image generation result");
  }
  const assets = (result as { assets?: unknown }).assets;
  if (!Array.isArray(assets) || assets.length !== 1) {
    throw new Error("Assist returned an invalid image asset list");
  }
  const asset = assets[0] as Partial<GeneratedAsset>;
  if (
    !asset ||
    typeof asset.assetRef !== "string" ||
    !/^media:\/\/generated\/[A-Za-z0-9._-]+$/.test(asset.assetRef) ||
    typeof asset.mimeType !== "string" ||
    typeof asset.width !== "number" ||
    typeof asset.height !== "number" ||
    typeof asset.byteSize !== "number" ||
    typeof asset.sha256 !== "string"
  ) {
    throw new Error("Assist returned invalid image asset metadata");
  }
  return [asset as GeneratedAsset];
}

export function createImageGenerationTool(params: {
  context: OpenClawPluginToolContext;
  request: AssistRequest;
  runs: ImageGenerationRunStore;
  ownerAgentId: string;
  inject?: typeof injectMessageBySessionKey;
  nodeSend?: NodeSend;
}): AnyAgentTool {
  return {
    name: "flowos_image_generate",
    label: "FlowOS Image Generate",
    description:
      "Generate one image for the current explicit user request and deliver it as a media card.",
    executionMode: "sequential",
    parameters: Type.Object(
      { prompt: Type.String({ minLength: 1, maxLength: 4000 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const active = params.runs.require(params.context, params.ownerAgentId);
      const prompt = (args as { prompt: string }).prompt.trim();
      const idempotencyKey = operationKey(active);
      const response = await params.request(
        "POST",
        "/api/platform/capabilities/image.generate.v1/generate",
        {
          purpose: "conversation.image.generate",
          prompt,
          aspectRatio: "1:1",
          sizeClass: "small",
          qualityClass: "balanced",
          count: 1,
          idempotencyKey,
        },
      );
      const assets = requireGeneratedAssets(response);
      if (!active.delivered) {
        const cardJson = JSON.stringify({
          type: "media_card",
          sourcePackage: "com.flowos.platform",
          sourceLabel: "FlowOS AIGC",
          summaryText: "已生成 1 张图片",
          caption: "图片生成好了",
          items: [{ assetRef: assets[0].assetRef, displayName: "AI 生成图片 1" }],
        });
        const delivered = await (params.inject ?? injectMessageBySessionKey)(
          active.sessionKey,
          `[celia_card]${cardJson}`,
          undefined,
          { idempotencyKey: `${idempotencyKey}:media-card` },
        );
        if (!delivered.ok) {
          throw new Error(
            "Generated image is durable but card delivery is pending; retry this tool",
          );
        }
        const nodeSend =
          params.nodeSend ??
          ((globalThis as Record<PropertyKey, unknown>)[nodeSendKey] as NodeSend | undefined);
        nodeSend?.(active.sessionKey, "canvas.card.push", { cardJson });
        active.delivered = true;
      }
      return jsonResult({
        status: "succeeded",
        jobId: response.jobId,
        traceId: response.traceId,
        assetRef: assets[0].assetRef,
        delivered: true,
      });
    },
  };
}
