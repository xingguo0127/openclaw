import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AssistHttpError } from "./client.js";
import { ingestSchema, publishSchema } from "./space-material-schemas.js";
import { createSpaceMaterialTools } from "./space-materials.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

it("binds real user evidence and runtime identity rather than model supplied context", async () => {
  const root = await mkdtemp(join(tmpdir(), "space-tool-"));
  roots.push(root);
  await mkdir(join(root, "sessions"));
  const url = "http://127.0.0.1:18790/api/media/chat/abc.jpg";
  await writeFile(
    join(root, "sessions/s1.jsonl"),
    JSON.stringify({
      id: "u1",
      message: { role: "user", content: [{ type: "text", text: `登记 ![](${url})` }] },
    }) + "\n",
  );
  const request = vi.fn().mockResolvedValue({ status: "registered", sourceId: "src-real" });
  const context = {
    agentId: "main",
    agentDir: join(root, "agent"),
    sessionId: "s1",
    sessionKey: "agent:main:test",
    runId: "r1",
    trigger: "user",
    senderIsOwner: true,
  };
  const tool = createSpaceMaterialTools(context, request).find(
    (t) => t.name === "space_material_ingest",
  )!;
  await tool.execute("call1", {
    spaceId: "sp1",
    title: "图片",
    materials: [{ type: "image", url, name: "图", text: "尺寸约3.9mm" }],
    context: { sessionId: "forged" },
  });
  expect(request.mock.calls[0][2].context).toEqual({
    sessionId: "s1",
    sessionKey: "agent:main:test",
    runId: "r1",
    sourceMessageIds: { [url]: "u1" },
  });
  request.mockClear();
  const denied = await tool.execute("call2", {
    materials: [{ url: "http://127.0.0.1:18790/api/media/chat/not-sent.jpg" }],
  });
  expect(denied.isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("does not call storage for an untrusted or background run", async () => {
  const request = vi.fn();
  const tool = createSpaceMaterialTools({ agentId: "main", trigger: "heartbeat" }, request)[0];
  expect((await tool.execute("call", {})).isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});

it("accepts saved images before recognition while requiring document content", () => {
  expect(ingestSchema.required).toContain("title");
  expect(ingestSchema.properties.materials.items.required).toEqual(
    expect.arrayContaining(["url", "name"]),
  );
  expect(ingestSchema.properties.materials.items.required).not.toContain("text");
  expect(publishSchema.required).toContain("text");
  expect(publishSchema.properties).toHaveProperty("title");
});

const ownerContext = {
  agentId: "main",
  agentDir: "/trusted/agent",
  sessionId: "s1",
  sessionKey: "agent:main:test",
  runId: "r1",
  trigger: "user",
  senderIsOwner: true,
};

it.each([
  [{ senderIsOwner: false }, "SPACE_OWNER_UNVERIFIED"],
  [{ senderIsOwner: undefined }, "SPACE_OWNER_UNVERIFIED"],
  [{ runId: undefined }, "SPACE_CONTEXT_MISSING"],
  [{ trigger: "heartbeat" }, "SPACE_CALLER_NOT_ALLOWED"],
  [{ sessionKey: "agent:main:subagent:child" }, "SPACE_CALLER_NOT_ALLOWED"],
])("distinguishes context denial without attempting storage: %s", async (override, code) => {
  const request = vi.fn();
  for (const tool of createSpaceMaterialTools({ ...ownerContext, ...override }, request)) {
    const result = await tool.execute("call", {});
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ status: "failed", code });
    expect(JSON.stringify(result.details)).toContain("读取失败不表示空间不存在");
  }
  expect(request).not.toHaveBeenCalled();
});

it.each([
  [403, "SPACE_ACCESS_DENIED"],
  [404, "SPACE_NOT_FOUND"],
  [422, "SPACE_INVALID_REQUEST"],
  [503, "SPACE_SERVICE_UNAVAILABLE"],
])("keeps HTTP %s distinct from missing space", async (status, code) => {
  const request = vi
    .fn()
    .mockRejectedValue(new AssistHttpError(status as number, "request failed"));
  const result = await createSpaceMaterialTools(ownerContext, request)[0].execute("call", {});
  expect(result.isError).toBe(true);
  expect(result.details).toMatchObject({ status: "failed", code });
});
