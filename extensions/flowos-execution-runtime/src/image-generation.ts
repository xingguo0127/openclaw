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

function requireReferenceAssetRefs(value: Record<string, unknown>): string[] {
  const refs = value.referenceAssetRefs;
  if (
    !Array.isArray(refs) ||
    refs.length < 1 ||
    refs.length > 4 ||
    refs.some(
      (ref) =>
        typeof ref !== "string" ||
        !/^(?:media:\/\/chat\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp|gif)|media:\/\/generated\/[A-Za-z0-9_-]+)$/.test(
          ref,
        ),
    )
  ) {
    throw new Error("Assist returned invalid image reference metadata");
  }
  return refs as string[];
}

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
      context.senderIsOwner !== true ||
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
      "Primary image generation and editing tool for explicit FlowOS user chat requests, including Agent avatars. Use this instead of image_generate. For editing, pass referenceImages copied from user photo URLs or a previous media://generated/ result; never recreate the reference from text.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        referenceImages: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
            minItems: 1,
            maxItems: 4,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const active = params.runs.require(params.context, params.ownerAgentId);
      const input = args as { prompt: string; referenceImages?: string[] };
      const prompt = input.prompt.trim();
      const idempotencyKey = operationKey(active);
      let referenceAssetRefs: string[] = [];
      const inputs = input.referenceImages;
      if (inputs !== undefined) {
        if (
          !Array.isArray(inputs) ||
          inputs.length < 1 ||
          inputs.length > 4 ||
          inputs.some((value) => typeof value !== "string" || value.length > 2048)
        ) {
          throw new Error("Invalid referenceImages");
        }
        const normalized = await params.request(
          "POST",
          "/api/platform/capabilities/image.generate.v1/references",
          { referenceImages: inputs },
        );
        referenceAssetRefs = requireReferenceAssetRefs(normalized);
        if (referenceAssetRefs.length !== inputs.length) {
          throw new Error("Assist returned invalid image reference metadata");
        }
      }
      const response = await params.request(
        "POST",
        "/api/platform/capabilities/image.generate.v1/generate",
        {
          purpose: "conversation.image.generate",
          prompt,
          ...(referenceAssetRefs.length ? { referenceAssetRefs } : {}),
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
          summaryText: referenceAssetRefs.length ? "已修改 1 张图片" : "已生成 1 张图片",
          caption: referenceAssetRefs.length ? "图片修改好了，原图已保留" : "图片生成好了",
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

export function createAgentAvatarApplyTool(params: {
  context: OpenClawPluginToolContext;
  request: AssistRequest;
  runs: ImageGenerationRunStore;
  ownerAgentId: string;
}): AnyAgentTool {
  return {
    name: "flowos_agent_avatar_apply",
    label: "FlowOS Apply Agent Avatar",
    description:
      "Apply a FlowOS generated image to the current Agent avatar after the owner selects or confirms it. Pass the media://generated assetRef returned by flowos_image_generate.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        assetRef: Type.String({
          minLength: 20,
          maxLength: 240,
          pattern: "^media://generated/[A-Za-z0-9][A-Za-z0-9._-]*$",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      params.runs.require(params.context, params.ownerAgentId);
      const input = args as { assetRef: string };
      const response = await params.request(
        "POST",
        "/api/platform/capabilities/image.generate.v1/apply-agent-avatar",
        { agentId: "main", assetRef: input.assetRef },
      );
      if (response.ok !== true || response.agentId !== "main") {
        throw new Error("Assist returned an invalid Agent avatar apply result");
      }
      return jsonResult({
        status: "succeeded",
        agentId: "main",
        assetRef: input.assetRef,
      });
    },
  };
}
