import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";

const defaultAssistEndpoint = "http://127.0.0.1:18790";
const allowedAssistHosts = new Set(["127.0.0.1", "localhost", "assist"]);
const maxResponseBytes = 16 * 1024;
const runtimeTokenPurpose = "flowos-surface-context-runtime-v1";

export type SurfaceContextBrief = {
  schemaVersion: 1;
  objectType: "SPACE" | "ARTIFACT";
  providerId: string;
  spaceId: string;
  artifactId?: string | null;
  focusedId?: string | null;
  title: string;
  summary: string;
  stableRef: string;
  revision: string;
};

export type SurfaceContextBinding = {
  bindingId: string;
  expiresAt: string;
  context: SurfaceContextBrief;
};

export class SurfaceContextClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SurfaceContextClientError";
  }
}

export function consumeRuntimeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const master = env.FLOWOS_TASK_CENTER_JWT_SECRET?.trim() ?? "";
  if (Buffer.byteLength(master, "utf8") < 32) {
    return null;
  }
  return createHmac("sha256", master).update(runtimeTokenPurpose).digest("hex");
}

export function resolveTrustedAssistEndpoint(value: unknown): URL | null {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultAssistEndpoint;
  try {
    const endpoint = new URL(raw);
    if (
      endpoint.protocol !== "http:" ||
      !allowedAssistHosts.has(endpoint.hostname) ||
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

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...allowed].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseBinding(value: unknown): SurfaceContextBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SurfaceContextClientError("CONTEXT_RESPONSE_INVALID", "invalid Assist response");
  }
  const binding = value as Record<string, unknown>;
  if (!exactKeys(binding, ["bindingId", "expiresAt", "context"])) {
    throw new SurfaceContextClientError("CONTEXT_RESPONSE_INVALID", "unexpected Assist fields");
  }
  if (!boundedString(binding.bindingId, 128) || !/^ctxbind_[a-f0-9]{32}$/.test(binding.bindingId)) {
    throw new SurfaceContextClientError("CONTEXT_RESPONSE_INVALID", "invalid binding identity");
  }
  if (!boundedString(binding.expiresAt, 64) || !Number.isFinite(Date.parse(binding.expiresAt))) {
    throw new SurfaceContextClientError("CONTEXT_RESPONSE_INVALID", "invalid binding expiry");
  }
  if (!binding.context || typeof binding.context !== "object" || Array.isArray(binding.context)) {
    throw new SurfaceContextClientError("CONTEXT_RESPONSE_INVALID", "invalid context brief");
  }
  const context = binding.context as Record<string, unknown>;
  if (
    !exactKeys(context, [
      "schemaVersion",
      "objectType",
      "providerId",
      "spaceId",
      "artifactId",
      "focusedId",
      "title",
      "summary",
      "stableRef",
      "revision",
    ]) ||
    context.schemaVersion !== 1 ||
    (context.objectType !== "SPACE" && context.objectType !== "ARTIFACT") ||
    context.providerId !== "com.flowos.floai" ||
    !boundedString(context.spaceId, 128) ||
    !boundedString(context.title, 160) ||
    typeof context.summary !== "string" ||
    context.summary.length > 400 ||
    !boundedString(context.stableRef, 256) ||
    !boundedString(context.revision, 128) ||
    (context.artifactId !== null &&
      context.artifactId !== undefined &&
      !boundedString(context.artifactId, 128)) ||
    (context.focusedId !== null &&
      context.focusedId !== undefined &&
      !boundedString(context.focusedId, 128))
  ) {
    throw new SurfaceContextClientError("CONTEXT_RESPONSE_INVALID", "invalid context brief fields");
  }
  if (
    (context.objectType === "SPACE" && (context.artifactId != null || context.focusedId != null)) ||
    (context.objectType === "ARTIFACT" &&
      (!context.artifactId || context.focusedId !== context.artifactId))
  ) {
    throw new SurfaceContextClientError("CONTEXT_RESPONSE_INVALID", "inconsistent context pointer");
  }
  return binding as SurfaceContextBinding;
}

function safeErrorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    return typeof parsed.detail === "string" && /^[A-Z0-9_]{1,80}$/.test(parsed.detail)
      ? parsed.detail
      : "CONTEXT_ASSIST_REJECTED";
  } catch {
    return "CONTEXT_ASSIST_REJECTED";
  }
}

export class SurfaceContextClient {
  constructor(
    private readonly endpoint: URL,
    private readonly token: string,
  ) {}

  async consume(
    contextRef: string,
    sessionKey: string,
    turnId: string,
  ): Promise<SurfaceContextBinding> {
    const body = JSON.stringify({ contextRef, sessionKey, turnId });
    return await new Promise((resolve, rejectRequest) => {
      const request = httpRequest(
        {
          protocol: this.endpoint.protocol,
          hostname: this.endpoint.hostname,
          port: this.endpoint.port,
          method: "POST",
          path: "/api/surface-context/refs:consume",
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          timeout: 10_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > maxResponseBytes) {
              request.destroy(new Error("Assist response exceeds 16384 bytes"));
              return;
            }
            chunks.push(bytes);
          });
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              const code = safeErrorCode(text);
              rejectRequest(new SurfaceContextClientError(code, `Assist returned HTTP ${status}`));
              return;
            }
            try {
              resolve(parseBinding(JSON.parse(text) as unknown));
            } catch (error) {
              rejectRequest(error instanceof Error ? error : new Error("invalid Assist response"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("Assist request timed out")));
      request.on("error", rejectRequest);
      request.write(body);
      request.end();
    });
  }
}
