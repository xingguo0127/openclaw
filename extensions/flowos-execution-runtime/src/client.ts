import { request as httpRequest } from "node:http";

const defaultAssistUrl = "http://127.0.0.1:18790";
const trustedAssistHosts = new Set(["127.0.0.1", "assist"]);
const maxResponseBytes = 1_000_000;

export type ActiveExecution = {
  executionId: string;
  currentAttemptId?: string | null;
  ownerAgentId?: string | null;
  spaceId?: string | null;
  taskId?: string | null;
  status: string;
  version: number;
  stageKey: string;
  resultRef?: { type: string; id: string; spaceId?: string | null } | null;
};

export type SpaceArtifactRef = {
  type: "SPACE_ARTIFACT";
  id: string;
  spaceId: string;
};

export type AssistRequest = (
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export function resolveTrustedAssistEndpoint(value: unknown): URL | null {
  const raw = typeof value === "string" && value.trim() ? value.trim() : defaultAssistUrl;
  try {
    const endpoint = new URL(raw);
    if (
      endpoint.protocol !== "http:" ||
      !trustedAssistHosts.has(endpoint.hostname) ||
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

export function createAssistRequest(
  endpoint: URL,
  token: string,
  options: { timeoutMs?: number } = {},
): AssistRequest {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (method, path, payload) => {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    return await new Promise((resolve, reject) => {
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
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > maxResponseBytes) {
              request.destroy(new Error("Assist response exceeds 1,000,000 bytes"));
              return;
            }
            chunks.push(bytes);
          });
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`Assist returned HTTP ${status}`));
              return;
            }
            try {
              const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
              if (!result || typeof result !== "object" || Array.isArray(result)) {
                throw new Error("Assist returned an invalid JSON object");
              }
              resolve(result as Record<string, unknown>);
            } catch (error) {
              reject(error instanceof Error ? error : new Error("Assist returned invalid JSON"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("Assist request timed out")));
      request.on("error", reject);
      if (body !== undefined) {
        request.write(body);
      }
      request.end();
    });
  };
}

function requireExecution(value: Record<string, unknown>): ActiveExecution {
  const executionId = value.executionId;
  const status = value.status;
  const version = value.version;
  const stageKey = value.stageKey;
  if (
    typeof executionId !== "string" ||
    typeof status !== "string" ||
    typeof version !== "number" ||
    typeof stageKey !== "string"
  ) {
    throw new Error("Assist returned an invalid Active Execution");
  }
  return value as ActiveExecution;
}

function requireSpaceArtifactRef(value: Record<string, unknown>): SpaceArtifactRef {
  if (
    value.type !== "SPACE_ARTIFACT" ||
    typeof value.id !== "string" ||
    typeof value.spaceId !== "string"
  ) {
    throw new Error("Assist returned an invalid Space Artifact reference");
  }
  return value as SpaceArtifactRef;
}

export class FlowosExecutionClient {
  constructor(private readonly request: AssistRequest) {}

  async create(payload: Record<string, unknown>): Promise<ActiveExecution> {
    return requireExecution(await this.request("POST", "/api/executions", payload));
  }

  async detail(executionId: string): Promise<ActiveExecution> {
    return requireExecution(
      await this.request("GET", `/api/executions/writer/${encodeURIComponent(executionId)}`),
    );
  }

  async stage(executionId: string, payload: Record<string, unknown>): Promise<ActiveExecution> {
    return requireExecution(
      await this.request(
        "POST",
        `/api/executions/${encodeURIComponent(executionId)}/stage`,
        payload,
      ),
    );
  }

  async complete(params: {
    executionId: string;
    expectedVersion: number;
    resultRef: Record<string, unknown>;
  }): Promise<ActiveExecution> {
    return requireExecution(
      await this.request(
        "POST",
        `/api/executions/${encodeURIComponent(params.executionId)}/complete`,
        { expectedVersion: params.expectedVersion, resultRef: params.resultRef },
      ),
    );
  }

  async registerSpaceArtifact(
    executionId: string,
    payload: Record<string, unknown>,
  ): Promise<SpaceArtifactRef> {
    return requireSpaceArtifactRef(
      await this.request(
        "POST",
        `/api/executions/${encodeURIComponent(executionId)}/space-artifacts`,
        payload,
      ),
    );
  }

  async fail(executionId: string, payload: Record<string, unknown>): Promise<ActiveExecution> {
    return requireExecution(
      await this.request(
        "POST",
        `/api/executions/${encodeURIComponent(executionId)}/fail`,
        payload,
      ),
    );
  }
}
