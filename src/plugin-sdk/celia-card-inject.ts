// Plugin-sdk: celia-canvas transcript card injection.
// Exposes injectMessageBySessionKey for the celia-canvas plugin to persist a
// gateway-injected assistant message (carrying a `[celia_card]` marker) into a
// session transcript, so pushed cards survive history reload.
//
// This wraps the upstream-maintained appendInjectedAssistantMessageToTranscript
// (which owns the exact gateway-injected envelope — provider:"openclaw",
// model:"gateway-injected" — that the celia context filter recognizes and
// strips). We only resolve the session identity (storePath + sessionId) from the
// sessionKey here so the plugin never has to touch storage internals.
import { loadSessionEntryByKey } from "../agents/subagents/announce/subagent-announce-delivery.runtime.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import {
  appendInjectedAssistantMessageToTranscript,
  type GatewayInjectedTranscriptAppendResult,
} from "../gateway/server-methods/chat-transcript-inject.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export type { GatewayInjectedTranscriptAppendResult };

/**
 * Injects a gateway-injected assistant message into a session transcript by
 * session key. Resolves the session identity internally so plugins only need the
 * sessionKey from ctx.
 */
export async function injectMessageBySessionKey(
  sessionKey: string,
  message: string,
  label?: string,
  options?: { idempotencyKey?: string },
): Promise<GatewayInjectedTranscriptAppendResult> {
  const entry = loadSessionEntryByKey(sessionKey);
  const sessionId = entry?.sessionId;
  if (!sessionId) {
    return { ok: false, error: "session not found" };
  }
  const cfg = getRuntimeConfig();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return await appendInjectedAssistantMessageToTranscript({
    storePath,
    sessionId,
    sessionKey,
    agentId,
    message,
    ...(label !== undefined ? { label } : {}),
    ...(options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    config: cfg,
  });
}
