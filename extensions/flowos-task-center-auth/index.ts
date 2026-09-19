import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  approveDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  requestDevicePairing,
} from "openclaw/plugin-sdk/device-bootstrap";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

type PluginConfig = { userId?: unknown; tenantId?: unknown };
type DeviceEventBinding = {
  gatewayDeviceId: string;
  hubDeviceId: string;
  tenantId: string;
  subjectUserId: string;
  status: "active" | "revoked";
  updatedAt: string;
  updatedBy: string;
};

const pluginId = "flowos-task-center-auth";
const genericDeviceEventAudience = "assist:device-events";
const legacyHealthDeviceEventAudience = "assist:health-device-ingest";
const defaultDeviceEventIssuer = "flowos-device-identity";
const genericDeviceEventScope = "device.event.write";
const legacyHealthDeviceEventScope = "health.device-event.write";
const tokenLifetimeSeconds = 300;
const bindingsNamespace = "device-event-bindings";
const knownCredentialNames = [
  "OPENCLAW_GATEWAY_TOKEN",
  "FLOWOS_TASK_CENTER_JWT_SECRET",
  "CODING_BUDDY_PUBLISH_TOKEN",
  "CODING_JOB_TOKEN",
  "HEALTH_CORE_WRITE_TOKEN",
  "MINIAPP_EVENT_CAPABILITY_SECRET",
  "HEALTH_BUDDY_INBOX_TOKEN",
  "PROACTIVE_AGENT_TOKEN",
] as const;

const proactiveConcernToolName = "proactive_concern";
const proactiveAssistDefault = "http://127.0.0.1:18790";
const proactiveAssistHosts = new Set(["127.0.0.1", "assist"]);
const proactiveMaxResponseBytes = 1_000_000;
const proactiveTestDisclosure = "仅为测试能力，不会执行真实监控或通知。";
const proactiveSafeValidationFields = new Set([
  "draftId",
  "capabilityId",
  "title",
  "contextRef",
  "parameters",
  "conditions",
  "field",
  "operator",
  "value",
  "processing",
  "delivery",
  "mode",
  "expiresAt",
]);

type ProactiveConcernParams = {
  action: "catalog" | "compile";
  draft?: Record<string, unknown>;
};

export function resolveTrustedAssistEndpoint(value: unknown): URL | null {
  const raw = normalizedString(value) || proactiveAssistDefault;
  try {
    const endpoint = new URL(raw);
    if (
      endpoint.protocol !== "http:" ||
      !proactiveAssistHosts.has(endpoint.hostname) ||
      endpoint.port !== "18790" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      (endpoint.pathname !== "" && endpoint.pathname !== "/")
    ) {
      return null;
    }
    return endpoint;
  } catch {
    return null;
  }
}

function safeProactiveValidationDetail(body: string): string {
  try {
    const payload = JSON.parse(body) as { detail?: unknown };
    if (!Array.isArray(payload.detail)) {
      return "";
    }
    return payload.detail
      .slice(0, 5)
      .flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const record = item as { loc?: unknown; msg?: unknown };
        if (typeof record.msg !== "string") {
          return [];
        }
        const fields = Array.isArray(record.loc)
          ? record.loc.filter(
              (part): part is string =>
                typeof part === "string" && proactiveSafeValidationFields.has(part),
            )
          : [];
        return [`${fields.slice(-2).join(".") || "request"}: ${record.msg.slice(0, 200)}`];
      })
      .join("; ");
  } catch {
    return "";
  }
}

export async function requestProactiveConcern(
  endpoint: URL,
  token: string,
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return await new Promise((resolve, rejectRequest) => {
    const request = httpRequest(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        },
        timeout: 15_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length;
          if (size > proactiveMaxResponseBytes) {
            request.destroy(new Error("Assist response exceeds 1,000,000 bytes"));
            return;
          }
          chunks.push(bytes);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const detail = safeProactiveValidationDetail(text);
            rejectRequest(
              new Error(`Assist returned HTTP ${status}${detail ? `: ${detail}` : ""}`),
            );
            return;
          }
          try {
            const parsed = JSON.parse(text) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("Assist returned an invalid JSON object");
            }
            resolve(parsed as Record<string, unknown>);
          } catch (error) {
            rejectRequest(error);
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Assist request timed out")));
    request.on("error", rejectRequest);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

type ProactiveConcernRequester = typeof requestProactiveConcern;

export function createProactiveConcernTool(
  endpoint: URL | null,
  token: string,
  requester: ProactiveConcernRequester = requestProactiveConcern,
) {
  return {
    name: proactiveConcernToolName,
    label: "主动关注提案",
    description: "读取受控 Concern 能力目录，或编译一条等待用户确认的 PROPOSED Concern。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["catalog", "compile"] },
        draft: { type: "object", additionalProperties: true },
      },
      required: ["action"],
    },
    async execute(_toolCallId: string, params: ProactiveConcernParams) {
      try {
        if (!endpoint || !token) {
          throw new Error("proactive Concern service is not configured");
        }
        if (params.action !== "catalog" && params.action !== "compile") {
          throw new Error("action must be catalog or compile");
        }
        if (params.action === "compile" && (!params.draft || typeof params.draft !== "object")) {
          throw new Error("compile requires one draft object");
        }
        if (
          params.draft &&
          Buffer.byteLength(JSON.stringify(params.draft), "utf8") > proactiveMaxResponseBytes
        ) {
          throw new Error("draft JSON exceeds 1,000,000 UTF-8 bytes");
        }
        const result =
          params.action === "catalog"
            ? await requester(endpoint, token, "GET", "/api/proactive/concern-capabilities")
            : await requester(
                endpoint,
                token,
                "POST",
                "/api/proactive/concern-drafts/compile",
                params.draft,
              );
        const reliability = (result.observationScope as Record<string, unknown> | undefined)
          ?.reliability as Record<string, unknown> | undefined;
        const decorated =
          params.action === "compile" && reliability?.testProviderOnly === true
            ? {
                ...result,
                capabilityAvailability: "test_only",
                userDisclosure: proactiveTestDisclosure,
              }
            : result;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(decorated) }],
          details: decorated,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "proactive Concern request failed";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          details: { error: message },
        };
      }
    },
  };
}

const miniAppScopes = [
  "miniapp.data.read",
  "miniapp.data.write",
  "miniapp.inbox.read",
  "miniapp.inbox.ack",
  "miniapp.function.invoke",
] as const;

function base64url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${base64url(new Uint8Array(signature))}`;
}

async function issueBoundDeviceJwt(
  binding: Pick<DeviceEventBinding, "hubDeviceId" | "tenantId" | "subjectUserId">,
  secret: string,
  audience: string,
  scope: string,
  issuedAt = Math.floor(Date.now() / 1000),
  issuer = defaultDeviceEventIssuer,
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> {
  const accessToken = await signJwt(
    {
      iss: issuer,
      aud: audience,
      sub: `device:${binding.hubDeviceId}`,
      actorType: "DEVICE",
      deviceId: binding.hubDeviceId,
      tenantId: binding.tenantId,
      subjectUserId: binding.subjectUserId,
      scope,
      iat: issuedAt,
      exp: issuedAt + tokenLifetimeSeconds,
      jti: globalThis.crypto.randomUUID(),
    },
    secret,
  );
  return { accessToken, tokenType: "Bearer", expiresIn: tokenLifetimeSeconds };
}

export async function issueDeviceEventJwt(
  binding: Pick<DeviceEventBinding, "hubDeviceId" | "tenantId" | "subjectUserId">,
  secret: string,
  issuedAt = Math.floor(Date.now() / 1000),
  issuer = defaultDeviceEventIssuer,
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> {
  return issueBoundDeviceJwt(
    binding,
    secret,
    genericDeviceEventAudience,
    genericDeviceEventScope,
    issuedAt,
    issuer,
  );
}

async function issueLegacyHealthDeviceEventJwt(
  binding: Pick<DeviceEventBinding, "hubDeviceId" | "tenantId" | "subjectUserId">,
  secret: string,
  issuedAt = Math.floor(Date.now() / 1000),
  issuer = defaultDeviceEventIssuer,
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> {
  return issueBoundDeviceJwt(
    binding,
    secret,
    legacyHealthDeviceEventAudience,
    legacyHealthDeviceEventScope,
    issuedAt,
    issuer,
  );
}

function reject(respond: GatewayRequestHandlerOptions["respond"], message: string): void {
  respond(false, undefined, { code: "INVALID_REQUEST", message });
}

function normalizedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validIdentifier(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function loadPrivateSecretFile(path: string): string {
  if (!path) {
    return "";
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      return "";
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return "";
    }
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function loadTaskCenterJwtSecret(): string {
  const inline = normalizedString(process.env.FLOWOS_TASK_CENTER_JWT_SECRET);
  if (inline) {
    return inline;
  }
  return loadPrivateSecretFile(normalizedString(process.env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE));
}

function loadDeviceEventSecret(additionalCredentials: readonly unknown[]): string {
  const path = normalizedString(process.env.FLOWOS_DEVICE_EVENT_JWT_SECRET_FILE);
  if (!path) {
    return "";
  }
  try {
    const stat = lstatSync(path);
    // The signing key is a Gateway-only credential. Group/other access is always unsafe.
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      return "";
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return "";
    }
    const secret = readFileSync(path, "utf8").trim();
    const knownCredentials = [
      ...knownCredentialNames.map((name) => process.env[name]),
      ...additionalCredentials,
    ];
    const reused = knownCredentials.some((value) => normalizedString(value) === secret);
    return Buffer.byteLength(secret) >= 32 && !reused ? secret : "";
  } catch {
    return "";
  }
}

async function issueUserToken(
  config: PluginConfig,
  audience: string,
  scopes: readonly string[],
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> {
  const userId = normalizedString(config.userId);
  const tenantId = normalizedString(config.tenantId);
  const secret = loadTaskCenterJwtSecret();
  if (!userId || !tenantId || Buffer.byteLength(secret) < 32) {
    throw new Error("user auth is not configured");
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const accessToken = await signJwt(
    {
      iss: "flowos-gateway",
      aud: audience,
      sub: `user:${userId}`,
      tenantId,
      actorType: "USER",
      scope: scopes.join(" "),
      iat: issuedAt,
      exp: issuedAt + tokenLifetimeSeconds,
      jti: globalThis.crypto.randomUUID(),
    },
    secret,
  );
  return { accessToken, tokenType: "Bearer", expiresIn: tokenLifetimeSeconds };
}

function registerUserTokenMethod(
  api: OpenClawPluginApi,
  config: PluginConfig,
  name: string,
  audience: string,
  scopes: readonly string[],
  requiredScope: "operator.read" | "operator.admin" = "operator.read",
  requireOperatorRole = false,
): void {
  api.registerGatewayMethod(
    name,
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      if (
        !client?.isDeviceTokenAuth ||
        !client.connect.device?.id ||
        (requireOperatorRole && client.connect.role !== "operator")
      ) {
        reject(respond, "paired device authentication required");
        return;
      }
      if (Object.keys(params ?? {}).length > 0) {
        reject(respond, "this method accepts no identity parameters");
        return;
      }
      try {
        respond(true, await issueUserToken(config, audience, scopes));
      } catch {
        respond(false, undefined, { code: "UNAVAILABLE", message: "user auth is not configured" });
      }
    },
    { scope: requiredScope },
  );
}

function registerDeviceOnboardingProvisionMethod(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "flowos.deviceOnboardingProvision",
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      const input = params ?? {};
      const deviceId = normalizedString(input.deviceId);
      const publicKey = normalizedString(input.devicePublicKey);
      const terminal = input.deviceType === "AgentTerminal";
      const profile = terminal
        ? {
            displayName: "FlowOS Agent Terminal",
            platform: "esp32",
            deviceFamily: "ESP32",
            clientId: "gateway-client",
            modelIdentifier: "ESP32-S3-Touch-AMOLED-1.75C",
          }
        : {
            displayName: "FlowGo",
            platform: "linux",
            deviceFamily: "RaspberryPi",
            clientId: "openclaw-pet",
            modelIdentifier: "FlowGo",
          };
      let publicKeyBytes: Buffer;
      try {
        publicKeyBytes = Buffer.from(publicKey, "base64url");
      } catch {
        publicKeyBytes = Buffer.alloc(0);
      }
      if (
        !client?.isDeviceTokenAuth ||
        client.connect.role !== "operator" ||
        !client.connect.device?.id
      ) {
        reject(respond, "paired operator device authentication required");
        return;
      }
      if (
        !hasExactKeys(
          input,
          terminal
            ? ["deviceId", "devicePublicKey", "deviceType"]
            : ["deviceId", "devicePublicKey"],
        ) ||
        !validIdentifier(deviceId) ||
        publicKeyBytes.length !== 32 ||
        publicKeyBytes.toString("base64url") !== publicKey ||
        createHash("sha256").update(publicKeyBytes).digest("hex") !== deviceId
      ) {
        reject(respond, "valid device identity is required");
        return;
      }
      try {
        const existing = await getPairedDevice(deviceId);
        if (existing) {
          const samePublicKey = existing.publicKey === publicKey;
          const isCurrentFlowGoIdentity =
            existing.clientId === profile.clientId &&
            existing.clientMode === "ui" &&
            existing.platform === profile.platform &&
            existing.deviceFamily === profile.deviceFamily &&
            existing.modelIdentifier === profile.modelIdentifier;
          const isLegacyFlowGoIdentity =
            !terminal &&
            existing.clientId === "gateway-client" &&
            existing.clientMode === "ui" &&
            existing.platform === "linux" &&
            existing.deviceFamily === "RaspberryPi" &&
            !existing.modelIdentifier;
          if (!samePublicKey || (!isCurrentFlowGoIdentity && !isLegacyFlowGoIdentity)) {
            reject(respond, "existing device identity does not match onboarding request");
            return;
          }
          if (isCurrentFlowGoIdentity) {
            const token = await ensureDeviceToken({
              deviceId,
              role: "operator",
              scopes: ["operator.read", "operator.write"],
            });
            if (!token) {
              reject(respond, "device token is unavailable");
              return;
            }
            respond(true, { deviceId, devicePublicKey: publicKey, deviceToken: token.token });
            return;
          }
        }
        const requested = await requestDevicePairing({
          deviceId,
          publicKey,
          ...profile,
          clientMode: "ui",
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          silent: false,
        });
        const approved = await approveDevicePairing(requested.request.requestId, {
          callerScopes: client.connect.scopes ?? [],
        });
        if (!approved || approved.status !== "approved") {
          reject(respond, "device provisioning was not approved");
          return;
        }
        const token = await ensureDeviceToken({
          deviceId,
          role: "operator",
          scopes: ["operator.read", "operator.write"],
        });
        if (!token) {
          reject(respond, "device token is unavailable");
          return;
        }
        respond(true, { deviceId, devicePublicKey: publicKey, deviceToken: token.token });
      } catch {
        respond(false, undefined, { code: "UNAVAILABLE", message: "device provisioning failed" });
      }
    },
    { scope: "operator.admin" },
  );
}

function registerDeviceEventBindingMethods(
  api: OpenClawPluginApi,
  bindings: PluginStateKeyedStore<DeviceEventBinding>,
): void {
  api.registerGatewayMethod(
    "flowos.deviceEventBinding.upsert",
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      const input = params ?? {};
      const expected = ["gatewayDeviceId", "hubDeviceId", "subjectUserId", "tenantId"].toSorted();
      const gatewayDeviceId = normalizedString(input.gatewayDeviceId);
      const hubDeviceId = normalizedString(input.hubDeviceId);
      const tenantId = normalizedString(input.tenantId);
      const subjectUserId = normalizedString(input.subjectUserId);
      if (
        !hasExactKeys(input, expected) ||
        !validIdentifier(gatewayDeviceId) ||
        !validIdentifier(hubDeviceId) ||
        !validIdentifier(tenantId) ||
        !validIdentifier(subjectUserId)
      ) {
        reject(respond, "complete device ownership is required");
        return;
      }
      const binding: DeviceEventBinding = {
        gatewayDeviceId,
        hubDeviceId,
        tenantId,
        subjectUserId,
        status: "active",
        updatedAt: new Date().toISOString(),
        updatedBy: client?.connect.device?.id ?? "gateway-admin",
      };
      await bindings.register(gatewayDeviceId, binding);
      respond(true, { binding });
    },
    { scope: "operator.admin" },
  );

  api.registerGatewayMethod(
    "flowos.deviceEventBinding.revoke",
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      const input = params ?? {};
      const gatewayDeviceId = normalizedString(input.gatewayDeviceId);
      if (!hasExactKeys(input, ["gatewayDeviceId"]) || !validIdentifier(gatewayDeviceId)) {
        reject(respond, "gatewayDeviceId is required");
        return;
      }
      const existing = await bindings.lookup(gatewayDeviceId);
      if (!existing) {
        reject(respond, "device binding not found");
        return;
      }
      const binding: DeviceEventBinding = {
        ...existing,
        status: "revoked",
        updatedAt: new Date().toISOString(),
        updatedBy: client?.connect.device?.id ?? "gateway-admin",
      };
      await bindings.register(gatewayDeviceId, binding);
      respond(true, { binding });
    },
    { scope: "operator.admin" },
  );
}

function registerDeviceEventTokenMethod(
  api: OpenClawPluginApi,
  bindings: PluginStateKeyedStore<DeviceEventBinding>,
  secret: string,
  issuer: string,
  name: string,
  issue: typeof issueDeviceEventJwt,
): void {
  api.registerGatewayMethod(
    name,
    async ({ params, client, respond }: GatewayRequestHandlerOptions) => {
      const gatewayDeviceId = client?.connect.device?.id;
      if (!client?.isDeviceTokenAuth || client.connect.role !== "operator" || !gatewayDeviceId) {
        reject(respond, "paired operator device authentication required");
        return;
      }
      if (Object.keys(params ?? {}).length > 0) {
        reject(respond, "this method accepts no identity parameters");
        return;
      }
      if (!secret) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "device event authentication is not configured",
        });
        return;
      }
      const binding = await bindings.lookup(gatewayDeviceId);
      if (!binding || binding.status !== "active") {
        reject(respond, "active device ownership binding required");
        return;
      }
      respond(true, await issue(binding, secret, undefined, issuer));
    },
    { scope: "operator.read" },
  );
}

export default definePluginEntry({
  id: pluginId,
  name: "FlowOS User Auth",
  description: "Issue audience-bound five-minute user and device JWTs for FlowOS services",
  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    // Capture endpoint and credential at plugin startup. Agent/model tool arguments cannot
    // select an origin or supply a credential, and node:http does not honor proxy variables.
    const proactiveEndpoint = resolveTrustedAssistEndpoint(process.env.ASSIST_API_BASE);
    const proactiveToken = normalizedString(process.env.PROACTIVE_AGENT_TOKEN);
    api.registerTool(() => createProactiveConcernTool(proactiveEndpoint, proactiveToken), {
      name: proactiveConcernToolName,
    });
    const bindings = api.runtime.state.openKeyedStore<DeviceEventBinding>({
      namespace: bindingsNamespace,
      maxEntries: 1024,
    });
    registerUserTokenMethod(api, config, "flowos.taskCenterToken", "assist:task-center", []);
    registerUserTokenMethod(
      api,
      config,
      "flowos.surfaceContextToken",
      "assist:surface-context",
      [],
    );
    registerUserTokenMethod(api, config, "flowos.miniAppToken", "assist:miniapps", miniAppScopes);
    registerUserTokenMethod(
      api,
      config,
      "flowos.deviceOnboardingToken",
      "assist:device-onboarding",
      ["device-onboarding:confirm"],
      "operator.admin",
      true,
    );
    registerDeviceOnboardingProvisionMethod(api);
    // 主动服务(委托 / 事件入口 / 收件箱 / 入口审计)的用户主体票。
    // ★ 单独一个 audience,不复用 assist:task-center —— 凭据要按用途分域:
    //   一张任务中心的票不该顺带能拉走「这个人在关注什么、用哪些 App、什么时候在用」。
    // ★ 也不复用 gateway 主令牌(#145 abbde061 的老做法):那是全局共享的长期凭据,
    //   认不出「是用户还是 Agent」,且一台设备泄露即全部沦陷、无法单独吊销。
    registerUserTokenMethod(api, config, "flowos.proactiveToken", "assist:proactive", []);
    registerDeviceEventBindingMethods(api, bindings);
    const issuer =
      normalizedString(process.env.FLOWOS_DEVICE_EVENT_JWT_ISSUER) || defaultDeviceEventIssuer;
    const secret = loadDeviceEventSecret([
      api.config.gateway?.auth?.token,
      api.config.gateway?.auth?.password,
    ]);
    // Keep the original method stable for the legacy Health sink during the migration window.
    registerDeviceEventTokenMethod(
      api,
      bindings,
      secret,
      issuer,
      "flowos.deviceEventToken",
      issueLegacyHealthDeviceEventJwt,
    );
    registerDeviceEventTokenMethod(
      api,
      bindings,
      secret,
      issuer,
      "flowos.deviceEventToken.v1",
      issueDeviceEventJwt,
    );
  },
});
