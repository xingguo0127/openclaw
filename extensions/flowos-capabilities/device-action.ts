import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { requestCapability } from "./tool.js";

type Params = {
  action: "meeting.start" | "translation.start" | "lockscreen.image.add";
  assetRef?: string;
  targetLanguage?: "auto" | "en" | "ja" | "ko" | "fr" | "de" | "es" | "ru";
};

export function createDeviceActionTool(
  endpoint: URL | null,
  token: string,
  context: Pick<OpenClawPluginToolContext, "sessionKey" | "runId">,
  request = requestCapability,
) {
  return {
    name: "flowos_device_action",
    label: "开发板操作",
    description:
      "用户每次明确要求现在开始本开发板的会议录音时，都必须调用 meeting.start 验证本次执行。历史成功结果不代表当前仍在录音，不得据此跳过工具。用户要求面对面翻译、和外国人交流时调用 translation.start；targetLanguage 默认 auto，明确英语/日语/韩语/法语/德语/西班牙语/俄语时传 en/ja/ko/fr/de/es/ru。翻译模式双方按住 AI KEY 说、松手翻译。只支持当前开发板发起的对话；手机和其他来源不支持。不用于询问用法、否定或未来安排。不接受目标设备参数。用户要求把生成图片加入锁屏时，先调用 flowos_image_generate，然后调用 lockscreen.image.add 并传该结果的 assetRef；不接受外部图片 URL。图片下载和保存由开发板执行，只有 ok=true 才能说图片已加入锁屏；失败要明确告知，不重新生图、不切换模型。只有工具返回 ok=true 才能说已开始；超时应说启动未确认，不自动重试。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["meeting.start", "translation.start", "lockscreen.image.add"],
        },
        assetRef: { type: "string", pattern: "^media://generated/[A-Za-z0-9_-]{1,96}$" },
        targetLanguage: {
          type: "string",
          enum: ["auto", "en", "ja", "ko", "fr", "de", "es", "ru"],
        },
      },
    },
    async execute(callId: string, params: Params) {
      let result: unknown;
      try {
        if (!context.sessionKey || !context.runId) {
          result = { ok: false, error: "unsupported_source" };
        } else if (!endpoint || !token) {
          result = { ok: false, error: "not_configured" };
        } else if (
          !params ||
          !["meeting.start", "translation.start", "lockscreen.image.add"].includes(params.action) ||
          (params.action === "lockscreen.image.add" &&
            (typeof params.assetRef !== "string" ||
              !/^media:\/\/generated\/[A-Za-z0-9_-]{1,96}$/.test(params.assetRef))) ||
          (params.action !== "lockscreen.image.add" && params.assetRef !== undefined) ||
          (params.targetLanguage !== undefined &&
            !["auto", "en", "ja", "ko", "fr", "de", "es", "ru"].includes(params.targetLanguage)) ||
          Object.keys(params).some((k) => !["action", "targetLanguage", "assetRef"].includes(k))
        ) {
          result = { ok: false, error: "invalid_action" };
        } else {
          const payload = {
            sessionKey: context.sessionKey,
            runId: context.runId,
            toolCallId: callId,
            action: params.action,
            ...(params.assetRef ? { assetRef: params.assetRef } : {}),
            ...(params.targetLanguage ? { targetLanguage: params.targetLanguage } : {}),
          };
          // Image preparation precedes the device's 60-second save confirmation window.
          result =
            params.action === "lockscreen.image.add"
              ? await request(
                  endpoint,
                  token,
                  "POST",
                  "/api/agent-terminal/device-action",
                  payload,
                  105_000,
                )
              : await request(
                  endpoint,
                  token,
                  "POST",
                  "/api/agent-terminal/device-action",
                  payload,
                );
        }
      } catch {
        result = { ok: false, error: "start_unconfirmed" };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
