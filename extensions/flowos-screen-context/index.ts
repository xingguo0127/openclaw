import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { bareSessionKey, ScreenContextStore, sanitizeField } from "./src/state.js";

export { ScreenContextStore };

function reject(respond: GatewayRequestHandlerOptions["respond"], message: string): void {
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}

function trustedOperator(client: GatewayRequestHandlerOptions["client"]): boolean {
  return Boolean(
    client?.isDeviceTokenAuth && client.connect.role === "operator" && client.connect.device?.id,
  );
}

function defaultAgentId(config: {
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  return (agents.find((item) => item.default)?.id ?? agents[0]?.id ?? "main").trim().toLowerCase();
}

export default definePluginEntry({
  id: "flowos-screen-context",
  name: "FlowOS Screen Context",
  description: "Split-screen / foreground-app context for the phone, injected every agent turn",
  register(api) {
    const store = new ScreenContextStore();

    // Same trust bar as flowos-surface-context: paired operator device (device-token auth) only.
    // Params: { sessionKey, ...payload }; the device sends the bare "session_xxx" key.
    function handler(
      apply: (sessionKey: string, params: Record<string, unknown>) => void,
    ): (opts: GatewayRequestHandlerOptions) => void {
      return ({ params, client, respond }) => {
        if (!trustedOperator(client)) {
          reject(respond, "paired operator device authentication required");
          return;
        }
        const input = (params ?? {}) as Record<string, unknown>;
        const sessionKey = bareSessionKey(input.sessionKey);
        if (!sessionKey || sessionKey.length > 512) {
          reject(respond, "valid sessionKey is required");
          return;
        }
        apply(sessionKey, input);
        respond(true, { ok: true });
      };
    }

    // Agent-scoped key for system events (the queue is keyed by the canonical session key).
    function scopedKey(sessionKey: string): string {
      return `agent:${defaultAgentId(api.config)}:${sessionKey}`;
    }

    function wake(sessionKey: string, summary: string, reason: string): void {
      const key = scopedKey(sessionKey);
      const queued = api.runtime.system.enqueueSystemEvent(summary, {
        sessionKey: key,
        contextKey: "collab",
      });
      if (queued) {
        // Entering/leaving split-screen has no user message, so wake the agent explicitly.
        api.runtime.system.requestHeartbeat({
          source: "other",
          intent: "event",
          reason,
          sessionKey: key,
        });
      }
    }

    api.registerGatewayMethod(
      "flowos.screen.collab.enter",
      handler((sessionKey, input) => {
        const state = store.setCollab(sessionKey, input);
        const label = state.leftAppLabel ?? state.leftPackage ?? "未知应用";
        wake(
          sessionKey,
          `进入分屏协作:左侧=${label}(${state.readable ? "可读" : "不可读"})`,
          "collab-entered",
        );
      }),
      { scope: "operator.write" },
    );

    api.registerGatewayMethod(
      "flowos.screen.collab.exit",
      handler((sessionKey) => {
        store.clearCollab(sessionKey);
        wake(sessionKey, "退出分屏协作", "collab-exited");
      }),
      { scope: "operator.write" },
    );

    // ambient: no system event / heartbeat on purpose. The device sends chat.send right after this
    // on the same socket, so the agent is woken by that message anyway; an extra system event would
    // wake it twice and make it speak before the user's first line.
    api.registerGatewayMethod(
      "flowos.screen.ambient.enter",
      handler((sessionKey, input) => {
        store.setAmbient(sessionKey, input);
      }),
      { scope: "operator.write" },
    );

    api.on("before_prompt_build", async (_event, context) => {
      const prependContext = store.buildPrompt(context.sessionKey);
      return prependContext ? { prependContext } : undefined;
    });
  },
});

export { sanitizeField };
