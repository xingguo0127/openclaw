// Qwen-Audio-TTS tests cover speech provider plugin behavior (network mocked).
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const { qwenAudioTTSMock } = vi.hoisted(() => ({
  qwenAudioTTSMock: vi.fn(),
}));

vi.mock("./tts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tts.js")>();
  return { ...actual, qwenAudioTTS: qwenAudioTTSMock };
});

import { buildQwenAudioTtsSpeechProvider } from "./speech-provider.js";
import {
  buildContinueTaskCommand,
  buildFinishTaskCommand,
  buildRunTaskCommand,
  resolveQwenAudioTtsBaseUrl,
} from "./tts.js";

const READY = {
  apiKey: "sk-test",
  workspace: "llm-ws",
  voiceId: "qwen-audio-3.0-tts-flash-test-abc",
};

afterAll(() => {
  vi.doUnmock("./tts.js");
  vi.resetModules();
});

describe("buildQwenAudioTtsSpeechProvider", () => {
  afterEach(() => {
    qwenAudioTTSMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("is configured only when apiKey + workspace + voice are all present", () => {
    const provider = buildQwenAudioTtsSpeechProvider();
    expect(provider.isConfigured({ providerConfig: READY, timeoutMs: 30_000 })).toBe(true);
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "sk", voiceId: "v" },
        timeoutMs: 30_000,
      }),
    ).toBe(false);
    expect(
      provider.isConfigured({
        providerConfig: { apiKey: "sk", workspace: "w" },
        timeoutMs: 30_000,
      }),
    ).toBe(false);
  });

  it("synthesize passes voice/instruction/pitch through and returns mp3", async () => {
    qwenAudioTTSMock.mockResolvedValue(Buffer.from("audio"));
    const provider = buildQwenAudioTtsSpeechProvider();
    const result = await provider.synthesize({
      text: "你好，我是左特。",
      cfg: {} as never,
      providerConfig: {
        ...READY,
        model: "qwen-audio-3.0-tts-plus",
        instruction: "傲慢",
        pitch: 1.12,
      },
      target: "audio-file",
      timeoutMs: 30_000,
    });
    expect(result).toEqual({
      audioBuffer: Buffer.from("audio"),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    });
    expect(qwenAudioTTSMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "你好，我是左特。",
        voice: READY.voiceId,
        model: "qwen-audio-3.0-tts-plus",
        format: "mp3",
        instruction: "傲慢",
        pitchRate: 1.12,
      }),
    );
  });

  it("per-request directive overrides beat config voice", async () => {
    qwenAudioTTSMock.mockResolvedValue(Buffer.from("audio"));
    const provider = buildQwenAudioTtsSpeechProvider();
    await provider.synthesize({
      text: "hi",
      cfg: {} as never,
      providerConfig: READY,
      providerOverrides: { voiceId: "cloned-override" },
      target: "audio-file",
      timeoutMs: 30_000,
    });
    expect(qwenAudioTTSMock).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "cloned-override" }),
    );
  });

  it("telephony synthesizes pcm at a fixed sample rate", async () => {
    qwenAudioTTSMock.mockResolvedValue(Buffer.from("pcm"));
    const provider = buildQwenAudioTtsSpeechProvider();
    const result = await provider.synthesizeTelephony!({
      text: "hi",
      cfg: {} as never,
      providerConfig: READY,
      timeoutMs: 30_000,
    });
    expect(result.outputFormat).toBe("pcm");
    expect(result.sampleRate).toBe(24_000);
    expect(qwenAudioTTSMock).toHaveBeenCalledWith(expect.objectContaining({ format: "pcm" }));
  });

  it("synthesize rejects when workspace is missing", async () => {
    const provider = buildQwenAudioTtsSpeechProvider();
    await expect(
      provider.synthesize({
        text: "hi",
        cfg: {} as never,
        providerConfig: { apiKey: "sk", voiceId: "v" },
        target: "audio-file",
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/workspace/i);
    expect(qwenAudioTTSMock).not.toHaveBeenCalled();
  });

  it("voice/instruction/pitch directive tokens produce overrides", () => {
    const provider = buildQwenAudioTtsSpeechProvider();
    const policy = {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };
    expect(provider.parseDirectiveToken!({ key: "voice", value: "v2", policy })).toEqual({
      handled: true,
      overrides: { voiceId: "v2" },
    });
    expect(provider.parseDirectiveToken!({ key: "instruction", value: "得意", policy })).toEqual({
      handled: true,
      overrides: { instruction: "得意" },
    });
    expect(provider.parseDirectiveToken!({ key: "pitch", value: "1.2", policy }).handled).toBe(
      true,
    );
  });
});

describe("qwen-audio-tts protocol builders", () => {
  it("derives the maas business-space inference endpoint from workspace", () => {
    expect(resolveQwenAudioTtsBaseUrl({ workspace: "llm-x" })).toBe(
      "wss://llm-x.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
    );
    expect(resolveQwenAudioTtsBaseUrl({ workspace: "llm-x", baseUrl: "wss://custom/ep/" })).toBe(
      "wss://custom/ep",
    );
  });

  it("run-task carries voice + tts parameters and optional instruction/pitch", () => {
    const cmd = buildRunTaskCommand("t1", "qwen-audio-3.0-tts-plus", {
      voice: "vc",
      format: "mp3",
      sampleRate: 24_000,
      instruction: "傲慢",
      pitchRate: 1.12,
      speechRate: 1.05,
    }) as {
      header: { action: string; task_id: string; streaming: string };
      payload: { model: string; task: string; parameters: Record<string, unknown> };
    };
    expect(cmd.header).toEqual({ action: "run-task", task_id: "t1", streaming: "duplex" });
    expect(cmd.payload.model).toBe("qwen-audio-3.0-tts-plus");
    expect(cmd.payload.task).toBe("tts");
    expect(cmd.payload.parameters).toMatchObject({
      voice: "vc",
      format: "mp3",
      sample_rate: 24_000,
      instruction: "傲慢",
      pitch: 1.12,
      rate: 1.05,
      text_type: "PlainText",
    });
  });

  it("continue-task carries the synthesis text and finish-task closes the task", () => {
    const cont = buildContinueTaskCommand("t1", "m", "念这句") as {
      header: { action: string };
      payload: { input: { text: string } };
    };
    expect(cont.header.action).toBe("continue-task");
    expect(cont.payload.input.text).toBe("念这句");
    const fin = buildFinishTaskCommand("t1") as { header: { action: string } };
    expect(fin.header.action).toBe("finish-task");
  });
});
