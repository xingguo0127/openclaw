import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { requestCapability } from "./tool.js";

type Params = {
  action: "meeting.start" | "translation.start";
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
      "用户每次明确要求现在开始本开发板的会议录音时，都必须调用 meeting.start 验证本次执行。历史成功结果不代表当前仍在录音，不得据此跳过工具。用户要求面对面翻译、和外国人交流时调用 translation.start；targetLanguage 默认 auto，明确英语/日语/韩语/法语/德语/西班牙语/俄语时传 en/ja/ko/fr/de/es/ru。翻译模式双方按住 AI KEY 说、松手翻译。只支持当前开发板发起的对话；手机和其他来源不支持。不用于询问用法、否定或未来安排。不接受目标设备参数。只有工具返回 ok=true 才能说已开始；超时应说启动未确认，不自动重试。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["meeting.start", "translation.start"] },
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
          !["meeting.start", "translation.start"].includes(params.action) ||
          (params.targetLanguage !== undefined &&
            !["auto", "en", "ja", "ko", "fr", "de", "es", "ru"].includes(params.targetLanguage)) ||
          Object.keys(params).some((k) => !["action", "targetLanguage"].includes(k))
        ) {
          result = { ok: false, error: "invalid_action" };
        } else {
          result = await request(endpoint, token, "POST", "/api/agent-terminal/device-action", {
            sessionKey: context.sessionKey,
            runId: context.runId,
            toolCallId: callId,
            action: params.action,
            ...(params.targetLanguage ? { targetLanguage: params.targetLanguage } : {}),
          });
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
