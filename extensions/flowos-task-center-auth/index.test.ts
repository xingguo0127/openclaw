import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

const pairingMocks = vi.hoisted(() => ({
  request: vi.fn(),
  approve: vi.fn(),
  ensure: vi.fn(),
  get: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/device-bootstrap", () => ({
  requestDevicePairing: pairingMocks.request,
  approveDevicePairing: pairingMocks.approve,
  ensureDeviceToken: pairingMocks.ensure,
  getPairedDevice: pairingMocks.get,
}));
import plugin, {
  createProactiveConcernTool,
  requestProactiveConcern,
  resolveTrustedAssistEndpoint,
} from "./index.js";

const originalEnv = { ...process.env };
const tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

type StoredBinding = Record<string, unknown>;
type GatewayMethodRegistration = [
  string,
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1],
  Parameters<OpenClawPluginApi["registerGatewayMethod"]>[2],
];
type GatewayHandler = GatewayMethodRegistration[1];

async function invoke(
  handler: GatewayHandler,
  values: Pick<GatewayRequestHandlerOptions, "params" | "client" | "respond">,
): Promise<void> {
  await handler({
    req: {} as never,
    isWebchatConnect: () => false,
    context: {} as never,
    ...values,
  });
}

function writeDeviceSecret(secret = "d".repeat(48), mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowos-device-jwt-"));
  tempDirs.push(dir);
  const file = path.join(dir, "device-event-jwt.secret");
  fs.writeFileSync(file, secret, { mode });
  fs.chmodSync(file, mode);
  process.env.FLOWOS_DEVICE_EVENT_JWT_SECRET_FILE = file;
  return secret;
}

function writeTaskCenterSecret(secret = "s".repeat(32), mode = 0o600): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flowos-task-center-jwt-"));
  tempDirs.push(dir);
  const file = path.join(dir, "task-center-jwt.secret");
  fs.writeFileSync(file, secret, { mode });
  fs.chmodSync(file, mode);
  delete process.env.FLOWOS_TASK_CENTER_JWT_SECRET;
  process.env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE = file;
  return secret;
}

function setup(gatewayCredential?: string) {
  const records = new Map<string, StoredBinding>();
  const registerGatewayMethod = vi.fn();
  const registerTool = vi.fn();
  plugin.register({
    pluginConfig: { userId: "alice", tenantId: "tenant-a" },
    config: { gateway: { auth: { token: gatewayCredential } } },
    registerGatewayMethod,
    registerTool,
    runtime: {
      state: {
        openKeyedStore: () => ({
          register: async (key: string, value: StoredBinding) => {
            records.set(key, value);
          },
          lookup: async (key: string) => records.get(key),
        }),
      },
    },
  } as never);
  return { calls: registerGatewayMethod.mock.calls, records, toolCalls: registerTool.mock.calls };
}

describe("proactive Concern runtime tool", () => {
  it("allows only the native loopback and Compose Assist origins", () => {
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

  it("registers a tool schema with no endpoint or credential arguments", () => {
    process.env.ASSIST_API_BASE = "http://assist:18790";
    process.env.PROACTIVE_AGENT_TOKEN = "runtime-owned-token";
    const { toolCalls } = setup();
    expect(toolCalls).toHaveLength(1);
    const [factory, options] = toolCalls[0];
    const tool = factory({});
    expect(options).toEqual({ name: "proactive_concern" });
    expect(tool.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["catalog", "compile"] },
        draft: { type: "object", additionalProperties: true },
      },
      required: ["action"],
    });
  });

  it("uses its captured endpoint and token and decorates test-only compile results", async () => {
    const endpoint = resolveTrustedAssistEndpoint("http://assist:18790");
    const requester = vi.fn(async () => ({
      concernId: "concern-1",
      status: "PROPOSED",
      observationScope: { reliability: { testProviderOnly: true } },
    }));
    const tool = createProactiveConcernTool(endpoint, "captured-token", requester);
    process.env.ASSIST_API_BASE = "http://attacker:18790";
    process.env.PROACTIVE_AGENT_TOKEN = "replacement-token";

    const result = await tool.execute("call-1", {
      action: "compile",
      draft: { draftId: "stable-draft" },
    });

    expect(requester).toHaveBeenCalledWith(
      endpoint,
      "captured-token",
      "POST",
      "/api/proactive/concern-drafts/compile",
      { draftId: "stable-draft" },
    );
    expect(result.details).toMatchObject({
      concernId: "concern-1",
      capabilityAvailability: "test_only",
      userDisclosure: "仅为测试能力，不会执行真实监控或通知。",
    });
  });

  it("fails closed when runtime configuration is unavailable", async () => {
    const requester = vi.fn();
    const tool = createProactiveConcernTool(null, "", requester);
    const result = await tool.execute("call-1", { action: "catalog" });
    expect(requester).not.toHaveBeenCalled();
    expect(result.details).toEqual({ error: "proactive Concern service is not configured" });
  });

  it("uses direct HTTP and rejects redirects without forwarding the credential", async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      expect(request.headers.authorization).toBe("Bearer captured-token");
      response.writeHead(302, { location: "http://attacker.invalid/collect" });
      response.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    process.env.HTTP_PROXY = "http://attacker.invalid:8080";
    process.env.HTTPS_PROXY = "http://attacker.invalid:8080";
    try {
      await expect(
        requestProactiveConcern(
          new URL(`http://127.0.0.1:${address.port}`),
          "captured-token",
          "GET",
          "/catalog",
        ),
      ).rejects.toThrow("Assist returned HTTP 302");
      expect(requests).toBe(1);
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

function method(calls: unknown[][], name: string): GatewayMethodRegistration {
  const registration = calls.find(([registeredName]) => registeredName === name);
  if (!registration) {
    throw new Error(`missing gateway method: ${name}`);
  }
  return registration as GatewayMethodRegistration;
}

function gatewayClient(
  value: Record<string, unknown>,
): NonNullable<GatewayRequestHandlerOptions["client"]> {
  return value as never;
}

function pairedOperator(gatewayDeviceId = "android-fingerprint") {
  return gatewayClient({
    id: "android-client",
    isDeviceTokenAuth: true,
    connect: {
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      device: { id: gatewayDeviceId },
    },
  });
}

function decodeClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
}

async function upsertBinding(calls: unknown[][], overrides: Record<string, unknown> = {}) {
  const [, handler] = method(calls, "flowos.deviceEventBinding.upsert");
  const respond = vi.fn();
  await invoke(handler, {
    params: {
      gatewayDeviceId: "android-fingerprint",
      hubDeviceId: "hs-abc12345",
      tenantId: "tenant-a",
      subjectUserId: "alice",
      ...overrides,
    },
    client: pairedOperator("admin-device"),
    respond,
  });
  expect(respond.mock.calls[0][0]).toBe(true);
}

describe("flowos task-center auth", () => {
  it("registers a paired-device-only read method and signs server-bound identity", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [name, handler, options] = method(calls, "flowos.taskCenterToken");
    expect(name).toBe("flowos.taskCenterToken");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(claims).toMatchObject({
      aud: "assist:task-center",
      sub: "user:alice",
      tenantId: "tenant-a",
      actorType: "USER",
      scope: "",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  it("keeps the MiniApp audience and scopes separate", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.miniAppToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(claims.aud).toBe("assist:miniapps");
    expect(String(claims.scope).split(" ")).toEqual([
      "miniapp.data.read",
      "miniapp.data.write",
      "miniapp.inbox.read",
      "miniapp.inbox.ack",
      "miniapp.function.invoke",
    ]);
  });

  it("loads the shared signing secret from a private file", async () => {
    writeTaskCenterSecret();
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.deviceOnboardingToken");
    const respond = vi.fn();

    await invoke(handler, { params: {}, client: pairedOperator(), respond });

    expect(respond.mock.calls[0][0]).toBe(true);
    expect(decodeClaims(respond.mock.calls[0][1].accessToken)).toMatchObject({
      aud: "assist:device-onboarding",
      sub: "user:alice",
      tenantId: "tenant-a",
    });
  });

  it("rejects a group-readable signing secret file", async () => {
    writeTaskCenterSecret("s".repeat(32), 0o640);
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.deviceOnboardingToken");
    const respond = vi.fn();

    await invoke(handler, { params: {}, client: pairedOperator(), respond });

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "user auth is not configured",
    });
  });

  it("rejects a signing secret symlink", async () => {
    const secret = writeTaskCenterSecret();
    const target = process.env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE!;
    const link = path.join(path.dirname(target), "task-center-jwt.link");
    fs.symlinkSync(target, link);
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE = link;
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.deviceOnboardingToken");
    const respond = vi.fn();

    await invoke(handler, { params: {}, client: pairedOperator(), respond });

    expect(secret).toHaveLength(32);
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "user auth is not configured",
    });
  });

  it("issues a dedicated Surface Context user token", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [name, handler, options] = method(calls, "flowos.surfaceContextToken");
    expect(name).toBe("flowos.surfaceContextToken");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(claims).toMatchObject({
      aud: "assist:surface-context",
      sub: "user:alice",
      tenantId: "tenant-a",
      actorType: "USER",
      scope: "",
    });
  });

  it("issues a dedicated device-onboarding confirmation token", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [name, handler, options] = method(calls, "flowos.deviceOnboardingToken");
    expect(name).toBe("flowos.deviceOnboardingToken");
    expect(options).toEqual({ scope: "operator.admin" });
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(claims).toMatchObject({
      aud: "assist:device-onboarding",
      sub: "user:alice",
      tenantId: "tenant-a",
      actorType: "USER",
      scope: "device-onboarding:confirm",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  it("rejects non-operator callers for device onboarding confirmation", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.deviceOnboardingToken");
    const respond = vi.fn();
    await invoke(handler, {
      params: {},
      client: gatewayClient({
        isDeviceTokenAuth: true,
        connect: { role: "node", device: { id: "flowgo" } },
      }),
      respond,
    });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it("provisions the scanned FlowGo identity with a bounded operator token", async () => {
    const publicKeyBytes = Buffer.alloc(32, 7);
    const publicKey = publicKeyBytes.toString("base64url");
    const deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
    pairingMocks.get.mockResolvedValue(null);
    pairingMocks.request.mockResolvedValue({
      status: "pending",
      created: true,
      request: { requestId: "pair-1" },
    });
    pairingMocks.approve.mockResolvedValue({
      status: "approved",
      device: { deviceId: "flowgo-1" },
    });
    pairingMocks.ensure.mockResolvedValue({ token: "flowgo-device-token" });
    const { calls } = setup();
    const [, handler, options] = method(calls, "flowos.deviceOnboardingProvision");
    expect(options).toEqual({ scope: "operator.admin" });
    const respond = vi.fn();
    await invoke(handler, {
      params: { deviceId, devicePublicKey: publicKey },
      client: pairedOperator(),
      respond,
    });
    expect(respond).toHaveBeenCalledWith(true, {
      deviceId,
      devicePublicKey: publicKey,
      deviceToken: "flowgo-device-token",
    });
    expect(pairingMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId,
        publicKey,
        platform: "linux",
        deviceFamily: "RaspberryPi",
        clientId: "openclaw-pet",
        clientMode: "ui",
        modelIdentifier: "FlowGo",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      }),
    );
  });

  it("retries the same provisioned identity without rotating its device token", async () => {
    const publicKeyBytes = Buffer.alloc(32, 8);
    const publicKey = publicKeyBytes.toString("base64url");
    const deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
    pairingMocks.get.mockResolvedValue({
      deviceId,
      publicKey,
      clientId: "openclaw-pet",
      clientMode: "ui",
      platform: "linux",
      deviceFamily: "RaspberryPi",
      modelIdentifier: "FlowGo",
    });
    pairingMocks.ensure.mockResolvedValue({ token: "stable-device-token" });
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.deviceOnboardingProvision");
    const respond = vi.fn();
    await invoke(handler, {
      params: { deviceId, devicePublicKey: publicKey },
      client: pairedOperator(),
      respond,
    });
    expect(respond.mock.calls[0][1]).toMatchObject({
      deviceId,
      deviceToken: "stable-device-token",
    });
    expect(pairingMocks.request).not.toHaveBeenCalled();
    expect(pairingMocks.approve).not.toHaveBeenCalled();
  });

  it("provisions AgentTerminal without changing the FlowGo profile", async () => {
    const bytes = Buffer.alloc(32, 11);
    const publicKey = bytes.toString("base64url");
    const deviceId = createHash("sha256").update(bytes).digest("hex");
    pairingMocks.get.mockResolvedValue(null);
    pairingMocks.request.mockResolvedValue({ request: { requestId: "terminal-1" } });
    pairingMocks.approve.mockResolvedValue({ status: "approved", device: { deviceId } });
    pairingMocks.ensure.mockResolvedValue({ token: "terminal-device-token" });
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.deviceOnboardingProvision");
    const respond = vi.fn();
    await invoke(handler, {
      params: { deviceId, devicePublicKey: publicKey, deviceType: "AgentTerminal" },
      client: pairedOperator(),
      respond,
    });
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(pairingMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "gateway-client",
        platform: "esp32",
        deviceFamily: "ESP32",
        modelIdentifier: "ESP32-S3-Touch-AMOLED-1.75C",
        scopes: ["operator.read", "operator.write"],
      }),
    );
  });

  it("repairs the legacy FlowGo identity to the current client contract", async () => {
    const publicKeyBytes = Buffer.alloc(32, 9);
    const publicKey = publicKeyBytes.toString("base64url");
    const deviceId = createHash("sha256").update(publicKeyBytes).digest("hex");
    pairingMocks.get.mockResolvedValue({
      deviceId,
      publicKey,
      clientId: "gateway-client",
      clientMode: "ui",
      platform: "linux",
      deviceFamily: "RaspberryPi",
    });
    pairingMocks.request.mockResolvedValue({
      status: "pending",
      created: true,
      request: { requestId: "repair-1" },
    });
    pairingMocks.approve.mockResolvedValue({
      status: "approved",
      device: { deviceId },
    });
    pairingMocks.ensure.mockResolvedValue({ token: "repaired-device-token" });
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.deviceOnboardingProvision");
    const respond = vi.fn();
    await invoke(handler, {
      params: { deviceId, devicePublicKey: publicKey },
      client: pairedOperator(),
      respond,
    });
    expect(pairingMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId,
        publicKey,
        clientId: "openclaw-pet",
        clientMode: "ui",
        platform: "linux",
        deviceFamily: "RaspberryPi",
        modelIdentifier: "FlowGo",
      }),
    );
    expect(pairingMocks.approve).toHaveBeenCalledWith("repair-1", {
      callerScopes: ["operator.read", "operator.write", "operator.admin"],
    });
    expect(respond).toHaveBeenCalledWith(true, {
      deviceId,
      devicePublicKey: publicKey,
      deviceToken: "repaired-device-token",
    });
  });

  it("issues proactive-service tokens on their own audience", async () => {
    // ★ 单独 audience 是这条的全部意义:主动服务的读接口会吐 userRef、订单号,
    //   以及「这个人用哪些 App、什么时候在用」。一张任务中心的票不该顺带能拉走这些。
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [name, handler, options] = method(calls, "flowos.proactiveToken");
    expect(name).toBe("flowos.proactiveToken");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(respond.mock.calls[0][0]).toBe(true);
    expect(claims).toMatchObject({
      aud: "assist:proactive",
      sub: "user:alice",
      tenantId: "tenant-a",
      // ★ actorType 是 #145 那版(gateway 主令牌)拿不出来的东西 —— 它认「是不是自己人」,
      //   认不出是用户还是 Agent,于是「Agent 只能提议、要用户确认才生效」形同虚设。
      actorType: "USER",
      scope: "",
    });
    // 短时效:一张票最多活 5 分钟,泄露的窗口被这个数字框死
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  it("requires a paired device for the proactive token too", async () => {
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.proactiveToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: gatewayClient({}), respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it("rejects caller-supplied identity on the proactive token", async () => {
    // 身份由服务端绑定,调用方不许自报 —— 否则任何配对设备都能签出别人的票
    process.env.FLOWOS_TASK_CENTER_JWT_SECRET = "s".repeat(32);
    const { calls } = setup();
    const [, handler] = method(calls, "flowos.proactiveToken");
    const respond = vi.fn();
    await invoke(handler, { params: { sub: "user:mallory" }, client: pairedOperator(), respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });
});

describe("FlowOS Device Event identity", () => {
  it("persists an admin-managed binding and issues exact five-minute device claims", async () => {
    writeDeviceSecret();
    const { calls, records } = setup();
    expect(method(calls, "flowos.deviceEventBinding.upsert")[2]).toEqual({
      scope: "operator.admin",
    });
    await upsertBinding(calls);
    expect(records.get("android-fingerprint")).toMatchObject({
      gatewayDeviceId: "android-fingerprint",
      hubDeviceId: "hs-abc12345",
      tenantId: "tenant-a",
      subjectUserId: "alice",
      status: "active",
    });

    const [, handler, options] = method(calls, "flowos.deviceEventToken.v1");
    expect(options).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0][0]).toBe(true);
    const payload = respond.mock.calls[0][1];
    const claims = decodeClaims(payload.accessToken);
    expect(payload).toMatchObject({ tokenType: "Bearer", expiresIn: 300 });
    expect(claims).toMatchObject({
      iss: "flowos-device-identity",
      aud: "assist:device-events",
      sub: "device:hs-abc12345",
      actorType: "DEVICE",
      deviceId: "hs-abc12345",
      tenantId: "tenant-a",
      subjectUserId: "alice",
      scope: "device.event.write",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    expect(typeof claims.jti).toBe("string");
  });

  it("keeps the original method on the legacy Health capability during migration", async () => {
    writeDeviceSecret();
    const { calls } = setup();
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    const claims = decodeClaims(respond.mock.calls[0][1].accessToken);
    expect(claims).toMatchObject({
      aud: "assist:health-device-ingest",
      scope: "health.device-event.write",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
  });

  it("creates a unique jti for every issuance", async () => {
    writeDeviceSecret();
    const { calls } = setup();
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken.v1");
    const first = vi.fn();
    const second = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond: first });
    await invoke(handler, { params: {}, client: pairedOperator(), respond: second });
    expect(decodeClaims(first.mock.calls[0][1].accessToken).jti).not.toBe(
      decodeClaims(second.mock.calls[0][1].accessToken).jti,
    );
  });

  it.each([
    [
      "shared gateway auth",
      gatewayClient({ isDeviceTokenAuth: false, connect: { role: "operator" } }),
    ],
    [
      "node role",
      gatewayClient({
        isDeviceTokenAuth: true,
        connect: { role: "node", device: { id: "android-fingerprint" } },
      }),
    ],
    ["wrong device", pairedOperator("another-android")],
  ])("rejects %s", async (_label, client) => {
    writeDeviceSecret();
    const { calls } = setup();
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client, respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it("rejects caller-supplied identity parameters", async () => {
    writeDeviceSecret();
    const { calls } = setup();
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(handler, {
      params: { deviceId: "hs-mallory", tenantId: "other", subjectUserId: "mallory" },
      client: pairedOperator(),
      respond,
    });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it("revokes a binding without deleting its audit record", async () => {
    writeDeviceSecret();
    const { calls, records } = setup();
    await upsertBinding(calls);
    const [, revoke] = method(calls, "flowos.deviceEventBinding.revoke");
    const revoked = vi.fn();
    await invoke(revoke, {
      params: { gatewayDeviceId: "android-fingerprint" },
      client: pairedOperator("admin-device"),
      respond: revoked,
    });
    expect(records.get("android-fingerprint")).toMatchObject({ status: "revoked" });
    const [, issue] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(issue, { params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0][0]).toBe(false);
  });

  it.each([
    ["missing", undefined, undefined],
    ["insecure permissions", "d".repeat(48), 0o644],
    ["too short", "short", 0o600],
    ["reused credential", "r".repeat(48), 0o600],
    ["reused configured gateway token", "g".repeat(48), 0o600],
  ])("fails closed when the signing secret is %s", async (_label, secret, mode) => {
    if (secret !== undefined && mode !== undefined) {
      writeDeviceSecret(secret, mode);
    }
    if (_label === "reused credential") {
      process.env.FLOWOS_TASK_CENTER_JWT_SECRET = secret;
    }
    const { calls } = setup(_label === "reused configured gateway token" ? secret : undefined);
    await upsertBinding(calls);
    const [, handler] = method(calls, "flowos.deviceEventToken");
    const respond = vi.fn();
    await invoke(handler, { params: {}, client: pairedOperator(), respond });
    expect(respond.mock.calls[0]).toEqual([
      false,
      undefined,
      { code: "UNAVAILABLE", message: "device event authentication is not configured" },
    ]);
  });
});
