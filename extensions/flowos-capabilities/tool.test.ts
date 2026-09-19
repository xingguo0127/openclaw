import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createCapabilityTool, trustedEndpoint, requestCapability } from "./tool.ts";

test("only the trusted deployment endpoint can hold credentials", () => {
  for (const url of ["https://assist:18790", "http://evil:18790", "http://assist:18790/private", "http://u:p@assist:18790", "http://assist:18790/?x=1"]) assert.equal(trustedEndpoint(url), null);
  assert.ok(trustedEndpoint("http://assist:18790"));
});
test("discovery, description and invocation use the fixed shared API", async () => {
  const calls: any[] = [];
  const tool = createCapabilityTool(trustedEndpoint(), "fake", async (...args) => { calls.push(args); return { ok: true }; });
  await tool.execute("a", { action: "catalog" });
  await tool.execute("b", { action: "describe", capabilityId: "health.sleep.v1" });
  await tool.execute("c", { action: "invoke", capabilityId: "health.sleep.v1", input: { startDate: "2026-09-18", endDate: "2026-09-18" } });
  assert.equal(calls[0][3], "/api/proactive/platform-capabilities");
  assert.equal(calls[1][3], "/api/proactive/platform-capabilities/health.sleep.v1");
  assert.equal(calls[2][2], "POST");
  assert.equal(calls[2][4].capabilityId, "health.sleep.v1");
  const bad = await tool.execute("d", { action: "catalog", token: "attacker" } as any);
  assert.equal(bad.isError, true); assert.equal(calls.length, 3);
});
test("transport does not forward tokens to redirect targets or expose error bodies", async () => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/private" }); res.end("private-token"); }
    else { redirected++; res.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as any;
    await assert.rejects(requestCapability(new URL(`http://127.0.0.1:${address.port}`), "fake", "GET", "/redirect"), /http_302/);
    assert.equal(redirected, 0);
  } finally { server.close(); }
});

test("tool keeps safe error categories and redacts arbitrary failures", async () => {
  for (const [message, expected] of [["http_403", "http_403"], ["timeout", "timeout"], ["private-token", "capability_request_failed"]]) {
    const tool = createCapabilityTool(trustedEndpoint(), "fake", async () => { throw new Error(message); });
    const result = await tool.execute("a", { action: "catalog" });
    assert.equal(JSON.parse(result.content[0].text).error, expected);
  }
});
