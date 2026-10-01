import { createHash } from "node:crypto";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  consumeRuntimeToken,
  resolveTrustedAssistEndpoint,
  SurfaceContextClient,
  SurfaceContextClientError,
} from "./src/client.js";
import {
  buildPromptContext,
  canonicalSessionKey,
  createSurfaceContextTools,
  sharedSurfaceContextRuntimeState,
  SurfaceContextRuntime,
} from "./src/runtime.js";

export { consumeRuntimeToken, resolveTrustedAssistEndpoint };
export { buildPromptContext, canonicalSessionKey, SurfaceContextRuntime };

function normalizedString(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.trim().length <= maxLength ? value.trim() : "";
}

function reject(
  respond: GatewayRequestHandlerOptions["respond"],
  code: string,
  message: string,
): void {
  respond(false, undefined, { code, message });
}

function trustedOperator(client: GatewayRequestHandlerOptions["client"]): boolean {
  return Boolean(
    client?.isDeviceTokenAuth && client.connect.role === "operator" && client.connect.device?.id,
  );
}

function sessionAuditHash(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, 12);
}

export default definePluginEntry({
  id: "flowos-surface-context",
  name: "FlowOS Surface Context",
  description: "Bind pointer-only phone Surface Context to one trusted OpenClaw session",
  register(api) {
    const endpoint = resolveTrustedAssistEndpoint(process.env.ASSIST_API_BASE);
    const token = consumeRuntimeToken();
    if (!endpoint || !token) {
      throw new Error("FlowOS standard tenant identity config is required");
    }
    const surfaceClient = new SurfaceContextClient(endpoint, token);
    const runtime = new SurfaceContextRuntime(
      surfaceClient,
      api.config,
      Date.now,
      sharedSurfaceContextRuntimeState(),
    );

    api.registerGatewayMethod(
      "flowos.surfaceContext.bind",
      async ({ params, client, respond }) => {
        if (!trustedOperator(client)) {
          api.logger.warn("FlowOS Surface Context bind rejected: untrusted operator client");
          reject(respond, "INVALID_REQUEST", "paired operator device authentication required");
          return;
        }
        const input = params ?? {};
        if (
          Object.keys(input).toSorted().join(",") !== "contextRef,sessionKey,turnId" ||
          !normalizedString(input.contextRef, 2048) ||
          !normalizedString(input.sessionKey, 512) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(String(input.sessionKey)) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(normalizedString(input.turnId, 128))
        ) {
          api.logger.warn("FlowOS Surface Context bind rejected: invalid pointer-only request");
          reject(
            respond,
            "INVALID_REQUEST",
            "valid ContextRef, sessionKey and turnId are required",
          );
          return;
        }
        try {
          const binding = await runtime.bind(
            String(input.sessionKey),
            String(input.contextRef),
            String(input.turnId),
          );
          api.logger.info(
            `FlowOS Surface Context bound session=${sessionAuditHash(String(input.sessionKey))} objectType=${binding.context.objectType}`,
          );
          respond(true, {
            bound: true,
            objectType: binding.context.objectType,
            expiresAt: binding.expiresAt,
          });
        } catch (error) {
          const code =
            error instanceof SurfaceContextClientError
              ? error.code
              : error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
                ? error.message
                : "CONTEXT_BIND_FAILED";
          api.logger.warn(
            `FlowOS Surface Context bind rejected session=${sessionAuditHash(String(input.sessionKey))} code=${code}`,
          );
          reject(respond, code, code);
        }
      },
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "flowos.surfaceContext.clear",
      async ({ params, client, respond }) => {
        if (!trustedOperator(client)) {
          reject(respond, "INVALID_REQUEST", "paired operator device authentication required");
          return;
        }
        const input = params ?? {};
        const sessionKey = normalizedString(input.sessionKey, 512);
        const turnId = normalizedString(input.turnId, 128);
        const keys = Object.keys(input).toSorted().join(",");
        if (
          (keys !== "sessionKey" && keys !== "sessionKey,turnId") ||
          !sessionKey ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(sessionKey) ||
          (keys === "sessionKey,turnId" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(turnId))
        ) {
          reject(respond, "INVALID_REQUEST", "valid sessionKey is required");
          return;
        }
        const canonical = canonicalSessionKey(api.config, sessionKey);
        respond(true, {
          cleared: runtime.clear(sessionKey, turnId || undefined),
          sessionKey: canonical,
        });
      },
      { scope: "operator.write" },
    );

    api.registerTool((context) => createSurfaceContextTools(runtime, context), {
      names: ["surface_context_resolve"],
    });

    api.on("before_prompt_build", async (_event, context) => {
      const binding = runtime.claimForRun(context.sessionKey, context.runId);
      const prependContext = buildPromptContext(binding);
      return prependContext ? { prependContext } : undefined;
    });

    api.on("before_agent_run", async (_event, context) => {
      const state = runtime.requiredRunState(context.sessionKey, context.runId);
      if (state === "NOT_REQUIRED") {
        return undefined;
      }
      if (state === "READY") {
        return { outcome: "pass" };
      }
      return {
        outcome: "block",
        reason: "CONTEXT_REQUIRED_UNAVAILABLE",
        message: "当前项目上下文已失效，请回到任务空间重试",
        category: "flowos_surface_context",
      };
    });

    api.on("before_tool_call", async (event, context) => {
      if (event.toolName !== "surface_context_resolve") {
        return undefined;
      }
      const authorized = runtime.authorizeTool(
        context.sessionKey,
        event.runId ?? context.runId,
        event.toolCallId,
      );
      if (!authorized) {
        return { block: true, blockReason: "CONTEXT_UNAVAILABLE" };
      }
      return undefined;
    });

    api.on("after_tool_call", async (event) => {
      if (event.toolName === "surface_context_resolve") {
        runtime.clearToolCall(event.toolCallId);
      }
    });

    api.on("agent_end", async (event, context) => {
      runtime.endRun(context.sessionKey, event.runId ?? context.runId);
    });
  },
});
