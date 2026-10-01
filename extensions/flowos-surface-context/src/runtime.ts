import { jsonResult } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { SurfaceContextBinding, SurfaceContextBrief } from "./client.js";
import { SurfaceContextClient } from "./client.js";

const maxBindings = 1024;
const maxRequiredRuns = 1024;
const runtimeStateSymbol = Symbol.for("openclaw.flowosSurfaceContextRuntimeState");

type ActiveBinding = SurfaceContextBinding & {
  expiresAtMs: number;
};

type PendingBinding = ActiveBinding & { runId: string };
type ToolAuthorization = ActiveBinding & { sessionKey: string; runId: string };

export type SurfaceContextRuntimeState = {
  bindings: Map<string, PendingBinding>;
  activeRuns: Map<string, ActiveBinding & { runId: string }>;
  requiredRuns: Set<string>;
  generations: Map<string, number>;
  inFlightBindings: Map<string, Set<string>>;
  cancelledRuns: Set<string>;
  toolAuthorizations: Map<string, ToolAuthorization>;
};

export function createSurfaceContextRuntimeState(): SurfaceContextRuntimeState {
  return {
    bindings: new Map(),
    activeRuns: new Map(),
    requiredRuns: new Set(),
    generations: new Map(),
    inFlightBindings: new Map(),
    cancelledRuns: new Set(),
    toolAuthorizations: new Map(),
  };
}

export function sharedSurfaceContextRuntimeState(): SurfaceContextRuntimeState {
  const root = globalThis as typeof globalThis & {
    [runtimeStateSymbol]?: SurfaceContextRuntimeState;
  };
  return (root[runtimeStateSymbol] ??= createSurfaceContextRuntimeState());
}

export function clearSharedSurfaceContextRuntimeStateForTest(): void {
  const root = globalThis as typeof globalThis & {
    [runtimeStateSymbol]?: SurfaceContextRuntimeState;
  };
  delete root[runtimeStateSymbol];
}

function defaultAgentId(config: {
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  return (agents.find((item) => item.default)?.id ?? agents[0]?.id ?? "main").trim().toLowerCase();
}

export function canonicalSessionKey(
  config: {
    session?: { scope?: string; mainKey?: string };
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  },
  value: string,
): string {
  const raw = value.trim().toLowerCase();
  if (!raw || raw === "global" || raw === "unknown") {
    return raw;
  }
  const mainKey = config.session?.mainKey?.trim().toLowerCase() || "main";
  const agentId = defaultAgentId(config);
  if (config.session?.scope === "global" && (raw === "main" || raw === mainKey)) {
    return "global";
  }
  if (
    raw === "main" ||
    raw === mainKey ||
    raw === `agent:main:main` ||
    raw === `agent:${agentId}:main`
  ) {
    return `agent:${agentId}:${mainKey}`;
  }
  return raw.startsWith("agent:") ? raw : `agent:${agentId}:${raw}`;
}

export class SurfaceContextRuntime {
  constructor(
    private readonly client: SurfaceContextClient,
    private readonly config: Parameters<typeof canonicalSessionKey>[0],
    private readonly now: () => number = Date.now,
    private readonly state: SurfaceContextRuntimeState = createSurfaceContextRuntimeState(),
  ) {}

  private bump(sessionKey: string): number {
    const generation = (this.state.generations.get(sessionKey) ?? 0) + 1;
    this.state.generations.set(sessionKey, generation);
    return generation;
  }

  private sweepExpired(): void {
    const now = this.now();
    for (const [key, binding] of this.state.bindings) {
      if (binding.expiresAtMs <= now) {
        this.state.bindings.delete(key);
      }
    }
    for (const [key, binding] of this.state.activeRuns) {
      if (binding.expiresAtMs <= now) {
        this.state.activeRuns.delete(key);
      }
    }
    for (const [key, authorization] of this.state.toolAuthorizations) {
      if (authorization.expiresAtMs <= now) {
        this.state.toolAuthorizations.delete(key);
      }
    }
    for (const key of this.state.generations.keys()) {
      if (
        !this.state.bindings.has(key) &&
        !this.state.activeRuns.has(key) &&
        !this.state.inFlightBindings.has(key)
      ) {
        this.state.generations.delete(key);
      }
    }
  }

  private runKey(sessionKey: string, runId: string): string {
    return `${sessionKey}\u0000${runId}`;
  }

  private beginBind(sessionKey: string, runId: string): void {
    const runs = this.state.inFlightBindings.get(sessionKey) ?? new Set<string>();
    runs.add(runId);
    this.state.inFlightBindings.set(sessionKey, runs);
  }

  private endBind(sessionKey: string, runId: string): void {
    const runs = this.state.inFlightBindings.get(sessionKey);
    runs?.delete(runId);
    this.state.cancelledRuns.delete(this.runKey(sessionKey, runId));
    if (!runs || runs.size === 0) {
      this.state.inFlightBindings.delete(sessionKey);
      if (!this.state.bindings.has(sessionKey) && !this.state.activeRuns.has(sessionKey)) {
        this.state.generations.delete(sessionKey);
      }
    }
  }

  async bind(rawSessionKey: string, contextRef: string, runId: string): Promise<ActiveBinding> {
    this.sweepExpired();
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    if (!sessionKey || !runId) {
      throw new Error("CONTEXT_TURN_INVALID");
    }
    const requiredRunKey = this.runKey(sessionKey, runId);
    if (
      !this.state.requiredRuns.has(requiredRunKey) &&
      this.state.requiredRuns.size >= maxRequiredRuns
    ) {
      throw new Error("CONTEXT_REQUIRED_RUN_LIMIT_REACHED");
    }
    const generation = this.bump(sessionKey);
    this.beginBind(sessionKey, runId);
    try {
      const binding = await this.client.consume(contextRef, rawSessionKey, runId);
      if (this.state.cancelledRuns.has(this.runKey(sessionKey, runId))) {
        throw new Error("CONTEXT_STALE_BIND");
      }
      if (this.state.generations.get(sessionKey) !== generation) {
        throw new Error("CONTEXT_STALE_BIND");
      }
      const expiresAtMs = Date.parse(binding.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= this.now()) {
        throw new Error("CONTEXT_EXPIRED");
      }
      if (
        !this.state.bindings.has(sessionKey) &&
        !this.state.activeRuns.has(sessionKey) &&
        this.state.bindings.size + this.state.activeRuns.size >= maxBindings
      ) {
        throw new Error("CONTEXT_BINDING_LIMIT_REACHED");
      }
      const active = { ...binding, expiresAtMs };
      // 新页面 Ref 先撤销当前 run 的旧对象；旧工具调用随后只能得到 unavailable。
      this.state.activeRuns.delete(sessionKey);
      this.clearToolAuthorizations(sessionKey);
      this.state.requiredRuns.add(requiredRunKey);
      this.state.bindings.set(sessionKey, { ...active, runId });
      return active;
    } finally {
      this.endBind(sessionKey, runId);
    }
  }

  clear(rawSessionKey: string, expectedRunId?: string): boolean {
    this.sweepExpired();
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    const pendingBinding = this.state.bindings.get(sessionKey);
    const activeBinding = this.state.activeRuns.get(sessionKey);
    const matchingInFlight = expectedRunId
      ? this.state.inFlightBindings.get(sessionKey)?.has(expectedRunId) === true
      : false;
    const matchingRequired = expectedRunId
      ? this.state.requiredRuns.has(this.runKey(sessionKey, expectedRunId))
      : false;
    if (
      expectedRunId &&
      pendingBinding?.runId !== expectedRunId &&
      activeBinding?.runId !== expectedRunId &&
      !matchingInFlight &&
      !matchingRequired
    ) {
      return false;
    }
    if (expectedRunId) {
      if (matchingInFlight) {
        this.state.cancelledRuns.add(this.runKey(sessionKey, expectedRunId));
      }
      // turn-scoped clear only comes from Android before chat delivery is accepted.
      this.state.requiredRuns.delete(this.runKey(sessionKey, expectedRunId));
    } else {
      this.bump(sessionKey);
    }
    const pending =
      !expectedRunId || pendingBinding?.runId === expectedRunId
        ? this.state.bindings.delete(sessionKey)
        : false;
    const active =
      !expectedRunId || activeBinding?.runId === expectedRunId
        ? this.state.activeRuns.delete(sessionKey)
        : false;
    this.clearToolAuthorizations(sessionKey, expectedRunId);
    return pending || active || matchingRequired;
  }

  active(rawSessionKey: string | undefined, runId: string | undefined): ActiveBinding | undefined {
    this.sweepExpired();
    if (!rawSessionKey || !runId) {
      return undefined;
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    const binding = this.state.activeRuns.get(sessionKey);
    if (!binding || binding.runId !== runId) {
      return undefined;
    }
    if (binding.expiresAtMs <= this.now()) {
      this.state.activeRuns.delete(sessionKey);
      return undefined;
    }
    return binding;
  }

  requiredRunState(
    rawSessionKey: string | undefined,
    runId: string | undefined,
  ): "NOT_REQUIRED" | "READY" | "MISSING" {
    this.sweepExpired();
    if (!rawSessionKey || !runId) {
      return "NOT_REQUIRED";
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    if (!this.state.requiredRuns.has(this.runKey(sessionKey, runId))) {
      return "NOT_REQUIRED";
    }
    return this.active(sessionKey, runId) ? "READY" : "MISSING";
  }

  claimForRun(
    rawSessionKey: string | undefined,
    runId: string | undefined,
  ): ActiveBinding | undefined {
    this.sweepExpired();
    if (!rawSessionKey || !runId) {
      return undefined;
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    const current = this.state.activeRuns.get(sessionKey);
    if (current?.runId === runId) {
      return current;
    }
    const pending = this.state.bindings.get(sessionKey);
    if (!pending || pending.runId !== runId) {
      return undefined;
    }
    this.state.bindings.delete(sessionKey);
    this.state.activeRuns.set(sessionKey, pending);
    return pending;
  }

  authorizeTool(
    rawSessionKey: string | undefined,
    runId: string | undefined,
    toolCallId: string | undefined,
  ): boolean {
    if (!rawSessionKey || !runId || !toolCallId) {
      return false;
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    const binding = this.active(sessionKey, runId);
    if (!binding) {
      return false;
    }
    this.state.toolAuthorizations.set(toolCallId, { ...binding, sessionKey, runId });
    return true;
  }

  consumeToolAuthorization(
    rawSessionKey: string | undefined,
    toolCallId: string | undefined,
  ): ActiveBinding | undefined {
    this.sweepExpired();
    if (!rawSessionKey || !toolCallId) {
      return undefined;
    }
    const authorization = this.state.toolAuthorizations.get(toolCallId);
    this.state.toolAuthorizations.delete(toolCallId);
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    return authorization?.sessionKey === sessionKey ? authorization : undefined;
  }

  clearToolCall(toolCallId: string | undefined): void {
    if (toolCallId) {
      this.state.toolAuthorizations.delete(toolCallId);
    }
  }

  private clearToolAuthorizations(sessionKey: string, runId?: string): void {
    for (const [toolCallId, authorization] of this.state.toolAuthorizations) {
      if (authorization.sessionKey === sessionKey && (!runId || authorization.runId === runId)) {
        this.state.toolAuthorizations.delete(toolCallId);
      }
    }
  }

  endRun(rawSessionKey: string | undefined, runId: string | undefined): void {
    this.sweepExpired();
    if (!rawSessionKey || !runId) {
      return;
    }
    const sessionKey = canonicalSessionKey(this.config, rawSessionKey);
    this.state.requiredRuns.delete(this.runKey(sessionKey, runId));
    if (this.state.activeRuns.get(sessionKey)?.runId === runId) {
      this.state.activeRuns.delete(sessionKey);
      this.clearToolAuthorizations(sessionKey, runId);
      if (!this.state.bindings.has(sessionKey) && !this.state.inFlightBindings.has(sessionKey)) {
        this.state.generations.delete(sessionKey);
      }
    }
  }
}

function requireSession(context: OpenClawPluginToolContext): string {
  const sessionKey = context.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("Surface Context tools require a trusted session context");
  }
  return sessionKey;
}

export function createSurfaceContextTools(
  runtime: SurfaceContextRuntime,
  context: OpenClawPluginToolContext,
): AnyAgentTool[] {
  const emptyParameters = Type.Object({}, { additionalProperties: false });
  const resolve: AnyAgentTool = {
    name: "surface_context_resolve",
    label: "Surface Context Resolve",
    description:
      "Read the permission-filtered minimal Space or Artifact brief bound to this exact session. Takes no ref, path, user, tenant, endpoint, or credential arguments.",
    executionMode: "sequential",
    parameters: emptyParameters,
    async execute(toolCallId) {
      const binding = runtime.consumeToolAuthorization(requireSession(context), toolCallId);
      if (!binding) {
        return jsonResult({ available: false, reason: "CONTEXT_UNAVAILABLE" });
      }
      return jsonResult({
        available: true,
        context: binding.context satisfies SurfaceContextBrief,
      });
    },
  };
  return [resolve];
}

export function buildPromptContext(binding: ActiveBinding | undefined): string | undefined {
  if (!binding) {
    return undefined;
  }
  return [
    "<flowos_surface_context>",
    "当前 OpenClaw session 已绑定一份由 FlowOS 验证的短时手机 Surface Context。",
    `对象类型：${binding.context.objectType}；Provider：${binding.context.providerId}。`,
    "如需理解当前对象，调用 surface_context_resolve。",
    "不要向用户索要 ContextRef、userId、tenantId、文件路径或凭据。",
    "</flowos_surface_context>",
  ].join("\n");
}
