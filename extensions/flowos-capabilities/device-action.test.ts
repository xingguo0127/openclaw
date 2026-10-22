import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeviceActionTool } from "./device-action.ts";

test("device action uses runtime context and rejects model-supplied device or session", async () => {
  const calls: unknown[][] = [];
  const request = async (...args: unknown[]) => {
    calls.push(args);
    return { ok: true, meetingId: "meeting" };
  };
  const tool = createDeviceActionTool(
    new URL("http://assist:18790"),
    "fake",
    { sessionKey: "terminal-session", runId: "run" },
    request,
  );
  await tool.execute("call", { action: "meeting.start" });
  assert.deepEqual(calls[0].slice(2), [
    "POST",
    "/api/agent-terminal/device-action",
    {
      sessionKey: "terminal-session",
      runId: "run",
      toolCallId: "call",
      action: "meeting.start",
    },
  ]);
  const bad = await tool.execute("call", { action: "meeting.start", deviceId: "other" } as never);
  assert.equal(JSON.parse(bad.content[0].text).error, "invalid_action");
  assert.equal(calls.length, 1);
});

test("missing run context and transport errors cannot claim recording started", async () => {
  const tool = createDeviceActionTool(new URL("http://assist:18790"), "fake", {}, async () => {
    throw new Error("must not call");
  });
  assert.equal(
    JSON.parse((await tool.execute("call", { action: "meeting.start" })).content[0].text).error,
    "unsupported_source",
  );
  const failed = createDeviceActionTool(
    new URL("http://assist:18790"),
    "fake",
    { sessionKey: "session", runId: "run" },
    async () => {
      throw new Error("private data");
    },
  );
  assert.deepEqual(
    JSON.parse((await failed.execute("call", { action: "meeting.start" })).content[0].text),
    { ok: false, error: "start_unconfirmed" },
  );
});

test("translation start passes only a supported optional language", async () => {
  const calls: unknown[][] = [];
  const request = async (...args: unknown[]) => {
    calls.push(args);
    return { ok: true };
  };
  const tool = createDeviceActionTool(
    new URL("http://assist:18790"),
    "fake",
    { sessionKey: "terminal", runId: "run" },
    request,
  );
  await tool.execute("call", { action: "translation.start", targetLanguage: "ja" });
  assert.deepEqual(calls[0][4], {
    sessionKey: "terminal",
    runId: "run",
    toolCallId: "call",
    action: "translation.start",
    targetLanguage: "ja",
  });
  const bad = await tool.execute("call", {
    action: "translation.start",
    targetLanguage: "invented",
  } as never);
  assert.equal(JSON.parse(bad.content[0].text).error, "invalid_action");
  assert.equal(calls.length, 1);
});

test("translation tool accepts all five added languages", async () => {
  for (const targetLanguage of ["ko", "fr", "de", "es", "ru"] as const) {
    const tool = createDeviceActionTool(
      new URL("http://assist:18790"),
      "fake",
      { sessionKey: "terminal", runId: "run" },
      async (...args: unknown[]) => {
        assert.equal((args[4] as { targetLanguage: string }).targetLanguage, targetLanguage);
        return { ok: true };
      },
    );
    const result = await tool.execute("call", { action: "translation.start", targetLanguage });
    assert.equal(JSON.parse(result.content[0].text).ok, true);
  }
});
