import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { requestCapability } from "./tool.js";

type Params = { action: "meeting.start" };

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
      "用户每次明确要求现在开始本开发板的会议录音时，都必须调用 meeting.start 验证本次执行。历史成功结果不代表当前仍在录音，不得据此跳过工具。只支持当前开发板发起的对话；手机和其他来源不支持。不用于询问用法、否定或未来安排。不接受目标设备参数。只有工具返回 ok=true 才能说已开始；超时应说启动未确认，不自动重试。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: { action: { type: "string", enum: ["meeting.start"] } },
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
          params.action !== "meeting.start" ||
          Object.keys(params).some((k) => k !== "action")
        ) {
          result = { ok: false, error: "invalid_action" };
        } else {
          result = await request(endpoint, token, "POST", "/api/agent-terminal/device-action", {
            sessionKey: context.sessionKey,
            runId: context.runId,
            toolCallId: callId,
            action: params.action,
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
