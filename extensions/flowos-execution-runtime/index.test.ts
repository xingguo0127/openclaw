import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, {
  deliverExecutionResultCard,
  deriveExecutionRuntimeToken,
  deriveImageGenerationRuntimeToken,
} from "./index.js";
import { RunBindingStore, type RunBinding } from "./src/bindings.js";
import {
  type ActiveExecution,
  FlowosExecutionClient,
  resolveTrustedAssistEndpoint,
  type AssistRequest,
} from "./src/client.js";
import { ExecutionLocks } from "./src/locks.js";
import { FlowosExecutionRuntime } from "./src/runtime.js";
import { createFlowosExecutionTools } from "./src/tools.js";
import type { SpaceArtifactValidation } from "./src/validation.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function memoryStore<T>(): PluginStateKeyedStore<T> {
  const values = new Map<string, { value: T; createdAt: number }>();
  return {
    async register(key, value) {
      values.set(key, { value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, { value, createdAt: Date.now() });
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key)?.value);
      if (next === undefined) {
        values.delete(key);
      } else {
        values.set(key, { value: next, createdAt: Date.now() });
      }
      return true;
    },
    async lookup(key) {
      return values.get(key)?.value;
    },
    async consume(key) {
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(([key, entry]) => Object.assign({ key }, entry));
    },
    async clear() {
      values.clear();
    },
  };
}

function ttlAwareMemoryStore<T>() {
  let now = 0;
  const values = new Map<string, { value: T; createdAt: number; expiresAt?: number }>();
  const prune = () => {
    for (const [key, entry] of values) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        values.delete(key);
      }
    }
  };
  const store: PluginStateKeyedStore<T> = {
    async register(key, value, opts) {
      values.set(key, {
        value,
        createdAt: now,
        ...(opts?.ttlMs ? { expiresAt: now + opts.ttlMs } : {}),
      });
    },
    async registerIfAbsent(key, value, opts) {
      prune();
      if (values.has(key)) {
        return false;
      }
      await store.register(key, value, opts);
      return true;
    },
    async update(key, updateValue, opts) {
      prune();
      const next = updateValue(values.get(key)?.value);
      if (next === undefined) {
        values.delete(key);
      } else {
        await store.register(key, next, opts);
      }
      return true;
    },
    async lookup(key) {
      prune();
      return values.get(key)?.value;
    },
    async consume(key) {
      prune();
      const value = values.get(key)?.value;
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      prune();
      return [...values.entries()].map(([key, entry]) => Object.assign({ key }, entry));
    },
    async clear() {
      values.clear();
    },
  };
  return {
    store,
    advance(ms: number) {
      now += ms;
    },
  };
}

function fakeClient(options?: {
  beforeRequest?: (
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ) => Promise<void> | void;
  afterRequest?: (
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ) => Promise<void> | void;
}) {
  const calls: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  let item: ActiveExecution = {
    executionId: "execution-1",
    currentAttemptId: "attempt-1",
    ownerAgentId: "agent:main",
    status: "PLANNING",
    version: 1,
    stageKey: "planning",
  };
  const request: AssistRequest = vi.fn(async (method, path, payload) => {
    await options?.beforeRequest?.(method, path, payload);
    calls.push({ method, path, payload });
    if (method === "GET") {
      return item;
    }
    if (path === "/api/executions") {
      item = {
        ...item,
        spaceId: typeof payload?.spaceId === "string" ? payload.spaceId : null,
        taskId: typeof payload?.taskId === "string" ? payload.taskId : null,
      };
      return item;
    }
    if (path.endsWith("/space-artifacts")) {
      return {
        type: "SPACE_ARTIFACT",
        id: "art-flowos-1",
        spaceId: item.spaceId ?? "",
      };
    }
    if (path.endsWith("/stage")) {
      item = {
        ...item,
        status: "RUNNING",
        version: item.version + 1,
        stageKey: String(payload?.stageKey),
      };
    } else if (path.endsWith("/complete")) {
      item = {
        ...item,
        status: "SUCCEEDED",
        version: item.version + 1,
        stageKey: "completed",
        resultRef: payload?.resultRef as ActiveExecution["resultRef"],
      };
    } else if (path.endsWith("/fail")) {
      item = { ...item, status: "FAILED", version: item.version + 1, stageKey: "failed" };
    }
    await options?.afterRequest?.(method, path, payload);
    return item;
  });
  return {
    client: new FlowosExecutionClient(request),
    calls,
    getItem: () => item,
    setItem: (next: Partial<ActiveExecution>) => {
      item = { ...item, ...next };
    },
  };
}

function fakeSubagent() {
  return {
    run: vi.fn<PluginRuntime["subagent"]["run"]>(async (params) => ({
      runId: params.idempotencyKey ?? "run-1",
    })),
    waitForRun: vi.fn<PluginRuntime["subagent"]["waitForRun"]>(async () => ({
      status: "timeout",
    })),
    getRunStatus: vi.fn<PluginRuntime["subagent"]["getRunStatus"]>(async () => ({
      status: "missing",
    })),
    getSessionMessages: vi.fn<PluginRuntime["subagent"]["getSessionMessages"]>(async () => ({
      messages: [],
    })),
    getSession: vi.fn<PluginRuntime["subagent"]["getSession"]>(async () => ({ messages: [] })),
    deleteSession: vi.fn<PluginRuntime["subagent"]["deleteSession"]>(async () => undefined),
  };
}

function fakeSystem() {
  return {
    enqueueSystemEvent: vi.fn(() => true),
    requestHeartbeat: vi.fn(),
  };
}

type ArtifactValidator = (params: {
  spaceId: string;
  filePath: string;
  artifactType: "html" | "markdown";
}) => Promise<SpaceArtifactValidation>;

type ResultCardDelivery = (params: {
  sessionKey: string;
  executionId: string;
  attemptId: string;
  spaceId: string;
  artifactTitle: string;
  artifactFilePath: string;
  caption: string;
}) => Promise<void>;

function tools(params?: {
  context?: { agentId?: string; sessionKey?: string; workspaceDir?: string };
  client?: FlowosExecutionClient;
  bindings?: RunBindingStore;
  subagent?: ReturnType<typeof fakeSubagent>;
  system?: ReturnType<typeof fakeSystem>;
  locks?: ExecutionLocks;
  runtime?: FlowosExecutionRuntime;
  validateArtifact?: ArtifactValidator;
  deliverResultCard?: ResultCardDelivery;
}) {
  const assist = params?.client ? { client: params.client } : fakeClient();
  const bindings = params?.bindings ?? new RunBindingStore(memoryStore());
  const subagent = params?.subagent ?? fakeSubagent();
  const system = params?.system ?? fakeSystem();
  const locks = params?.locks ?? new ExecutionLocks();
  const deliverResultCard = params?.deliverResultCard ?? vi.fn<ResultCardDelivery>();
  const validateArtifact =
    params?.validateArtifact ??
    vi.fn<ArtifactValidator>(async () => ({
      validatorId: "lushu-html-v1" as const,
      contentSha256: "a".repeat(64),
    }));
  const runtime =
    params?.runtime ??
    new FlowosExecutionRuntime(
      assist.client,
      bindings,
      subagent as never,
      system as never,
      deliverResultCard,
      { warn: vi.fn(), info: vi.fn() },
      locks,
      (plan) =>
        validateArtifact({
          spaceId: plan.spaceId,
          filePath: plan.artifactFilePath,
          artifactType: plan.artifactType,
        }),
    );
  const created = createFlowosExecutionTools({
    api: { runtime: { subagent } } as never,
    context: params?.context ?? {
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/workspace",
    },
    client: assist.client,
    bindings,
    locks,
    runtime,
    ownerAgentId: "agent:main",
    validateArtifact,
  });
  return {
    byName: new Map(created.map((tool) => [tool.name, tool])),
    bindings,
    subagent,
    system,
    locks,
    runtime,
    validateArtifact,
    deliverResultCard,
  };
}

async function markChildEndedOk(owner: ReturnType<typeof tools>) {
  await owner.bindings.save({
    executionId: "execution-1",
    attemptId: "attempt-1",
    requesterSessionKey: "agent:main:main",
    ownerAgentId: "agent:main",
    targetAgentId: "worker",
    childSessionKey: "agent:worker:subagent:flowos-1",
    runId: "run-1",
    status: "ENDED_OK",
    createdAt: 1,
    updatedAt: 1,
  });
}

async function startExecution(byName: Map<string, AnyAgentTool>) {
  await byName.get("flowos_execution_start")?.execute("start", {
    source: "USER",
    taskKind: "lushu",
    title: "生成路书",
    idempotencyKey: "request-1",
  });
}

async function startSpaceExecution(byName: Map<string, AnyAgentTool>) {
  await byName.get("flowos_execution_start")?.execute("start", {
    source: "SPACE_TASK",
    taskKind: "lushu",
    title: "生成路书",
    idempotencyKey: "request-space-1",
    spaceId: "sp-trip",
  });
}

async function startRoutebookExecution(byName: Map<string, AnyAgentTool>, spaceId = "sp-trip") {
  await byName.get("flowos_execution_start")?.execute("start", {
    source: "SPACE_TASK",
    taskKind: "ROUTEBOOK_GENERATION",
    title: "生成路书",
    idempotencyKey: "request-routebook-1",
    spaceId,
  });
}

const routebookResultPlan = {
  spaceId: "sp-trip",
  artifactTitle: "蚌埠路书",
  artifactFilePath: "generated/蚌埠路书.html",
  artifactType: "html" as const,
  cardCaption: "路书做好啦，点开看看～",
};

async function spawnRoutebook(owner: ReturnType<typeof tools>, resultPlan = routebookResultPlan) {
  await owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
    executionId: "execution-1",
    attemptId: "attempt-1",
    agentId: "worker",
    task: "generate a routebook",
    resultPlan,
  });
}

describe("FlowOS Execution plugin boundaries", () => {
  it("keeps pending result delivery beyond terminal TTL and expires only after delivery", async () => {
    const clock = ttlAwareMemoryStore<RunBinding>();
    const bindings = new RunBindingStore(clock.store);
    const base: RunBinding = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:main",
      ownerAgentId: "agent:main",
      targetAgentId: "worker",
      childSessionKey: "agent:worker:subagent:flowos-1",
      runId: "run-1",
      status: "ENDED_OK",
      createdAt: 1,
      updatedAt: 1,
    };
    const pending = {
      expectedVersion: 2,
      resultRef: { type: "SPACE_ARTIFACT" as const, id: "art-1", spaceId: "sp-trip" },
      card: {
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        caption: "路书做好啦，点开看看～",
      },
    };

    await bindings.save(base);
    clock.advance(7 * 60 * 60_000);
    expect(await bindings.byExecution("execution-1", "attempt-1")).toBeDefined();

    await bindings.save({
      ...base,
      resultDelivery: { ...pending, status: "PREPARED" },
    });
    clock.advance(7 * 60 * 60_000);
    expect(await bindings.byExecution("execution-1", "attempt-1")).toBeDefined();

    await bindings.save({
      ...base,
      resultDelivery: { ...pending, status: "EXECUTION_COMPLETED" },
    });
    clock.advance(7 * 60 * 60_000);
    expect(await bindings.byExecution("execution-1", "attempt-1")).toBeDefined();

    await bindings.save({
      ...base,
      resultDelivery: { ...pending, status: "DELIVERED" },
    });
    clock.advance(7 * 60 * 60_000);
    expect(await bindings.byExecution("execution-1", "attempt-1")).toBeUndefined();
  });

  it("delivers one live requester card after its durable transcript append", async () => {
    const inject = vi.fn(async () => ({ ok: true, messageId: "message-1" }));
    const nodeSend = vi.fn();
    const params = {
      sessionKey: "agent:main:main",
      executionId: "execution-1",
      attemptId: "attempt-1",
      spaceId: "sp-trip",
      artifactTitle: "旅行路书",
      artifactFilePath: "generated/lushu.html",
      caption: "路书做好啦，点开看看～",
    };
    await deliverExecutionResultCard(params, inject, nodeSend);
    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith(
      params.sessionKey,
      expect.stringContaining(
        '[celia_card]{"type":"resource_card","resourceType":"file","id":"sp-trip"',
      ),
      undefined,
      { idempotencyKey: "flowos-execution:execution-1:attempt-1:result-card" },
    );
    expect(nodeSend).toHaveBeenCalledOnce();
    const payload = {
      cardJson: expect.stringContaining(
        '"filePath":"generated/lushu.html","action":"create","caption":"路书做好啦，点开看看～"',
      ),
    };
    expect(nodeSend).toHaveBeenCalledWith("agent:main:main", "canvas.card.push", payload);
    expect(inject.mock.invocationCallOrder[0]).toBeLessThan(nodeSend.mock.invocationCallOrder[0]);
  });

  it("does not publish a live card when its durable transcript append fails", async () => {
    const inject = vi.fn(async () => ({ ok: false, error: "transcript unavailable" }));
    const nodeSend = vi.fn();
    await expect(
      deliverExecutionResultCard(
        {
          sessionKey: "agent:main:session-1",
          executionId: "execution-1",
          attemptId: "attempt-1",
          spaceId: "sp-trip",
          artifactTitle: "旅行路书",
          artifactFilePath: "generated/lushu.html",
          caption: "路书做好啦，点开看看～",
        },
        inject,
        nodeSend,
      ),
    ).rejects.toThrow("result card delivery is unavailable");
    expect(nodeSend).not.toHaveBeenCalled();
  });

  it("allows only native loopback and Compose Assist origins", () => {
    expect(resolveTrustedAssistEndpoint(undefined)?.origin).toBe("http://127.0.0.1:18790");
    expect(resolveTrustedAssistEndpoint("http://assist:18790")?.origin).toBe("http://assist:18790");
    for (const value of [
      "https://assist:18790",
      "http://attacker:18790",
      "http://127.0.0.1:8080",
      "http://user:password@assist:18790",
      "http://assist:18790/path",
      "http://assist:18790/?target=evil",
    ]) {
      expect(resolveTrustedAssistEndpoint(value)).toBeNull();
    }
  });

  it("derives a purpose-bound token from the standard tenant identity secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "flowos-execution-secret-"));
    const tokenFile = join(directory, "task-center.secret");
    try {
      writeFileSync(tokenFile, "m".repeat(64), { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
      const expected = "0ecc68db70cad88ff066009cf3a1af6b8abfdf0dff4f2cb59c72e8e557e44c4a";
      expect(deriveExecutionRuntimeToken({ FLOWOS_TASK_CENTER_JWT_SECRET: "m".repeat(64) })).toBe(
        expected,
      );
      expect(deriveExecutionRuntimeToken({ FLOWOS_TASK_CENTER_JWT_SECRET_FILE: tokenFile })).toBe(
        expected,
      );
      expect(
        deriveImageGenerationRuntimeToken({ FLOWOS_TASK_CENTER_JWT_SECRET_FILE: tokenFile }),
      ).not.toBe(expected);
      expect(existsSync(tokenFile)).toBe(true);
      chmodSync(tokenFile, 0o644);
      expect(
        deriveExecutionRuntimeToken({ FLOWOS_TASK_CENTER_JWT_SECRET_FILE: tokenFile }),
      ).toBeNull();
      expect(deriveExecutionRuntimeToken({ LONG_TASK_EXECUTION_TOKEN: "x".repeat(64) })).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects registration without the standard tenant identity secret", () => {
    delete process.env.FLOWOS_TASK_CENTER_JWT_SECRET;
    delete process.env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE;
    expect(() =>
      plugin.register({
        runtime: {
          state: { openKeyedStore: () => memoryStore() },
          subagent: fakeSubagent(),
          system: fakeSystem(),
        },
        registerTool: vi.fn(),
        on: vi.fn(),
        logger: { warn: vi.fn(), info: vi.fn() },
      } as never),
    ).toThrow("standard tenant identity config is required");
  });

  it("registers all tools from standard tenant identity without execution-specific config", () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "m".repeat(64);
    process.env.ASSIST_API_BASE = "http://assist:18790";
    const registerTool = vi.fn();
    const on = vi.fn();
    plugin.register({
      runtime: {
        state: { openKeyedStore: () => memoryStore() },
        subagent: fakeSubagent(),
        system: fakeSystem(),
      },
      registerTool,
      on,
      logger: { warn: vi.fn(), info: vi.fn() },
    } as never);
    const factory = registerTool.mock.calls[0]?.[0] as (context: unknown) => unknown;
    const registered = factory({
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/workspace",
    });
    expect(registered).toHaveLength(6);
    expect(on.mock.calls.map((call) => call[0])).toEqual(["subagent_ended", "gateway_start"]);
  });

  it("tool schemas never expose owner identity endpoint or credential arguments", () => {
    const { byName } = tools();
    expect([...byName.keys()]).toEqual([
      "flowos_execution_start",
      "flowos_execution_stage",
      "flowos_execution_spawn",
      "flowos_execution_complete",
      "flowos_execution_fail",
    ]);
    for (const tool of byName.values()) {
      const schema = JSON.stringify(tool.parameters);
      expect(schema).not.toContain("token");
      expect(schema).not.toContain("ownerAgentId");
      expect(schema).not.toContain("assistBaseUrl");
      expect(schema).not.toContain("userId");
      expect(schema).not.toContain("tenantId");
    }
  });

  it("start derives owner and requester then replays without cross-session adoption", async () => {
    const store = new RunBindingStore(memoryStore());
    const owner = tools({ bindings: store });
    await startExecution(owner.byName);
    const binding = await store.byExecution("execution-1", "attempt-1");
    expect(binding).toMatchObject({
      ownerAgentId: "agent:main",
      requesterSessionKey: "agent:main:main",
      status: "CREATED",
    });

    const other = tools({
      bindings: store,
      context: { agentId: "main", sessionKey: "agent:main:other" },
    });
    await expect(startExecution(other.byName)).rejects.toThrow("another owner session");
  });

  it("scopes Assist idempotency to the trusted requester session when local state is empty", async () => {
    const assist = fakeClient();
    const first = tools({
      client: assist.client,
      context: { agentId: "main", sessionKey: "agent:main:first" },
    });
    const second = tools({
      client: assist.client,
      context: { agentId: "main", sessionKey: "agent:main:second" },
    });
    await startExecution(first.byName);
    await startExecution(second.byName);
    const keys = assist.calls
      .filter((call) => call.path === "/api/executions")
      .map((call) => call.payload?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("derives Space task identity and trusted AI surface outside the model schema", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startSpaceExecution(owner.byName);
    const create = assist.calls.find((call) => call.path === "/api/executions");
    expect(create?.payload).toMatchObject({
      source: "SPACE_TASK",
      spaceId: "sp-trip",
      surfaceKind: "AI_TASK",
    });
    expect(create?.payload?.taskId).toMatch(/^task-flowos-[a-f0-9]{24}$/);
    const schema = JSON.stringify(owner.byName.get("flowos_execution_start")?.parameters);
    expect(schema).not.toContain("taskId");
    expect(schema).not.toContain("surfaceKind");
  });

  it("persists one canonical active binding without expiring aliases", async () => {
    const state = memoryStore<RunBinding>();
    const bindings = new RunBindingStore(state);
    await bindings.save({
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:main",
      ownerAgentId: "agent:main",
      targetAgentId: "worker",
      childSessionKey: "agent:worker:subagent:flowos-1",
      runId: "run-1",
      status: "RUNNING",
      createdAt: 1,
      updatedAt: 1,
    });
    const entries = await state.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("execution:execution-1:attempt-1");
    expect(entries[0]?.expiresAt).toBeUndefined();
    expect(await bindings.byChild("agent:worker:subagent:flowos-1")).toMatchObject({
      runId: "run-1",
    });
  });

  it("child can only stage its own running Execution Attempt", async () => {
    const assist = fakeClient();
    const store = new RunBindingStore(memoryStore());
    const binding: RunBinding = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:flowos-requester",
      ownerAgentId: "agent:main",
      targetAgentId: "main",
      childSessionKey: "agent:main:subagent:flowos-1",
      runId: "run-1",
      status: "RUNNING",
      createdAt: 1,
      updatedAt: 1,
    };
    await store.save(binding);
    const child = tools({
      bindings: store,
      client: assist.client,
      context: { agentId: "main", sessionKey: binding.childSessionKey },
    });
    await child.byName.get("flowos_execution_stage")?.execute("stage", {
      executionId: "execution-1",
      expectedVersion: 1,
      stageKey: "generating",
      stageLabel: "正在生成",
    });
    expect(assist.getItem()).toMatchObject({ status: "RUNNING", version: 2 });
    await expect(
      child.byName.get("flowos_execution_stage")?.execute("cross", {
        executionId: "execution-other",
        expectedVersion: 2,
        stageKey: "bad",
        stageLabel: "bad",
      }),
    ).rejects.toThrow("does not match");
    await expect(
      child.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
        cardCaption: "路书做好啦，点开看看～",
      }),
    ).rejects.toThrow("owner tool is unavailable");
  });

  it("spawn is stable and writes pending binding before the plugin subagent run", async () => {
    const store = new RunBindingStore(memoryStore());
    const subagent = fakeSubagent();
    subagent.run.mockImplementation(async (params) => {
      const pending = await store.byChild(params.sessionKey);
      expect(pending?.status).toBe("STARTING");
      return { runId: "run-1" };
    });
    const owner = tools({ bindings: store, subagent });
    await startExecution(owner.byName);
    await owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    });
    const running = await store.byExecution("execution-1", "attempt-1");
    expect(running).toMatchObject({ runId: "run-1", status: "RUNNING" });
    expect(subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: false,
        message: expect.stringContaining("expectedVersion=1"),
      }),
    );
    await owner.byName.get("flowos_execution_spawn")?.execute("spawn-replay", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    });
    expect(subagent.run).toHaveBeenCalledOnce();
    const schema = JSON.stringify(owner.byName.get("flowos_execution_spawn")?.parameters);
    expect(schema).not.toContain("idempotencyKey");
  });

  it("normalizes a prefixed target Agent before binding child progress", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startExecution(owner.byName);
    await owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "agent:main",
      task: "generate result",
    });
    const binding = await owner.bindings.byExecution("execution-1", "attempt-1");
    expect(binding).toMatchObject({
      targetAgentId: "main",
      childSessionKey: expect.stringMatching(/^agent:main:subagent:/),
      status: "RUNNING",
    });

    const child = tools({
      bindings: owner.bindings,
      client: assist.client,
      context: { agentId: "main", sessionKey: binding!.childSessionKey },
    });
    await child.byName.get("flowos_execution_stage")?.execute("child-stage", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      expectedVersion: 1,
      stageKey: "collecting",
      stageLabel: "正在收集素材",
    });
    expect(assist.getItem()).toMatchObject({ status: "RUNNING", version: 2 });
  });

  it("persists a trusted result plan atomically and rejects replay drift", async () => {
    const owner = tools({
      context: {
        agentId: "main",
        sessionKey: "agent:main:main",
        workspaceDir: "/trusted/workspace",
      },
    });
    await startRoutebookExecution(owner.byName);
    await spawnRoutebook(owner);
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "RUNNING",
      finalizationPlan: {
        ...routebookResultPlan,
        workspaceDir: "/trusted/workspace",
      },
    });
    await spawnRoutebook(owner);
    expect(owner.subagent.run).toHaveBeenCalledOnce();
    await expect(
      owner.byName.get("flowos_execution_spawn")?.execute("spawn-drift", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        agentId: "worker",
        task: "generate a routebook",
        resultPlan: { ...routebookResultPlan, artifactFilePath: "generated/other.html" },
      }),
    ).rejects.toThrow("result plan does not match");
    const schema = JSON.stringify(owner.byName.get("flowos_execution_spawn")?.parameters);
    expect(schema).toContain("resultPlan");
    expect(schema).not.toContain("workspaceDir");
  });

  it("fails fast instead of silently falling back when a routebook omits resultPlan", async () => {
    const owner = tools();
    await startRoutebookExecution(owner.byName);
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      taskKind: "ROUTEBOOK_GENERATION",
    });
    await expect(
      owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        agentId: "worker",
        task: "generate a routebook",
      }),
    ).rejects.toThrow("ROUTEBOOK_GENERATION spawn requires resultPlan");
    expect(owner.subagent.run).not.toHaveBeenCalled();
    const binding = await owner.bindings.byExecution("execution-1", "attempt-1");
    expect(binding).toMatchObject({ status: "CREATED" });
    expect(binding?.targetAgentId).toBeUndefined();
  });

  it("rejects result plans for task kinds that have no registered finalizer", async () => {
    const owner = tools();
    await startSpaceExecution(owner.byName);
    await expect(spawnRoutebook(owner)).rejects.toThrow(
      "result plan is only available to ROUTEBOOK_GENERATION",
    );
    expect(owner.subagent.run).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "CREATED",
      taskKind: "lushu",
    });
  });

  it("rejects a routebook plan that selects the Markdown validator", async () => {
    const owner = tools();
    await startRoutebookExecution(owner.byName);
    await expect(
      spawnRoutebook(owner, {
        ...routebookResultPlan,
        artifactFilePath: "generated/routebook.md",
        artifactType: "markdown",
      }),
    ).rejects.toThrow("ROUTEBOOK_GENERATION result plan requires an HTML Artifact");
    expect(owner.subagent.run).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "CREATED",
      taskKind: "ROUTEBOOK_GENERATION",
    });
  });

  it("finalizes a planned routebook without waking the requester model", async () => {
    const unicodeSpaceId = "sp_烟台看海_483cfc";
    const unicodeResultPlan = { ...routebookResultPlan, spaceId: unicodeSpaceId };
    const assist = fakeClient();
    const deliverResultCard = vi.fn<ResultCardDelivery>();
    const owner = tools({ client: assist.client, deliverResultCard });
    await startRoutebookExecution(owner.byName, unicodeSpaceId);
    await spawnRoutebook(owner, unicodeResultPlan);
    const binding = await owner.bindings.byExecution("execution-1", "attempt-1");
    await owner.runtime.subagentEnded(
      {
        targetSessionKey: binding!.childSessionKey!,
        targetKind: "subagent",
        runId: binding!.runId,
        outcome: "ok",
      },
      {
        childSessionKey: binding!.childSessionKey,
        requesterSessionKey: binding!.requesterSessionKey,
      },
    );

    expect(owner.validateArtifact).toHaveBeenCalledWith({
      spaceId: unicodeSpaceId,
      filePath: routebookResultPlan.artifactFilePath,
      artifactType: "html",
    });
    expect(assist.calls.filter((call) => call.path.endsWith("/space-artifacts"))).toHaveLength(1);
    expect(assist.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
    expect(assist.getItem()).toMatchObject({ status: "SUCCEEDED", version: 3 });
    expect(deliverResultCard).toHaveBeenCalledOnce();
    expect(owner.system.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(owner.system.requestHeartbeat).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "ENDED_OK",
      resultDelivery: { status: "DELIVERED" },
    });
  });

  it("fails a planned routebook validation without Artifact, card, or model wake", async () => {
    const assist = fakeClient();
    const validateArtifact = vi.fn<ArtifactValidator>(async () => {
      throw new Error("validator rejected the routebook");
    });
    const deliverResultCard = vi.fn<ResultCardDelivery>();
    const owner = tools({ client: assist.client, validateArtifact, deliverResultCard });
    await startRoutebookExecution(owner.byName);
    await spawnRoutebook(owner);
    const binding = await owner.bindings.byExecution("execution-1", "attempt-1");
    await owner.runtime.subagentEnded(
      {
        targetSessionKey: binding!.childSessionKey!,
        targetKind: "subagent",
        runId: binding!.runId,
        outcome: "ok",
      },
      { childSessionKey: binding!.childSessionKey },
    );

    expect(assist.calls.find((call) => call.path.endsWith("/fail"))?.payload).toMatchObject({
      errorCode: "VALIDATION_FAILED",
      retryable: false,
    });
    expect(assist.calls.some((call) => call.path.endsWith("/space-artifacts"))).toBe(false);
    expect(deliverResultCard).not.toHaveBeenCalled();
    expect(owner.system.requestHeartbeat).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "ENDED_ERROR",
      outcome: "planned_validation_failed",
    });
  });

  it("recovers a lost planned validation failure response after Gateway restart", async () => {
    let loseFailureResponse = true;
    const assist = fakeClient({
      afterRequest(_method, path) {
        if (loseFailureResponse && path.endsWith("/fail")) {
          loseFailureResponse = false;
          throw new Error("validation failure response lost");
        }
      },
    });
    const validateArtifact = vi.fn<ArtifactValidator>(async () => {
      throw new Error("validator rejected the routebook");
    });
    const owner = tools({ client: assist.client, validateArtifact });
    await startRoutebookExecution(owner.byName);
    await spawnRoutebook(owner);
    const binding = await owner.bindings.byExecution("execution-1", "attempt-1");
    await owner.runtime.subagentEnded(
      {
        targetSessionKey: binding!.childSessionKey!,
        targetKind: "subagent",
        runId: binding!.runId,
        outcome: "ok",
      },
      { childSessionKey: binding!.childSessionKey },
    );
    expect(assist.getItem()).toMatchObject({ status: "FAILED", version: 3 });
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "ENDED_OK",
      finalizationFailure: { errorCode: "VALIDATION_FAILED" },
    });

    const restarted = new FlowosExecutionRuntime(
      assist.client,
      owner.bindings,
      owner.subagent,
      owner.system,
      owner.deliverResultCard,
      { warn: vi.fn(), info: vi.fn() },
      owner.locks,
      () => validateArtifact(routebookResultPlan),
    );
    await restarted.reconcile();
    expect(assist.calls.filter((call) => call.path.endsWith("/fail"))).toHaveLength(1);
    expect(owner.system.requestHeartbeat).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "ENDED_ERROR",
      outcome: "planned_validation_failed",
    });
  });

  it("reconciles a transient planned Artifact registration failure after Gateway restart", async () => {
    let registrationAttempts = 0;
    const assist = fakeClient({
      beforeRequest(_method, path) {
        if (path.endsWith("/space-artifacts") && registrationAttempts++ === 0) {
          throw new Error("Assist Artifact registration unavailable");
        }
      },
    });
    const deliverResultCard = vi.fn<ResultCardDelivery>();
    const owner = tools({ client: assist.client, deliverResultCard });
    await startRoutebookExecution(owner.byName);
    await spawnRoutebook(owner);
    const binding = await owner.bindings.byExecution("execution-1", "attempt-1");
    await owner.runtime.subagentEnded(
      {
        targetSessionKey: binding!.childSessionKey!,
        targetKind: "subagent",
        runId: binding!.runId,
        outcome: "ok",
      },
      { childSessionKey: binding!.childSessionKey },
    );
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "ENDED_OK",
      closureWakeCount: 1,
    });

    const restarted = new FlowosExecutionRuntime(
      assist.client,
      owner.bindings,
      owner.subagent,
      owner.system,
      deliverResultCard,
      { warn: vi.fn(), info: vi.fn() },
      owner.locks,
      (plan) =>
        owner.validateArtifact({
          spaceId: plan.spaceId,
          filePath: plan.artifactFilePath,
          artifactType: plan.artifactType,
        }),
    );
    await restarted.reconcile();
    await restarted.reconcile();
    expect(registrationAttempts).toBe(2);
    expect(assist.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
    expect(deliverResultCard).toHaveBeenCalledOnce();
    expect(owner.system.requestHeartbeat).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      resultDelivery: { status: "DELIVERED" },
    });
  });

  it("keeps planned finalization exclusive while Artifact registration is retrying", async () => {
    const assist = fakeClient({
      beforeRequest(_method, path) {
        if (path.endsWith("/space-artifacts")) {
          throw new Error("Assist Artifact registration unavailable");
        }
      },
    });
    const owner = tools({ client: assist.client });
    await startRoutebookExecution(owner.byName);
    await spawnRoutebook(owner);
    const binding = await owner.bindings.byExecution("execution-1", "attempt-1");
    await owner.runtime.subagentEnded(
      {
        targetSessionKey: binding!.childSessionKey!,
        targetKind: "subagent",
        runId: binding!.runId,
        outcome: "ok",
      },
      { childSessionKey: binding!.childSessionKey },
    );

    await expect(
      owner.byName.get("flowos_execution_stage")?.execute("owner-stage", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        stageKey: "other",
        stageLabel: "其他阶段",
      }),
    ).rejects.toThrow("owner stage is unavailable after result plan acceptance");
    await expect(
      owner.byName.get("flowos_execution_complete")?.execute("owner-complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        spaceId: "sp-trip",
        artifactTitle: "另一个结果",
        artifactFilePath: "generated/other.html",
        artifactType: "html",
        cardCaption: "另一个结果",
      }),
    ).rejects.toThrow("owner completion is unavailable after result plan acceptance");
    await expect(
      owner.byName.get("flowos_execution_fail")?.execute("owner-fail", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        errorCode: "INTERNAL",
      }),
    ).rejects.toThrow("owner failure is unavailable after result plan acceptance");
    expect(assist.getItem()).toMatchObject({
      status: "RUNNING",
      stageKey: "validating",
      version: 2,
    });
    expect(assist.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(0);
    expect(assist.calls.filter((call) => call.path.endsWith("/fail"))).toHaveLength(0);
  });

  it("keeps an accepted multi-minute child active past the owner spawn guard", async () => {
    vi.useFakeTimers();
    try {
      const assist = fakeClient();
      const owner = tools({ client: assist.client });
      await startExecution(owner.byName);
      await owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        agentId: "worker",
        task: "generate a routebook for several minutes",
      });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
        status: "RUNNING",
      });
      expect(assist.calls.some((call) => call.path.endsWith("/fail"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent spawn calls into one atomic run claim", async () => {
    const store = new RunBindingStore(memoryStore());
    const subagent = fakeSubagent();
    let releaseRun = () => {};
    let markEntered = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    subagent.run.mockImplementation(async (params) => {
      markEntered();
      await gate;
      return { runId: params.idempotencyKey! };
    });
    const owner = tools({ bindings: store, subagent });
    await startExecution(owner.byName);
    const input = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    };
    const first = owner.byName.get("flowos_execution_spawn")!.execute("spawn-1", input);
    await entered;
    const second = owner.byName
      .get("flowos_execution_spawn")!
      .execute("spawn-2", { ...input, task: "different model text" });
    releaseRun();
    await Promise.all([first, second]);
    expect(subagent.run).toHaveBeenCalledOnce();
    expect(await store.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "RUNNING",
      targetAgentId: "worker",
    });
  });

  it("rejects completion while a bound child is still active", async () => {
    const owner = tools();
    await startExecution(owner.byName);
    await owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      agentId: "worker",
      task: "generate result",
    });
    await expect(
      owner.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 1,
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
        cardCaption: "路书做好啦，点开看看～",
      }),
    ).rejects.toThrow("has not ended successfully");
  });

  it("rejects completion without an accepted child even when a file is claimed", async () => {
    const owner = tools();
    await startSpaceExecution(owner.byName);
    await expect(
      owner.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 1,
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
        cardCaption: "路书做好啦，点开看看～",
      }),
    ).rejects.toThrow("has not ended successfully");
    expect(owner.validateArtifact).not.toHaveBeenCalled();
  });

  it("rejects stale and future writer versions without changing state", async () => {
    const assist = fakeClient();
    const owner = tools({ client: assist.client });
    await startExecution(owner.byName);
    await assist.client.stage("execution-1", {
      expectedVersion: 1,
      stageKey: "runtime-stage",
      stageLabel: "运行时已推进",
    });
    await expect(
      owner.byName.get("flowos_execution_stage")?.execute("stale", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 1,
        stageKey: "stale",
        stageLabel: "错误旧阶段",
      }),
    ).rejects.toThrow("does not match");
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "runtime-stage" });

    await expect(
      owner.byName.get("flowos_execution_stage")?.execute("future", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 99,
        stageKey: "future",
        stageLabel: "错误未来版本",
      }),
    ).rejects.toThrow("does not match");
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "runtime-stage" });
  });

  it("complete registers the bound Space Artifact before completing the owner Execution", async () => {
    const events: string[] = [];
    const assist = fakeClient({
      beforeRequest(_method, path) {
        events.push(path);
      },
    });
    const deliverResultCard = vi.fn<ResultCardDelivery>(async () => {
      events.push("result-card");
    });
    const owner = tools({ client: assist.client, deliverResultCard });
    await startSpaceExecution(owner.byName);
    await markChildEndedOk(owner);
    await assist.client.stage("execution-1", {
      expectedVersion: 1,
      stageKey: "validating",
      stageLabel: "正在验证结果",
    });
    await owner.byName.get("flowos_execution_complete")?.execute("complete", {
      executionId: "execution-1",
      attemptId: "attempt-1",
      expectedVersion: 2,
      spaceId: "sp-trip",
      artifactTitle: "旅行路书",
      artifactFilePath: "generated/lushu.html",
      artifactType: "html",
      cardCaption: "路书做好啦，点开看看～",
    });
    const paths = assist.calls.map((call) => call.path);
    expect(paths.indexOf("/api/executions/execution-1/space-artifacts")).toBeLessThan(
      paths.indexOf("/api/executions/execution-1/complete"),
    );
    expect(events.indexOf("/api/executions/execution-1/space-artifacts")).toBeLessThan(
      events.indexOf("result-card"),
    );
    expect(events.indexOf("/api/executions/execution-1/complete")).toBeLessThan(
      events.indexOf("result-card"),
    );
    expect(owner.validateArtifact).toHaveBeenCalledOnce();
    const registration = assist.calls.find((call) => call.path.endsWith("/space-artifacts"));
    expect(registration?.payload).toMatchObject({
      validatorId: "lushu-html-v1",
      contentSha256: "a".repeat(64),
    });
    expect(owner.deliverResultCard).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      executionId: "execution-1",
      attemptId: "attempt-1",
      spaceId: "sp-trip",
      artifactTitle: "旅行路书",
      artifactFilePath: "generated/lushu.html",
      caption: "路书做好啦，点开看看～",
    });
    const schema = JSON.stringify(owner.byName.get("flowos_execution_complete")?.parameters);
    expect(schema).toContain("cardCaption");
    expect(schema).not.toContain("resultId");
    expect(schema).not.toContain("RESOURCE");
    expect(schema).not.toContain("CASE_DETAIL");
  });

  it("retries durable result-card delivery after Execution succeeds without repeating complete", async () => {
    vi.useFakeTimers();
    try {
      const assist = fakeClient();
      const deliverResultCard = vi
        .fn<ResultCardDelivery>()
        .mockRejectedValueOnce(new Error("transcript unavailable"))
        .mockResolvedValue(undefined);
      const owner = tools({ client: assist.client, deliverResultCard });
      await startSpaceExecution(owner.byName);
      await markChildEndedOk(owner);
      await assist.client.stage("execution-1", {
        expectedVersion: 1,
        stageKey: "validating",
        stageLabel: "正在验证结果",
      });
      await expect(
        owner.byName.get("flowos_execution_complete")?.execute("complete-1", {
          executionId: "execution-1",
          attemptId: "attempt-1",
          expectedVersion: 2,
          spaceId: "sp-trip",
          artifactTitle: "旅行路书",
          artifactFilePath: "generated/lushu.html",
          artifactType: "html",
          cardCaption: "路书做好啦，点开看看～",
        }),
      ).rejects.toThrow("transcript unavailable");
      expect(assist.getItem()).toMatchObject({ status: "SUCCEEDED", version: 3 });
      expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
        resultDelivery: { status: "EXECUTION_COMPLETED" },
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(deliverResultCard).toHaveBeenCalledTimes(2);
      expect(assist.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
      expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
        resultDelivery: { status: "DELIVERED" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("freezes owner stage and fails the same Attempt after prepared version drift", async () => {
    let loseFailResponse = true;
    const assist = fakeClient({
      beforeRequest(_method, path) {
        if (path.endsWith("/complete")) {
          throw new Error("Assist complete unavailable");
        }
      },
      afterRequest(_method, path) {
        if (loseFailResponse && path.endsWith("/fail")) {
          loseFailResponse = false;
          throw new Error("fail response lost");
        }
      },
    });
    const deliverResultCard = vi.fn<ResultCardDelivery>();
    const owner = tools({ client: assist.client, deliverResultCard });
    await startSpaceExecution(owner.byName);
    await markChildEndedOk(owner);
    await assist.client.stage("execution-1", {
      expectedVersion: 1,
      stageKey: "validating",
      stageLabel: "正在验证结果",
    });
    await expect(
      owner.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
        cardCaption: "路书做好啦，点开看看～",
      }),
    ).rejects.toThrow("Assist complete unavailable");
    expect(assist.getItem()).toMatchObject({ status: "RUNNING", stageKey: "validating" });
    expect(deliverResultCard).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      resultDelivery: { status: "PREPARED" },
    });
    await expect(
      owner.byName.get("flowos_execution_stage")?.execute("late-owner-stage", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        stageKey: "late",
        stageLabel: "迟到阶段",
      }),
    ).rejects.toThrow("stage is frozen after result preparation");
    await assist.client.stage("execution-1", {
      expectedVersion: 2,
      stageKey: "external-drift",
      stageLabel: "外部版本漂移",
    });
    await owner.runtime.reconcile();
    expect(assist.getItem()).toMatchObject({ status: "FAILED", version: 4 });
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      resultDelivery: { status: "PREPARED" },
    });
    await owner.runtime.reconcile();
    expect(deliverResultCard).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "ENDED_ERROR",
      outcome: "result_delivery_aborted",
      resultDelivery: { status: "ABORTED" },
    });
  });

  it("aborts only the old delivery when Assist switches to a new Attempt", async () => {
    const assist = fakeClient({
      beforeRequest(_method, path) {
        if (path.endsWith("/complete")) {
          throw new Error("Assist complete unavailable");
        }
      },
    });
    const deliverResultCard = vi.fn<ResultCardDelivery>();
    const owner = tools({ client: assist.client, deliverResultCard });
    await startSpaceExecution(owner.byName);
    await markChildEndedOk(owner);
    await assist.client.stage("execution-1", {
      expectedVersion: 1,
      stageKey: "validating",
      stageLabel: "正在验证结果",
    });
    await expect(
      owner.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
        cardCaption: "路书做好啦，点开看看～",
      }),
    ).rejects.toThrow("Assist complete unavailable");
    assist.setItem({
      currentAttemptId: "attempt-2",
      status: "RUNNING",
      version: 3,
      stageKey: "retrying",
    });

    await owner.runtime.reconcile();
    expect(assist.getItem()).toMatchObject({
      currentAttemptId: "attempt-2",
      status: "RUNNING",
      version: 3,
    });
    expect(assist.calls.filter((call) => call.path.endsWith("/fail"))).toHaveLength(0);
    expect(deliverResultCard).not.toHaveBeenCalled();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "ENDED_ERROR",
      outcome: "result_attempt_replaced",
      resultDelivery: { status: "ABORTED" },
    });
  });

  it("recovers a lost complete response after Gateway restart and delivers one card", async () => {
    let loseResponse = true;
    const assist = fakeClient({
      afterRequest(_method, path) {
        if (loseResponse && path.endsWith("/complete")) {
          loseResponse = false;
          throw new Error("complete response lost");
        }
      },
    });
    const deliverResultCard = vi.fn<ResultCardDelivery>();
    const owner = tools({ client: assist.client, deliverResultCard });
    await startSpaceExecution(owner.byName);
    await markChildEndedOk(owner);
    await assist.client.stage("execution-1", {
      expectedVersion: 1,
      stageKey: "validating",
      stageLabel: "正在验证结果",
    });
    await expect(
      owner.byName.get("flowos_execution_complete")?.execute("complete", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        expectedVersion: 2,
        spaceId: "sp-trip",
        artifactTitle: "旅行路书",
        artifactFilePath: "generated/lushu.html",
        artifactType: "html",
        cardCaption: "路书做好啦，点开看看～",
      }),
    ).rejects.toThrow("complete response lost");
    expect(assist.getItem()).toMatchObject({ status: "SUCCEEDED", version: 3 });
    expect(deliverResultCard).not.toHaveBeenCalled();

    const restarted = new FlowosExecutionRuntime(
      assist.client,
      owner.bindings,
      owner.subagent,
      owner.system,
      deliverResultCard,
      { warn: vi.fn(), info: vi.fn() },
      owner.locks,
    );
    await restarted.reconcile();
    expect(deliverResultCard).toHaveBeenCalledOnce();
    expect(assist.calls.filter((call) => call.path.endsWith("/complete"))).toHaveLength(1);
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      resultDelivery: { status: "DELIVERED" },
    });
  });
});

describe("FlowOS Execution typed hooks", () => {
  function runtime() {
    const assist = fakeClient();
    const bindings = new RunBindingStore(memoryStore());
    const subagent = fakeSubagent();
    const system = fakeSystem();
    const logger = { warn: vi.fn(), info: vi.fn() };
    return {
      assist,
      bindings,
      subagent,
      system,
      instance: new FlowosExecutionRuntime(
        assist.client,
        bindings,
        subagent as never,
        system as never,
        vi.fn<ResultCardDelivery>(),
        logger,
        new ExecutionLocks(),
      ),
    };
  }

  async function pending(bindings: RunBindingStore): Promise<RunBinding> {
    const value: RunBinding = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:main",
      ownerAgentId: "agent:main",
      targetAgentId: "worker",
      childSessionKey: "agent:worker:subagent:flowos-1",
      status: "STARTING",
      createdAt: 1,
      updatedAt: 1,
    };
    await bindings.save(value);
    return value;
  }

  it("ok end moves to validating but never completes and replay is harmless", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    const event = {
      targetSessionKey: value.childSessionKey!,
      targetKind: "subagent" as const,
      runId: "run-1",
      outcome: "ok" as const,
    };
    const hookContext = {
      childSessionKey: value.childSessionKey,
      requesterSessionKey: "agent:main:main",
    };
    await ctx.instance.subagentEnded(event, hookContext);
    await ctx.instance.subagentEnded(event, hookContext);
    expect(ctx.assist.getItem()).toMatchObject({ status: "RUNNING", stageKey: "validating" });
    expect(ctx.assist.calls.filter((call) => call.path.endsWith("/stage"))).toHaveLength(1);
    expect(ctx.assist.calls.some((call) => call.path.endsWith("/complete"))).toBe(false);
    expect(ctx.system.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(ctx.system.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("version=2"),
      expect.objectContaining({ sessionKey: value.requesterSessionKey }),
    );
    expect(ctx.system.requestHeartbeat).toHaveBeenCalledOnce();
    expect(ctx.system.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "background-task",
        intent: "immediate",
        reason: "background-task",
        sessionKey: value.requesterSessionKey,
      }),
    );
  });

  it("fails an owner Execution when spawn does not follow start", async () => {
    vi.useFakeTimers();
    try {
      const ctx = runtime();
      const binding: RunBinding = {
        executionId: "execution-1",
        attemptId: "attempt-1",
        requesterSessionKey: "agent:main:main",
        ownerAgentId: "agent:main",
        status: "CREATED",
        createdAt: 1,
        updatedAt: 1,
      };
      await ctx.bindings.save(binding);
      ctx.instance.watchOwnerSpawn(binding);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ctx.assist.getItem()).toMatchObject({ status: "FAILED", version: 2 });
      expect(await ctx.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
        status: "SPAWN_FAILED",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-wakes an unfinished successful child then fails instead of remaining active", async () => {
    vi.useFakeTimers();
    try {
      const ctx = runtime();
      const value = await pending(ctx.bindings);
      await ctx.bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
      await ctx.instance.subagentEnded(
        {
          targetSessionKey: value.childSessionKey!,
          targetKind: "subagent",
          runId: "run-1",
          outcome: "ok",
        },
        { childSessionKey: value.childSessionKey, requesterSessionKey: value.requesterSessionKey },
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ctx.system.requestHeartbeat).toHaveBeenCalledTimes(3);
      expect(await ctx.bindings.byExecution(value.executionId, value.attemptId)).toMatchObject({
        status: "ENDED_OK",
        closureWakeCount: 2,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(ctx.assist.getItem()).toMatchObject({ status: "FAILED", version: 3 });
      expect(await ctx.bindings.byExecution(value.executionId, value.attemptId)).toMatchObject({
        status: "ENDED_ERROR",
        outcome: "owner_closure_failed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes an ended hook ahead of a late child stage", async () => {
    let releaseValidation = () => {};
    let markValidationEntered = () => {};
    const validationEntered = new Promise<void>((resolve) => {
      markValidationEntered = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const assist = fakeClient({
      async beforeRequest(_method, path, payload) {
        if (path.endsWith("/stage") && payload?.stageKey === "validating") {
          markValidationEntered();
          await validationGate;
        }
      },
    });
    const owner = tools({ client: assist.client });
    const binding: RunBinding = {
      executionId: "execution-1",
      attemptId: "attempt-1",
      requesterSessionKey: "agent:main:owner",
      ownerAgentId: "agent:main",
      targetAgentId: "main",
      childSessionKey: "agent:main:subagent:flowos-1",
      runId: "run-1",
      status: "RUNNING",
      createdAt: 1,
      updatedAt: 1,
    };
    await owner.bindings.save(binding);
    const child = tools({
      client: assist.client,
      bindings: owner.bindings,
      subagent: owner.subagent,
      locks: owner.locks,
      runtime: owner.runtime,
      context: { agentId: "main", sessionKey: binding.childSessionKey },
    });
    const ended = owner.runtime.subagentEnded(
      {
        targetSessionKey: binding.childSessionKey!,
        targetKind: "subagent",
        runId: "run-1",
        outcome: "ok",
      },
      { childSessionKey: binding.childSessionKey, requesterSessionKey: "agent:main:main" },
    );
    await validationEntered;
    const lateStage = child.byName.get("flowos_execution_stage")!.execute("late-stage", {
      executionId: "execution-1",
      expectedVersion: 1,
      stageKey: "late",
      stageLabel: "迟到阶段",
    });
    releaseValidation();
    await ended;
    await expect(lateStage).rejects.toThrow("capability is unavailable");
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "validating" });
  });

  it("replays terminal sync without incrementing version after a local checkpoint failure", async () => {
    const base = memoryStore<RunBinding>();
    let registerCount = 0;
    const flakyStore: PluginStateKeyedStore<RunBinding> = {
      ...base,
      async register(key, value, opts) {
        registerCount += 1;
        if (registerCount === 4) {
          throw new Error("checkpoint unavailable");
        }
        await base.register(key, value, opts);
      },
    };
    const assist = fakeClient();
    const bindings = new RunBindingStore(flakyStore);
    const subagent = fakeSubagent();
    const system = fakeSystem();
    const executionRuntime = new FlowosExecutionRuntime(
      assist.client,
      bindings,
      subagent as never,
      system as never,
      vi.fn<ResultCardDelivery>(),
      { warn: vi.fn(), info: vi.fn() },
      new ExecutionLocks(),
    );
    const value = await pending(bindings);
    await bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    const event = {
      targetSessionKey: value.childSessionKey!,
      targetKind: "subagent" as const,
      runId: "run-1",
      outcome: "ok" as const,
    };
    const hookContext = {
      childSessionKey: value.childSessionKey,
      requesterSessionKey: value.requesterSessionKey,
    };
    await executionRuntime.subagentEnded(event, hookContext);
    expect(await bindings.byRun("run-1")).toMatchObject({ status: "ENDED_OK_PENDING_SYNC" });
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "validating" });
    await executionRuntime.reconcile();
    expect(await bindings.byRun("run-1")).toMatchObject({ status: "ENDED_OK" });
    expect(assist.getItem()).toMatchObject({ version: 2, stageKey: "validating" });
    expect(assist.calls.filter((call) => call.path.endsWith("/stage"))).toHaveLength(1);
    expect(system.enqueueSystemEvent).toHaveBeenCalledOnce();
    expect(system.requestHeartbeat).toHaveBeenCalledOnce();
  });

  it("reconciles a deferred spawn failure to a terminal Execution", async () => {
    let failUnavailable = true;
    const assist = fakeClient({
      beforeRequest(_method, path) {
        if (failUnavailable && path.endsWith("/fail")) {
          throw new Error("Assist unavailable");
        }
      },
    });
    const subagent = fakeSubagent();
    subagent.run.mockRejectedValue(new Error("spawn rejected"));
    const owner = tools({ client: assist.client, subagent });
    await startExecution(owner.byName);
    await expect(
      owner.byName.get("flowos_execution_spawn")?.execute("spawn", {
        executionId: "execution-1",
        attemptId: "attempt-1",
        agentId: "worker",
        task: "generate result",
      }),
    ).rejects.toThrow("spawn rejected");
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "SPAWN_FAILED_PENDING_SYNC",
    });
    failUnavailable = false;
    await owner.runtime.reconcile();
    expect(await owner.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
      status: "SPAWN_FAILED",
    });
    expect(assist.getItem()).toMatchObject({ status: "FAILED", version: 2 });
  });

  it("fails closed after restart when a spawn claim was never accepted", async () => {
    vi.useFakeTimers();
    try {
      const ctx = runtime();
      const value = await pending(ctx.bindings);
      await ctx.instance.reconcile();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await ctx.bindings.byExecution(value.executionId, value.attemptId)).toMatchObject({
        status: "SPAWN_FAILED",
      });
      expect(ctx.assist.getItem()).toMatchObject({ status: "FAILED", version: 2 });
      expect(ctx.subagent.getRunStatus).toHaveBeenCalledWith({
        runId: value.runId ?? "",
        sessionKey: value.childSessionKey,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed after restart when the owner never attempted spawn", async () => {
    vi.useFakeTimers();
    try {
      const ctx = runtime();
      await ctx.bindings.save({
        executionId: "execution-1",
        attemptId: "attempt-1",
        requesterSessionKey: "agent:main:main",
        ownerAgentId: "agent:main",
        status: "CREATED",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.instance.reconcile();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await ctx.bindings.byExecution("execution-1", "attempt-1")).toMatchObject({
        status: "SPAWN_FAILED",
      });
      expect(ctx.assist.getItem()).toMatchObject({ status: "FAILED", version: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a durably accepted child when RUNNING checkpoint was not saved", async () => {
    vi.useFakeTimers();
    try {
      const ctx = runtime();
      const value = await pending(ctx.bindings);
      await ctx.bindings.save({ ...value, runId: "run-1" });
      ctx.subagent.getRunStatus.mockResolvedValue({ status: "running" });
      await ctx.instance.reconcile();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await ctx.bindings.byExecution(value.executionId, value.attemptId)).toMatchObject({
        status: "RUNNING",
        runId: "run-1",
      });
      expect(ctx.assist.calls.some((call) => call.path.endsWith("/fail"))).toBe(false);
      expect(ctx.subagent.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout end maps to a retryable provider timeout failure", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    await ctx.instance.subagentEnded(
      {
        targetSessionKey: value.childSessionKey!,
        targetKind: "subagent",
        runId: "run-1",
        outcome: "timeout",
      },
      { childSessionKey: value.childSessionKey, requesterSessionKey: value.requesterSessionKey },
    );
    const failure = ctx.assist.calls.find((call) => call.path.endsWith("/fail"));
    expect(failure?.payload).toMatchObject({ errorCode: "PROVIDER_TIMEOUT", retryable: true });
  });

  it("gateway reconciliation closes a completed persisted run exactly once", async () => {
    const ctx = runtime();
    const value = await pending(ctx.bindings);
    await ctx.bindings.save({ ...value, runId: "run-1", status: "RUNNING" });
    ctx.subagent.waitForRun.mockResolvedValue({ status: "ok" });
    await ctx.instance.reconcile();
    await ctx.instance.reconcile();
    expect(ctx.assist.calls.filter((call) => call.path.endsWith("/stage"))).toHaveLength(1);
    expect(await ctx.bindings.byRun("run-1")).toMatchObject({ status: "ENDED_OK" });
  });
});
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
