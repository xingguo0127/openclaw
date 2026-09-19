import { request as httpRequest } from "node:http";

export function trustedEndpoint(raw = "http://127.0.0.1:18790"): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && ["127.0.0.1", "assist"].includes(u.hostname) &&
      u.port === "18790" && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/" ? u : null;
  } catch { return null; }
}

export async function requestCapability(endpoint: URL, token: string, method: string, path: string, payload?: unknown): Promise<unknown> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: endpoint.hostname, port: endpoint.port, method, path,
      headers: { authorization: `Bearer ${token}`, accept: "application/json",
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, res => {
      let size = 0; const chunks: Buffer[] = [];
      res.on("error", () => reject(new Error("transport_failed")));
      res.on("data", chunk => {
        size += chunk.length;
        if (size > 1_000_000) req.destroy(new Error("response_too_large"));
        else chunks.push(Buffer.from(chunk));
      });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`http_${res.statusCode || 0}`)); return;
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { reject(new Error("invalid_response")); }
      });
    });
    // Absolute deadline, including connect and slow streaming; never follow redirects.
    const timer = setTimeout(() => req.destroy(new Error("timeout")), 65_000);
    req.on("close", () => clearTimeout(timer));
    req.on("error", error => reject(new Error(["timeout", "response_too_large"].includes(error.message) ? error.message : "transport_failed")));
    req.end(body);
  });
}

type Params = { action: "catalog" | "describe" | "invoke"; capabilityId?: string; input?: Record<string, unknown> };
export function createCapabilityTool(endpoint: URL | null, token: string, request = requestCapability) {
  return {
    name: "flowos_capability", label: "FlowOS 能力",
    description: "发现平台和已连接账号提供的能力、参数和支持的使用方式。查询外部数据先 catalog，再 describe 获取参数，invoke 执行 invokeSupported 的即时读取。持续关注交给 proactive_concern；目录未列出的服务仍使用原有服务工具，不推断支持后台。",
    parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
      action: { type: "string", enum: ["catalog", "describe", "invoke"] },
      capabilityId: { type: "string", minLength: 3, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$" },
      input: { type: "object", additionalProperties: true },
    } },
    async execute(_id: string, params: Params) {
      try {
        if (!endpoint || !token) throw new Error("not_configured");
        if (!params || Object.keys(params).some(k => !["action", "capabilityId", "input"].includes(k))) throw new Error("invalid_input");
        if (!["catalog", "describe", "invoke"].includes(params.action)) throw new Error("invalid_input");
        if (params.action !== "catalog" && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(params.capabilityId || "")) throw new Error("invalid_input");
        if (Buffer.byteLength(JSON.stringify(params)) > 16_384) throw new Error("input_too_large");
        if (params.action === "invoke" && (!params.input || Array.isArray(params.input) || typeof params.input !== "object")) throw new Error("invalid_input");
        const base = "/api/proactive/platform-capabilities";
        const result = await request(endpoint, token, params.action === "invoke" ? "POST" : "GET",
          params.action === "catalog" ? base : params.action === "describe" ? `${base}/${encodeURIComponent(params.capabilityId!)}` : `${base}/invoke`,
          params.action === "invoke" ? { capabilityId: params.capabilityId, input: params.input } : undefined);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        // Retain only closed error codes, never response bodies or network text.
        const message = error instanceof Error ? error.message : "";
        const safe = ["not_configured", "invalid_input", "input_too_large", "response_too_large", "invalid_response", "timeout", "transport_failed"].includes(message) || /^http_[0-9]{3}$/.test(message)
          ? message : "capability_request_failed";
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: safe, instruction: "401/403 核对授权，422 按 describe 修正参数，429/503 或超时稍后重试；不可声称已执行成功。" }) }] };
      }
    },
  };
}
