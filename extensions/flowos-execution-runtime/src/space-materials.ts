import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
import { AssistHttpError, type AssistRequest } from "./client.js";
import { ingestSchema, publishSchema, readSchema } from "./space-material-schemas.js";

class SpaceContextError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly missingFields?: string[],
  ) {
    super(message);
  }
}

function trustedContext(context: OpenClawPluginToolContext) {
  const missing = (["sessionId", "sessionKey", "runId", "agentDir"] as const).filter(
    (key) => !context[key],
  );
  if (missing.length) {
    throw new SpaceContextError(
      "SPACE_CONTEXT_MISSING",
      `空间工具缺少运行上下文：${missing.join(", ")}`,
      missing,
    );
  }
  if (
    context.trigger !== "user" ||
    !["main", "agent:main"].includes(context.agentId ?? "") ||
    isSubagentSessionKey(context.sessionKey!)
  ) {
    throw new SpaceContextError(
      "SPACE_CALLER_NOT_ALLOWED",
      "空间工具仅接受主 Agent 的用户对话调用。",
    );
  }
  if (context.senderIsOwner !== true) {
    throw new SpaceContextError(
      "SPACE_OWNER_UNVERIFIED",
      "当前连接未通过所有者校验，空间查询或登记未执行。请检查手机 Agent Runtime 版本及实际连接权限。",
    );
  }
  return { sessionId: context.sessionId!, sessionKey: context.sessionKey!, runId: context.runId! };
}

// Only genuine user attachments in this conversation can become intake evidence.
// The model cannot supply message IDs, identity or transcript paths.
async function sourceMessages(context: OpenClawPluginToolContext, args: Record<string, unknown>) {
  const trusted = trustedContext(context);
  if (!/^[a-zA-Z0-9_-]+$/.test(trusted.sessionId)) throw new Error("Invalid runtime session ID");
  if (!Array.isArray(args.materials))
    throw new Error("materials must be an array of image references");
  const urls = args.materials.map((item: unknown) => {
    const url = (item as { url?: unknown })?.url;
    if (typeof url !== "string") throw new Error("Each material requires a real image url");
    return url;
  });
  const file = join(dirname(context.agentDir!), "sessions", trusted.sessionId + ".jsonl");
  const sourceMessageIds: Record<string, string> = {};
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    let row: { id?: string; message?: { role?: string; content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.message?.role !== "user" || !row.id) continue;
    const content = JSON.stringify(row.message.content ?? "");
    for (const url of urls) {
      if (content.includes(url)) sourceMessageIds[url] = row.id;
    }
  }
  if (urls.some((url) => !sourceMessageIds[url])) {
    throw new Error(
      "图片没有出现在本会话的真实用户消息中。使用用户已发送的图片引用，不得猜地址。登记未执行。",
    );
  }
  return { ...trusted, sourceMessageIds };
}

export function createSpaceMaterialTools(
  context: OpenClawPluginToolContext,
  request: AssistRequest,
): AnyAgentTool[] {
  const definitions = [
    {
      name: "space_read",
      path: "read",
      parameters: readSchema,
      description:
        "查询真实空间：省略 spaceId 列空间；指定则只返回分页目录；query 检索相关证据，sourceId 读取单份资料和图片引用，artifactId/filePath 读成果正文。按 nextOffset 续读，禁止猜路径或用 shell 扫描空间。已有 spaceId 可直接 query。waitSeconds 仅用于明确要求生成成果时等待既有识别，普通查询不等待。",
    },
    {
      name: "space_material_ingest",
      path: "ingest",
      parameters: ingestSchema,
      description:
        "仅本轮用户明确要求保存/入库时使用；仅发送图片或描述图片不授权登记。用户要求入库时直接提交真实聊天图片 url/name，省略 text/facts，不先调用 image，不读取全库。服务立即保存原图并在后台一次识别。已有识别结果才提供 text/facts。普通入库省略 artifact，不额外生成文档。registered/already_registered 表示原图已保存，factsState.ready 才表示要点就绪；queued/running 时附 citationUrl 告知后台处理并结束本轮。明确要求成果时再等待 sourceId 就绪并发布。失败不准用 shell/write 绕过。",
    },
    {
      name: "space_artifact_publish",
      path: "publish",
      parameters: publishSchema,
      description:
        "发布或更新基于历史空间资料的成果，同时保存正文和登记 Artifact。sourceIds 来自 space_read，更新需最新 baseSha256。新增图片及可选成果统一用 space_material_ingest。仅 published/already_published 可确认发布，按返回 card 使用 push_card 展示；失败不要直接写文件。",
    },
  ];
  return definitions.map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_toolCallId, args) {
      try {
        trustedContext(context);
        const payload = args as Record<string, unknown>;
        const body =
          definition.path === "ingest"
            ? { ...payload, context: await sourceMessages(context, payload) }
            : payload;
        const result = await request("POST", `/api/space-materials/${definition.path}`, body);
        const output = jsonResult(result);
        return result.status === "source_registered_artifact_failed"
          ? { ...output, isError: true }
          : output;
      } catch (error) {
        const status = error instanceof AssistHttpError ? error.status : undefined;
        const authFailure = error instanceof SpaceContextError || status === 401 || status === 403;
        const code =
          error instanceof SpaceContextError
            ? error.code
            : status === 401
              ? "SPACE_RUNTIME_UNAUTHORIZED"
              : status === 403
                ? "SPACE_ACCESS_DENIED"
                : status === 404
                  ? "SPACE_NOT_FOUND"
                  : status === 409
                    ? "SPACE_CONFLICT"
                    : status === 422
                      ? "SPACE_INVALID_REQUEST"
                      : status && status >= 500
                        ? "SPACE_SERVICE_UNAVAILABLE"
                        : "SPACE_OPERATION_FAILED";
        return {
          ...jsonResult({
            status: "failed",
            error: error instanceof Error ? error.message : "Space operation failed",
            code,
            ...(error instanceof SpaceContextError && error.missingFields
              ? { missingFields: error.missingFields }
              : {}),
            recovery: authFailure
              ? "停止本轮空间操作，明确说明连接或权限异常、尚未完成。读取失败不表示空间不存在；不能改搜记忆后猜空间ID、建议重建空间、重复索要业务确认或改用文件工具。连接修复后再重试。"
              : "未确认操作完成。先依据错误检查真实空间ID或调用参数；空间名称不能代替ID。资料使用 sourceId，成果使用目录中的 artifactId/filePath；禁止用 exec/read 扫描空间文件代替工具，失败不得宣称完成。",
          }),
          isError: true,
        };
      }
    },
  }));
}
