import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  buildPromptContext,
  canonicalSessionKey,
  consumeRuntimeToken,
  resolveTrustedAssistEndpoint,
  SurfaceContextRuntime,
} from "./index.js";
import {
  SurfaceContextClient,
  SurfaceContextClientError,
  type SurfaceContextBinding,
} from "./src/client.js";
import { createSurfaceContextTools } from "./src/runtime.js";
import { createSurfaceContextRuntimeState } from "./src/runtime.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function binding(overrides: Partial<SurfaceContextBinding> = {}): SurfaceContextBinding {
  return {
    bindingId: "ctxbind_0123456789abcdef0123456789abcdef",
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    context: {
      schemaVersion: 1,
      objectType: "SPACE",
      providerId: "com.flowos.floai",
      spaceId: "sp_trip",
      artifactId: null,
      focusedId: null,
      title: "关西旅行",
      summary: "旅行、黄金样例",
      stableRef: "space:sp_trip",
      revision: "7",
    },
    ...overrides,
  };
}

function pairedOperator() {
  return {
    isDeviceTokenAuth: true,
    connect: { role: "operator", device: { id: "android-device" } },
  } as never;
}

function setupPlugin() {
  const registerGatewayMethod = vi.fn();
  const registerTool = vi.fn();
  const on = vi.fn();
  plugin.register({
    config: { session: { mainKey: "main" }, agents: { list: [{ id: "main", default: true }] } },
    registerGatewayMethod,
    registerTool,
    on,
    logger: { warn: vi.fn(), info: vi.fn() },
  } as never);
  return { registerGatewayMethod, registerTool, on };
}

describe("Surface Context standard runtime identity", () => {
  it("accepts only the bounded local Assist topology", () => {
    expect(resolveTrustedAssistEndpoint(undefined)?.origin).toBe("http://127.0.0.1:18790");
    expect(resolveTrustedAssistEndpoint("http://assist:18790")?.origin).toBe("http://assist:18790");
    for (const value of [
      "https://assist:18790",
      "http://attacker:18790",
      "http://127.0.0.1:8080",
      "http://user:password@assist:18790",
      "http://assist:18790/redirect",
      "http://assist:18790/?target=evil",
    ]) {
      expect(resolveTrustedAssistEndpoint(value)).toBeNull();
    }
  });

  it("derives a purpose-bound token from the standard tenant identity secret", () => {
    const token = consumeRuntimeToken({ FLOWOS_TASK_CENTER_JWT_SECRET: "m".repeat(64) });
    expect(token).toBe("483f5c7b38d750cf70960826ff6c61905d27d10a9c10f9fc8fd2489e425d77d3");
    expect(consumeRuntimeToken({ FLOWOS_TASK_CENTER_JWT_SECRET: "short" })).toBeNull();
  });
});

describe("Surface Context Assist client", () => {
  it("posts the ContextRef in the body, never the URL, and parses only the minimal contract", async () => {
    let requestUrl = "";
    const server = createServer((request, response) => {
      requestUrl = request.url ?? "";
      expect(request.headers.authorization).toBe("Bearer runtime-token");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
          contextRef: "context-ref-secret",
          sessionKey: "main",
          turnId: "run-0123456789abcdef",
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(binding()));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const client = new SurfaceContextClient(new URL(`http://127.0.0.1:${port}`), "runtime-token");
      await expect(
        client.consume("context-ref-secret", "main", "run-0123456789abcdef"),
      ).resolves.toMatchObject({
        context: { spaceId: "sp_trip", title: "关西旅行" },
      });
      expect(requestUrl).toBe("/api/surface-context/refs:consume");
      expect(requestUrl).not.toContain("context-ref-secret");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it("rejects redirects and unexpected response fields", async () => {
    let responseBody: Record<string, unknown> | undefined;
    const server = createServer((_request, response) => {
      if (responseBody) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseBody));
      } else {
        response.writeHead(302, { location: "http://attacker.invalid/collect" });
        response.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const client = new SurfaceContextClient(new URL(`http://127.0.0.1:${port}`), "runtime-token");
    try {
      await expect(client.consume("ref", "main", "run-0123456789abcdef")).rejects.toMatchObject({
        code: "CONTEXT_ASSIST_REJECTED",
      });
      responseBody = { ...binding(), filePath: "/private/space" };
      await expect(client.consume("ref", "main", "run-0123456789abcdef")).rejects.toBeInstanceOf(
        SurfaceContextClientError,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });
});

describe("session-bound runtime", () => {
  it("canonicalizes Android aliases without changing the ContextRef consume binding", async () => {
    const consume = vi.fn(async () => binding());
    const runtime = new SurfaceContextRuntime({ consume } as unknown as SurfaceContextClient, {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    });
    await runtime.bind("main", "secret-ref", "run-1");
    expect(consume).toHaveBeenCalledWith("secret-ref", "main", "run-1");
    expect(runtime.active("agent:main:main", "run-1")).toBeUndefined();
    runtime.claimForRun("agent:main:main", "run-1");
    expect(runtime.active("agent:main:main", "run-1")?.context.spaceId).toBe("sp_trip");
    expect(runtime.active("agent:main:main", "run-other")).toBeUndefined();
    expect(runtime.active("agent:main:other", "run-1")).toBeUndefined();
    expect(runtime.clear("main")).toBe(true);
    expect(runtime.active("agent:main:main", "run-1")).toBeUndefined();
  });

  it("shares process-memory bindings across Gateway and Agent plugin registries", async () => {
    const state = createSurfaceContextRuntimeState();
    const consume = vi.fn(async () => binding());
    const gatewayRuntime = new SurfaceContextRuntime(
      { consume } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
      Date.now,
      state,
    );
    const agentRuntime = new SurfaceContextRuntime(
      { consume } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
      Date.now,
      state,
    );
    await gatewayRuntime.bind("session_123", "ref", "run-1");
    agentRuntime.claimForRun("agent:main:session_123", "run-1");
    expect(agentRuntime.active("agent:main:session_123", "run-1")?.context.spaceId).toBe("sp_trip");
  });

  it("does not let an older async bind overwrite a newer clear", async () => {
    let finish: ((value: SurfaceContextBinding) => void) | undefined;
    const consume = vi.fn(
      async () =>
        await new Promise<SurfaceContextBinding>((resolve) => {
          finish = resolve;
        }),
    );
    const runtime = new SurfaceContextRuntime({ consume } as unknown as SurfaceContextClient, {
      agents: { list: [{ id: "main", default: true }] },
    });
    const pending = runtime.bind("main", "ref", "run-1");
    runtime.clear("main");
    finish?.(binding());
    await expect(pending).rejects.toThrow("CONTEXT_STALE_BIND");
    expect(runtime.active("main", "run-1")).toBeUndefined();
  });

  it("expires bindings and exposes tools with no ref or identity arguments", async () => {
    let now = Date.now();
    const consume = vi.fn(async () => binding({ expiresAt: new Date(now + 1_000).toISOString() }));
    const runtime = new SurfaceContextRuntime(
      { consume } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
      () => now,
    );
    await runtime.bind("main", "ref", "run-1");
    runtime.claimForRun("agent:main:main", "run-1");
    const tools = createSurfaceContextTools(runtime, { sessionKey: "agent:main:main" } as never);
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ additionalProperties: false, properties: {} });
    }
    expect(runtime.authorizeTool("agent:main:main", "run-1", "call-1")).toBe(true);
    const resolved = await tools[0]?.execute("call-1", {});
    expect(JSON.stringify(resolved)).toContain("sp_trip");
    now += 1_001;
    expect(runtime.authorizeTool("agent:main:main", "run-1", "call-2")).toBe(false);
    const expired = await tools[0]?.execute("call-2", {});
    expect(JSON.stringify(expired)).toContain("CONTEXT_UNAVAILABLE");
  });

  it("injects availability only, never pointer data or a ContextRef", async () => {
    const runtime = new SurfaceContextRuntime(
      { consume: vi.fn(async () => binding()) } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
    );
    await runtime.bind("main", "super-secret-ref", "run-1");
    const prompt = buildPromptContext(runtime.claimForRun("agent:main:main", "run-1")) ?? "";
    expect(prompt).toContain("surface_context_resolve");
    for (const forbidden of ["super-secret-ref", "sp_trip", "关西旅行", "旅行、黄金样例"]) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it("makes one pre-binding available only to its claimed Agent run", async () => {
    const runtime = new SurfaceContextRuntime(
      { consume: vi.fn(async () => binding()) } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
    );
    await runtime.bind("main", "ref", "run-expected");
    expect(runtime.claimForRun("agent:main:main", "run-sibling")).toBeUndefined();
    expect(runtime.authorizeTool("agent:main:main", "run-sibling", "call-sibling")).toBe(false);
    expect(runtime.claimForRun("agent:main:main", "run-expected")?.context.spaceId).toBe("sp_trip");
    expect(runtime.claimForRun("agent:main:main", "run-expected")?.context.spaceId).toBe("sp_trip");
    runtime.endRun("agent:main:main", "run-expected");
    expect(runtime.active("agent:main:main", "run-expected")).toBeUndefined();
    expect(runtime.claimForRun("agent:main:main", "run-2")).toBeUndefined();
  });

  it("keeps a required obligation after binding TTL until matching agent end", async () => {
    let now = Date.now();
    const runtime = new SurfaceContextRuntime(
      {
        consume: vi.fn(async () => binding({ expiresAt: new Date(now + 1_000).toISOString() })),
      } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
      () => now,
    );
    await runtime.bind("main", "ref", "run-required");
    expect(runtime.requiredRunState("agent:main:main", "run-required")).toBe("MISSING");
    runtime.claimForRun("agent:main:main", "run-required");
    expect(runtime.requiredRunState("agent:main:main", "run-required")).toBe("READY");

    now += 1_001;
    expect(runtime.claimForRun("agent:main:main", "run-required")).toBeUndefined();
    expect(runtime.requiredRunState("agent:main:main", "run-required")).toBe("MISSING");

    runtime.endRun("agent:main:main", "run-required");
    expect(runtime.requiredRunState("agent:main:main", "run-required")).toBe("NOT_REQUIRED");
  });

  it("uses turn-scoped clear as explicit non-delivery cancellation", async () => {
    const runtime = new SurfaceContextRuntime(
      { consume: vi.fn(async () => binding()) } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
    );
    await runtime.bind("main", "ref", "run-cancelled");
    expect(runtime.clear("main", "run-cancelled")).toBe(true);
    expect(runtime.requiredRunState("main", "run-cancelled")).toBe("NOT_REQUIRED");
  });

  it("rejects new required binds when the obligation capacity is full", async () => {
    const state = createSurfaceContextRuntimeState();
    for (let index = 0; index < 1024; index += 1) {
      state.requiredRuns.add(`agent:main:session-${index}\u0000run-${index}`);
    }
    const consume = vi.fn(async () => binding());
    const runtime = new SurfaceContextRuntime(
      { consume } as unknown as SurfaceContextClient,
      { agents: { list: [{ id: "main", default: true }] } },
      Date.now,
      state,
    );

    await expect(runtime.bind("main", "ref", "run-overflow")).rejects.toThrow(
      "CONTEXT_REQUIRED_RUN_LIMIT_REACHED",
    );
    expect(consume).not.toHaveBeenCalled();
  });

  it("keeps a newer in-flight bind generation when the old run ends", async () => {
    let finishSecond: ((value: SurfaceContextBinding) => void) | undefined;
    let consumeCount = 0;
    const consume = vi.fn(async () => {
      consumeCount += 1;
      if (consumeCount === 1) {
        return binding();
      }
      return await new Promise<SurfaceContextBinding>((resolve) => {
        finishSecond = resolve;
      });
    });
    const runtime = new SurfaceContextRuntime({ consume } as unknown as SurfaceContextClient, {
      agents: { list: [{ id: "main", default: true }] },
    });
    await runtime.bind("main", "ref-a", "run-a");
    runtime.claimForRun("main", "run-a");
    const pending = runtime.bind("main", "ref-b", "run-b");
    runtime.endRun("main", "run-a");
    finishSecond?.(binding());
    await expect(pending).resolves.toMatchObject({ context: { spaceId: "sp_trip" } });
    expect(runtime.claimForRun("main", "run-b")?.context.spaceId).toBe("sp_trip");
  });

  it("does not let an old turn rejection cancel a newer in-flight bind", async () => {
    let finishSecond: ((value: SurfaceContextBinding) => void) | undefined;
    let consumeCount = 0;
    const consume = vi.fn(async () => {
      consumeCount += 1;
      if (consumeCount === 1) {
        return binding();
      }
      return await new Promise<SurfaceContextBinding>((resolve) => {
        finishSecond = resolve;
      });
    });
    const runtime = new SurfaceContextRuntime({ consume } as unknown as SurfaceContextClient, {
      agents: { list: [{ id: "main", default: true }] },
    });
    await runtime.bind("main", "ref-a", "run-a");
    runtime.claimForRun("main", "run-a");
    const pending = runtime.bind("main", "ref-b", "run-b");
    expect(runtime.clear("main", "run-a")).toBe(true);
    finishSecond?.(binding());
    await expect(pending).resolves.toMatchObject({ context: { spaceId: "sp_trip" } });
    expect(runtime.claimForRun("main", "run-b")?.context.spaceId).toBe("sp_trip");
  });
});

describe("plugin registration", () => {
  it("keeps the manifest tool contract aligned with runtime registration", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { tools?: string[] } };
    expect(manifest.contracts?.tools).toEqual(["surface_context_resolve"]);
  });

  it("rejects registration without the standard tenant identity secret", () => {
    delete process.env.FLOWOS_TASK_CENTER_JWT_SECRET;
    expect(() => setupPlugin()).toThrow("standard tenant identity config is required");
  });

  it("registers paired-operator bind/clear, session tools and required-run gates", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "m".repeat(64);
    const { registerGatewayMethod, registerTool, on } = setupPlugin();
    expect(registerGatewayMethod.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ["flowos.surfaceContext.bind", { scope: "operator.write" }],
      ["flowos.surfaceContext.clear", { scope: "operator.write" }],
    ]);
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), {
      names: ["surface_context_resolve"],
    });
    expect(on.mock.calls.some((call) => call[0] === "before_prompt_build")).toBe(true);
    expect(on.mock.calls.some((call) => call[0] === "before_agent_run")).toBe(true);
    expect(on.mock.calls.some((call) => call[0] === "before_tool_call")).toBe(true);
    expect(on.mock.calls.some((call) => call[0] === "after_tool_call")).toBe(true);
    expect(on.mock.calls.some((call) => call[0] === "agent_end")).toBe(true);
    const bindHandler = registerGatewayMethod.mock.calls[0]?.[1];
    const respond = vi.fn();
    await bindHandler({ params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0]?.[2]).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("lets only the bound chat run claim prompt and tool access", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "m".repeat(64);
    vi.spyOn(SurfaceContextClient.prototype, "consume").mockResolvedValue(binding());
    const { registerGatewayMethod, registerTool, on } = setupPlugin();
    const bindHandler = registerGatewayMethod.mock.calls[0]?.[1];
    const bindRespond = vi.fn();
    await bindHandler({
      params: {
        contextRef: "r".repeat(40),
        sessionKey: "main",
        turnId: "run-expected-01234567",
      },
      client: pairedOperator(),
      respond: bindRespond,
    });
    expect(bindRespond.mock.calls[0]?.[0]).toBe(true);

    const beforePrompt = on.mock.calls.find((call) => call[0] === "before_prompt_build")?.[1];
    await expect(
      beforePrompt({}, { sessionKey: "agent:main:main", runId: "run-sibling-0123456" }),
    ).resolves.toBeUndefined();
    await expect(
      beforePrompt({}, { sessionKey: "agent:main:main", runId: "run-expected-01234567" }),
    ).resolves.toMatchObject({ prependContext: expect.stringContaining("flowos_surface_context") });

    const beforeRun = on.mock.calls.find((call) => call[0] === "before_agent_run")?.[1];
    await expect(
      beforeRun({}, { sessionKey: "agent:main:main", runId: "run-sibling-0123456" }),
    ).resolves.toBeUndefined();
    await expect(
      beforeRun({}, { sessionKey: "agent:main:main", runId: "run-expected-01234567" }),
    ).resolves.toEqual({ outcome: "pass" });

    const beforeTool = on.mock.calls.find((call) => call[0] === "before_tool_call")?.[1];
    await expect(
      beforeTool(
        {
          toolName: "surface_context_resolve",
          runId: "run-sibling-0123456",
          toolCallId: "call-sibling",
        },
        { sessionKey: "agent:main:main" },
      ),
    ).resolves.toMatchObject({ block: true, blockReason: "CONTEXT_UNAVAILABLE" });
    await expect(
      beforeTool(
        {
          toolName: "surface_context_resolve",
          runId: "run-expected-01234567",
          toolCallId: "call-expected",
        },
        { sessionKey: "agent:main:main" },
      ),
    ).resolves.toBeUndefined();

    const toolFactory = registerTool.mock.calls[0]?.[0];
    const tools = toolFactory({ sessionKey: "agent:main:main" });
    const resolved = await tools[0]?.execute("call-expected", {});
    expect(JSON.stringify(resolved)).toContain("sp_trip");
  });

  it("blocks only a required run whose binding disappeared before prompt claim", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "m".repeat(64);
    vi.spyOn(SurfaceContextClient.prototype, "consume").mockResolvedValue(binding());
    const { registerGatewayMethod, on } = setupPlugin();
    const bindHandler = registerGatewayMethod.mock.calls[0]?.[1];
    await bindHandler({
      params: {
        contextRef: "r".repeat(40),
        sessionKey: "main",
        turnId: "run-required-01234567",
      },
      client: pairedOperator(),
      respond: vi.fn(),
    });
    const clearHandler = registerGatewayMethod.mock.calls[1]?.[1];
    await clearHandler({
      params: { sessionKey: "main" },
      client: pairedOperator(),
      respond: vi.fn(),
    });

    const beforePrompt = on.mock.calls.find((call) => call[0] === "before_prompt_build")?.[1];
    await expect(
      beforePrompt({}, { sessionKey: "agent:main:main", runId: "run-required-01234567" }),
    ).resolves.toBeUndefined();

    const beforeRun = on.mock.calls.find((call) => call[0] === "before_agent_run")?.[1];
    await expect(
      beforeRun({}, { sessionKey: "agent:main:main", runId: "run-unrelated-012345" }),
    ).resolves.toBeUndefined();
    await expect(
      beforeRun({}, { sessionKey: "agent:main:main", runId: "run-required-01234567" }),
    ).resolves.toMatchObject({
      outcome: "block",
      reason: "CONTEXT_REQUIRED_UNAVAILABLE",
      category: "flowos_surface_context",
    });
  });
});

describe("canonical session keys", () => {
  it("maps main and bare app keys to the same keys used by prompt/tool contexts", () => {
    const config = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    };
    expect(canonicalSessionKey(config, "main")).toBe("agent:main:main");
    expect(canonicalSessionKey(config, "session_123")).toBe("agent:main:session_123");
    expect(canonicalSessionKey(config, "agent:main:session_123")).toBe("agent:main:session_123");
  });
});
