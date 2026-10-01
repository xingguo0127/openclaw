// Qwen-Audio-TTS module: DashScope tts_v2 `run-task` duplex WebSocket protocol.
// Reference wire protocol: dashscope Python SDK dashscope.audio.tts_v2
// (run-task -> task-started -> continue-task(text) -> finish-task -> binary
// audio frames -> task-finished). Bound to the qwen-audio-3.0 family, which is
// served on the Bailian business-space (maas) endpoint, NOT the global one.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export const DEFAULT_QWEN_AUDIO_TTS_MODEL = "qwen-audio-3.0-tts-flash";
export const DEFAULT_QWEN_AUDIO_TTS_REGION = "cn-beijing";

export const QWEN_AUDIO_TTS_MODELS = [
  "qwen-audio-3.0-tts-flash",
  "qwen-audio-3.0-tts-plus",
] as const;

export type QwenAudioTtsFormat = "mp3" | "wav" | "pcm" | "opus";

/**
 * Derives the Bailian maas WebSocket inference endpoint for a workspace.
 * The qwen-audio-3.0 family lives on the business-space subdomain; the global
 * dashscope.aliyuncs.com endpoint answers 1007 "Model not found".
 */
export function resolveQwenAudioTtsBaseUrl(params: {
  baseUrl?: string;
  workspace: string;
  region?: string;
}): string {
  const explicit = params.baseUrl?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const region = params.region?.trim() || DEFAULT_QWEN_AUDIO_TTS_REGION;
  return `wss://${params.workspace}.${region}.maas.aliyuncs.com/api-ws/v1/inference`;
}

export type QwenAudioTtsSynthesisParameters = {
  voice: string;
  format: QwenAudioTtsFormat;
  sampleRate: number;
  volume?: number;
  speechRate?: number;
  pitchRate?: number;
  seed?: number;
  instruction?: string;
  languageHints?: string[];
};

const TASK_META = {
  task_group: "audio",
  task: "tts",
  function: "SpeechSynthesizer",
} as const;

const duplexHeader = (action: string, taskId: string) => ({
  action,
  task_id: taskId,
  streaming: "duplex",
});

/** Builds the run-task command that opens a synthesis task (pure, for tests). */
export function buildRunTaskCommand(
  taskId: string,
  model: string,
  params: QwenAudioTtsSynthesisParameters,
): Record<string, unknown> {
  const parameters: Record<string, unknown> = {
    voice: params.voice,
    volume: params.volume ?? 50,
    text_type: "PlainText",
    sample_rate: params.sampleRate,
    rate: params.speechRate ?? 1.0,
    format: params.format,
    pitch: params.pitchRate ?? 1.0,
    seed: params.seed ?? 0,
    type: 0,
  };
  if (params.instruction != null) {
    parameters.instruction = params.instruction;
  }
  if (params.languageHints != null) {
    parameters.language_hints = params.languageHints;
  }
  return {
    header: duplexHeader("run-task", taskId),
    payload: { model, ...TASK_META, input: {}, parameters },
  };
}

/** Builds the continue-task command carrying the text to synthesize. */
export function buildContinueTaskCommand(
  taskId: string,
  model: string,
  text: string,
): Record<string, unknown> {
  return {
    header: duplexHeader("continue-task", taskId),
    payload: { model, ...TASK_META, input: { text } },
  };
}

/** Builds the finish-task command that closes the synthesis task. */
export function buildFinishTaskCommand(taskId: string): Record<string, unknown> {
  return {
    header: duplexHeader("finish-task", taskId),
    payload: { input: {} },
  };
}

/**
 * Synthesizes `text` over the DashScope duplex WebSocket and returns the full
 * audio buffer. Text is sent in one continue-task (buffered, not streamed).
 */
export async function qwenAudioTTS(
  params: {
    text: string;
    apiKey: string;
    workspace: string;
    baseUrl?: string;
    region?: string;
    model?: string;
    timeoutMs?: number;
  } & QwenAudioTtsSynthesisParameters,
): Promise<Buffer> {
  const url = resolveQwenAudioTtsBaseUrl({
    baseUrl: params.baseUrl,
    workspace: params.workspace,
    region: params.region,
  });
  const model = params.model ?? DEFAULT_QWEN_AUDIO_TTS_MODEL;
  const taskId = randomUUID().replace(/-/g, "");
  const synthParams: QwenAudioTtsSynthesisParameters = {
    voice: params.voice,
    format: params.format,
    sampleRate: params.sampleRate,
    volume: params.volume,
    speechRate: params.speechRate,
    pitchRate: params.pitchRate,
    seed: params.seed,
    instruction: params.instruction,
    languageHints: params.languageHints,
  };

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "X-DashScope-WorkSpace": params.workspace,
      },
    });
    const send = (cmd: Record<string, unknown>) => ws.send(JSON.stringify(cmd));
    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore close races
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("Qwen-Audio-TTS synthesis timed out"))),
      params.timeoutMs ?? 60_000,
    );

    ws.on("open", () => send(buildRunTaskCommand(taskId, model, synthParams)));
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        chunks.push(data as Buffer);
        return;
      }
      let event: string | undefined;
      try {
        event = (JSON.parse(data.toString()) as { header?: { event?: string } }).header?.event;
      } catch {
        return;
      }
      if (event === "task-started") {
        send(buildContinueTaskCommand(taskId, model, params.text));
        send(buildFinishTaskCommand(taskId));
      } else if (event === "task-finished") {
        finish(() =>
          chunks.length > 0
            ? resolve(Buffer.concat(chunks))
            : reject(new Error("Qwen-Audio-TTS returned no audio data")),
        );
      } else if (event === "task-failed") {
        finish(() =>
          reject(new Error(`Qwen-Audio-TTS task-failed: ${data.toString().slice(0, 200)}`)),
        );
      }
    });
    ws.on("error", (err: Error) => finish(() => reject(err)));
    ws.on("close", () =>
      finish(() => reject(new Error("Qwen-Audio-TTS connection closed before task-finished"))),
    );
  });
}
