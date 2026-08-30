// Qwen provider module implements DashScope Qwen-Omni realtime voice over the
// OpenAI-Realtime-compatible WebSocket. Gateway-relay transport only: the relay
// drives us with PCM16/24kHz, but Qwen input is fixed at 16kHz, so sendAudio
// downsamples 24k->16k on the uplink (output stays 24kHz and matches the relay).
import { randomUUID } from "node:crypto";
import {
  captureWsEvent,
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceTool,
  RealtimeVoiceToolResultOptions,
} from "openclaw/plugin-sdk/realtime-voice";
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import {
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import {
  asFiniteNumber,
  asOptionalRecord as asObjectRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import WebSocket from "ws";

type QwenTurnDetectionType = "server_vad" | "semantic_vad";

type QwenRealtimeVoiceProviderConfig = {
  apiKey?: string;
  model?: string;
  voice?: string;
  temperature?: number;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  interruptResponseOnInputAudio?: boolean;
  minBargeInAudioEndMs?: number;
  turnDetectionType?: QwenTurnDetectionType;
  baseUrl?: string;
};

type QwenRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest &
  QwenRealtimeVoiceProviderConfig;

// 必须用 3.5 系列：qwen3-omni-flash-realtime(3.0)在 realtime 下不支持 tools(session.update
// 里的 tools 被静默丢弃 → 模型永不发 function_call → agent-consult 失效)。3.5 才认 tools。
const QWEN_REALTIME_DEFAULT_MODEL = "qwen3.5-omni-flash-realtime";
const QWEN_REALTIME_DEFAULT_VOICE = "Ethan";
// 用户侧输入转写模型。DashScope realtime 默认不开转写，须在 session.update 显式声明，否则
// input_audio_transcription.* 事件永不到达（用户字幕恒空）。值取自官方文档 qwen-omni-realtime。
const QWEN_REALTIME_INPUT_TRANSCRIPTION_MODEL = "qwen3-asr-flash-realtime";
// Qwen 为 OpenAI-Realtime 兼容协议，沿用同样的错误文案做恢复（best-effort，字符串以真机为准）。
const QWEN_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  "Conversation already has an active response in progress:";
const QWEN_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  "Cancellation failed: no active response found";
// Beijing endpoint. Singapore: wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime
const QWEN_REALTIME_DEFAULT_WS_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const QWEN_REALTIME_RELAY_SAMPLE_RATE_HZ = 24000;
const QWEN_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
const QWEN_REALTIME_API_KEY_REQUIRED = "Qwen realtime voice requires a DashScope API key";
// 投递工具结果时的本次响应专属 instructions:强制 qwen 读结果,防止异步结果回来时被中途插话
// 搅乱、qwen 顺着最新上下文乱答或重复垫话。
const DELIVER_TOOL_RESULT_INSTRUCTIONS =
  "OpenClaw 刚刚返回了工具结果。请把这个结果自然地用中文口语读给用户;不要再说“请稍等/正在安排”之类的等待垫话,也不要顺着其它话题另起回答,直接讲结果内容。";
const CONTINUE_AFTER_SILENT_SIDE_EFFECT_INSTRUCTIONS =
  "继续自然完成当前对用户的语音回复。不要提及刚才的工具、工具参数、工具结果、表情或内部执行状态。";

export function supportsQwenRealtimeToolCalls(model: string | undefined): boolean {
  return /^qwen3\.5-omni-(?:flash|plus)-realtime(?:-\d{4}-\d{2}-\d{2})?$/.test(
    model ?? QWEN_REALTIME_DEFAULT_MODEL,
  );
}

export function toQwenRealtimeTools(tools: RealtimeVoiceTool[]): Array<{
  type: "function";
  function: Omit<RealtimeVoiceTool, "type">;
}> {
  return tools.map(({ type: _type, ...tool }) => ({
    type: "function",
    function: tool,
  }));
}

export function resolveQwenToolResultResponsePolicy(
  options: RealtimeVoiceToolResultOptions | undefined,
): { respond: boolean; cancelActive: boolean; instructions?: string } {
  if (options?.willContinue === true || options?.suppressResponse === true) {
    return { respond: false, cancelActive: false };
  }
  if (options?.responseMode === "silent-side-effect") {
    return {
      respond: true,
      cancelActive: false,
      instructions: CONTINUE_AFTER_SILENT_SIDE_EFFECT_INSTRUCTIONS,
    };
  }
  return {
    respond: true,
    cancelActive: true,
    instructions: DELIVER_TOOL_RESULT_INSTRUCTIONS,
  };
}

type RealtimeEvent = {
  type: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
  };
  error?: unknown;
};

type QwenTurnDetectionConfig = {
  type: QwenTurnDetectionType;
  threshold: number;
  prefix_padding_ms: number;
  silence_duration_ms: number;
  create_response: boolean;
  interrupt_response: boolean;
};

function readRealtimeErrorDetail(error: unknown): string {
  if (typeof error === "string" && error) {
    return error;
  }
  const message = asObjectRecord(error)?.message;
  return typeof message === "string" && message ? message : "Unknown error";
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function asUnitInterval(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && number >= 0 && number <= 1 ? number : undefined;
}

function resolveQwenProviderConfigRecord(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const providers = asObjectRecord(config.providers);
  return asObjectRecord(providers?.qwen) ?? asObjectRecord(config.qwen) ?? asObjectRecord(config);
}

function normalizeQwenTurnDetectionType(value: unknown): QwenTurnDetectionType | undefined {
  return value === "semantic_vad" || value === "server_vad" ? value : undefined;
}

function normalizeProviderConfig(
  config: RealtimeVoiceProviderConfig,
): QwenRealtimeVoiceProviderConfig {
  const raw = resolveQwenProviderConfigRecord(config);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "talk.realtime.providers.qwen.apiKey",
    }),
    model: trimToUndefined(raw?.model),
    voice: trimToUndefined(raw?.speakerVoice ?? raw?.voice),
    temperature: asFiniteNumber(raw?.temperature),
    vadThreshold: asUnitInterval(raw?.vadThreshold),
    silenceDurationMs: asNonNegativeInteger(raw?.silenceDurationMs),
    prefixPaddingMs: asNonNegativeInteger(raw?.prefixPaddingMs),
    interruptResponseOnInputAudio:
      typeof raw?.interruptResponseOnInputAudio === "boolean"
        ? raw.interruptResponseOnInputAudio
        : undefined,
    minBargeInAudioEndMs: asNonNegativeInteger(raw?.minBargeInAudioEndMs),
    turnDetectionType: normalizeQwenTurnDetectionType(raw?.turnDetectionType),
    baseUrl: trimToUndefined(raw?.baseUrl),
  };
}

// DashScope realtime shares the Qwen key. Prefer the realtime provider config, then
// the env keys the qwen provider already documents (see openclaw.plugin.json setup).
function resolveQwenRealtimeApiKey(config: QwenRealtimeVoiceProviderConfig): string | undefined {
  return (
    config.apiKey ??
    normalizeSecretInputString(process.env.DASHSCOPE_API_KEY) ??
    normalizeSecretInputString(process.env.QWEN_API_KEY) ??
    normalizeSecretInputString(process.env.MODELSTUDIO_API_KEY)
  );
}

function hasQwenRealtimeApiKeyInput(config: QwenRealtimeVoiceProviderConfig): boolean {
  return Boolean(resolveQwenRealtimeApiKey(config));
}

function base64ToBuffer(b64: string): Buffer {
  return Buffer.from(b64, "base64");
}

class QwenRealtimeVoiceBridge implements RealtimeVoiceBridge {
  private static readonly DEFAULT_MODEL = QWEN_REALTIME_DEFAULT_MODEL;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_RECONNECT_DELAY_MS = 1000;
  private static readonly CONNECT_TIMEOUT_MS = 10_000;
  // false:关闭两段式(working 占位 + final 结果)。DashScope Qwen 会把先到的"working"占位
  // function_call_output 当作该工具调用的最终答复(念完"Let me check"就结束该轮),之后给同一
  // callId 的真结果被视为"已答复"→ 生成空响应、不念结果。故只投递单个真结果,让 qwen 正常朗读。
  // 代价:consult 期间不再有"稍等"占位提示,静默等结果。
  readonly supportsToolResultContinuation = false;

  private ws: WebSocket | null = null;
  private connected = false;
  private sessionConfigured = false;
  private intentionallyClosed = false;
  private reconnectAttempts = 0;
  // 重连退避定时器 + 其 resolve —— close() 时取消定时器并立即解阻塞 await，
  // 避免挂断后仍挂着最长 ~16s 的定时器/promise 链。
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectResolve: (() => void) | null = null;
  private pendingAudio: Buffer[] = [];
  private markQueue: string[] = [];
  private responseStartTimestamp: number | null = null;
  private responseActive = false;
  private responseCreateInFlight = false;
  private responseCancelInFlight = false;
  private responseCreatePending = false;
  private discardResponseAfterCreate = false;
  // 本次 response.create 专属 instructions(投递工具结果时用,强制 qwen 读结果而非顺着最新上下文乱答);
  // 沿 pending 链保留,flush 时仍生效。
  private pendingResponseInstructions: string | undefined;
  private continuingToolCallIds = new Set<string>();
  private latestMediaTimestamp = 0;
  private lastAssistantItemId: string | null = null;
  private connectionUrl = "";
  private toolCallBuffers = new Map<string, { name: string; callId: string; args: string }>();
  private deliveredToolCallKeys = new Set<string>();
  private readonly flowId = randomUUID();
  private sessionReadyFired = false;
  // Leftover input samples (<3) carried across sendAudio chunks so the 3:2
  // downsample stays phase-aligned instead of clicking at chunk boundaries.
  private resampleCarry: number[] = [];
  private readonly audioFormat: RealtimeVoiceAudioFormat;

  constructor(private readonly config: QwenRealtimeVoiceBridgeConfig) {
    this.audioFormat = config.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ;
  }

  async connect(): Promise<void> {
    this.intentionallyClosed = false;
    this.reconnectAttempts = 0;
    await this.doConnect();
  }

  sendAudio(audio: Buffer): void {
    const resampled = this.downsampleToQwenInput(audio);
    if (resampled.length === 0) {
      return;
    }
    if (!this.connected || !this.sessionConfigured || this.ws?.readyState !== WebSocket.OPEN) {
      if (this.pendingAudio.length < 320) {
        this.pendingAudio.push(resampled);
      }
      return;
    }
    this.appendInputAudio(resampled);
  }

  setMediaTimestamp(ts: number): void {
    this.latestMediaTimestamp = ts;
  }

  sendUserMessage(text: string): void {
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.requestResponseCreate();
  }

  triggerGreeting(instructions?: string): void {
    if (!this.isConnected() || !this.ws) {
      return;
    }
    this.sendUserMessage(instructions ?? this.config.instructions ?? "Greet the caller.");
  }

  submitToolResult(
    callId: string,
    result: unknown,
    options?: RealtimeVoiceToolResultOptions,
  ): void {
    const resultStr = JSON.stringify(result);
    this.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: resultStr,
      },
    });
    const responsePolicy = resolveQwenToolResultResponsePolicy(options);
    if (options?.willContinue === true) {
      this.continuingToolCallIds.add(callId);
      return;
    }
    this.continuingToolCallIds.delete(callId);
    if (!responsePolicy.respond) {
      return;
    }
    // 异步结果回来时,若期间被插话搅乱、qwen 正忙别的响应 → 先取消,让"读结果"这轮接管。
    if (responsePolicy.cancelActive && this.responseActive && !this.responseCancelInFlight) {
      this.sendEvent({ type: "response.cancel" }, "reason=deliver-tool-result");
      this.responseCancelInFlight = true;
    }
    // 强制本轮读结果:带本次响应专属 instructions,钉死在"读工具结果"、不许再垫话/顺着最新上下文乱答。
    this.requestResponseCreate(responsePolicy.instructions);
  }

  acknowledgeMark(): void {
    if (this.markQueue.length === 0) {
      return;
    }
    this.markQueue.shift();
  }

  close(): void {
    this.intentionallyClosed = true;
    this.connected = false;
    this.sessionConfigured = false;
    // 取消待触发的重连退避,并解阻塞 attemptReconnect 的 await(其后 intentionallyClosed 守卫直接返回)。
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectResolve) {
      this.reconnectResolve();
      this.reconnectResolve = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Bridge closed");
      this.ws = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.sessionConfigured;
  }

  // 24kHz (relay) -> 16kHz (Qwen input) via 3:2 linear decimation on PCM16 mono.
  private downsampleToQwenInput(input: Buffer): Buffer {
    if (
      this.audioFormat.encoding !== "pcm16" ||
      this.audioFormat.sampleRateHz !== QWEN_REALTIME_RELAY_SAMPLE_RATE_HZ
    ) {
      return input;
    }
    const samples = this.resampleCarry;
    for (let i = 0; i + 1 < input.length; i += 2) {
      samples.push(input.readInt16LE(i));
    }
    const groups = Math.floor(samples.length / 3);
    const out = Buffer.allocUnsafe(groups * 4);
    let o = 0;
    for (let g = 0; g < groups; g += 1) {
      const base = g * 3;
      out.writeInt16LE(samples[base], o);
      out.writeInt16LE((samples[base + 1] + samples[base + 2]) >> 1, o + 2);
      o += 4;
    }
    this.resampleCarry = samples.slice(groups * 3);
    return out;
  }

  private appendInputAudio(audio: Buffer): void {
    this.sendEvent({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  private async doConnect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let startupFailureClosing = false;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };
      const connectTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
        if (!this.sessionConfigured && !this.intentionallyClosed) {
          startupFailureClosing = true;
          this.ws?.terminate();
          settleReject(new Error("Qwen realtime connection timeout"));
        }
      }, QwenRealtimeVoiceBridge.CONNECT_TIMEOUT_MS);

      let connection: { url: string; headers: Record<string, string> };
      try {
        connection = this.resolveConnectionParams();
      } catch (error) {
        settleReject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (this.intentionallyClosed) {
        settleResolve();
        return;
      }

      const url = connection.url;
      this.connectionUrl = url;
      const proxyAgent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
      const ws = new WebSocket(url, {
        headers: connection.headers,
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      });
      this.ws = ws;

      const rejectStartup = (error: Error) => {
        startupFailureClosing = true;
        settleReject(error);
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.close(1000, "startup failed");
        }
      };

      ws.on("open", () => {
        this.resetRealtimeSessionState();
        this.connected = true;
        this.sessionConfigured = false;
        this.reconnectAttempts = 0;
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-open",
          flowId: this.flowId,
          meta: { provider: "qwen", capability: "realtime-voice" },
        });
        this.sendSessionUpdate();
      });

      ws.on("message", (data: Buffer) => {
        if (settled && !this.sessionConfigured) {
          return;
        }
        captureWsEvent({
          url,
          direction: "inbound",
          kind: "ws-frame",
          flowId: this.flowId,
          payload: data,
          meta: { provider: "qwen", capability: "realtime-voice" },
        });
        try {
          const event = JSON.parse(data.toString()) as RealtimeEvent;
          if (event.type === "error" && !this.sessionConfigured) {
            rejectStartup(new Error(readRealtimeErrorDetail(event.error)));
            return;
          }
          this.handleEvent(event);
          if (event.type === "session.updated") {
            settleResolve();
          }
        } catch (error) {
          console.error("[qwen] realtime event parse failed:", error);
        }
      });

      ws.on("error", (error) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "error",
          flowId: this.flowId,
          errorText: error instanceof Error ? error.message : String(error),
          meta: { provider: "qwen", capability: "realtime-voice" },
        });
        if (!this.sessionConfigured) {
          rejectStartup(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      });

      ws.on("close", (code, reasonBuffer) => {
        captureWsEvent({
          url,
          direction: "local",
          kind: "ws-close",
          flowId: this.flowId,
          closeCode: typeof code === "number" ? code : undefined,
          meta: {
            provider: "qwen",
            capability: "realtime-voice",
            reason:
              Buffer.isBuffer(reasonBuffer) && reasonBuffer.length > 0
                ? reasonBuffer.toString("utf8")
                : undefined,
          },
        });
        if (startupFailureClosing) {
          if (this.ws === ws) {
            this.connected = false;
            this.sessionConfigured = false;
          }
          return;
        }
        const wasSessionConfigured = this.sessionConfigured;
        this.connected = false;
        this.sessionConfigured = false;
        if (this.intentionallyClosed) {
          settleResolve();
          this.config.onClose?.("completed");
          return;
        }
        if (!wasSessionConfigured && !settled) {
          settleReject(new Error("Qwen realtime connection closed before ready"));
          return;
        }
        void this.attemptReconnect("websocket-close");
      });
    });
  }

  private resolveConnectionParams(): { url: string; headers: Record<string, string> } {
    const cfg = this.config;
    const apiKey = resolveQwenRealtimeApiKey(cfg);
    if (!apiKey) {
      throw new Error(QWEN_REALTIME_API_KEY_REQUIRED);
    }
    const model = cfg.model ?? QwenRealtimeVoiceBridge.DEFAULT_MODEL;
    const base = (cfg.baseUrl ?? QWEN_REALTIME_DEFAULT_WS_BASE).replace(/\/$/, "");
    return {
      url: `${base}?model=${encodeURIComponent(model)}`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    };
  }

  private async attemptReconnect(reason: string): Promise<void> {
    if (this.intentionallyClosed) {
      return;
    }
    if (this.reconnectAttempts >= QwenRealtimeVoiceBridge.MAX_RECONNECT_ATTEMPTS) {
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.exhausted",
        detail: `reason=${reason} attempts=${this.reconnectAttempts}`,
      });
      this.config.onClose?.("error");
      return;
    }
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    const delay = QwenRealtimeVoiceBridge.BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1);
    this.config.onEvent?.({
      direction: "client",
      type: "session.reconnect.scheduled",
      detail: `reason=${reason} attempt=${attempt} delayMs=${delay}`,
    });
    await new Promise<void>((resolve) => {
      this.reconnectResolve = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectResolve = null;
        resolve();
      }, delay);
    });
    if (this.intentionallyClosed) {
      return;
    }
    try {
      await this.doConnect();
      this.config.onEvent?.({
        direction: "client",
        type: "session.reconnect.ready",
        detail: `reason=${reason} attempt=${attempt}`,
      });
    } catch (error) {
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
      await this.attemptReconnect(reason);
    }
  }

  private buildTurnDetection(): QwenTurnDetectionConfig {
    const cfg = this.config;
    const autoRespond = cfg.autoRespondToAudio ?? true;
    return {
      type: cfg.turnDetectionType ?? "server_vad",
      threshold: cfg.vadThreshold ?? 0.5,
      prefix_padding_ms: cfg.prefixPaddingMs ?? 300,
      silence_duration_ms: cfg.silenceDurationMs ?? 500,
      create_response: autoRespond,
      interrupt_response: cfg.interruptResponseOnInputAudio ?? autoRespond,
    };
  }

  private sendSessionUpdate(): void {
    const cfg = this.config;
    this.sendEvent({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: cfg.instructions,
        voice: cfg.voice ?? QWEN_REALTIME_DEFAULT_VOICE,
        // Qwen realtime is PCM16 (16kHz in / 24kHz out). "pcm16" is the OpenAI-compat
        // value; if session.update is rejected, DashScope docs also show "pcm" — flip
        // this pair and rebuild (tracked as the live-verify step).
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        // 显式开用户侧转写，否则 conversation.item.input_audio_transcription.* 不下发（字幕恒空）。
        input_audio_transcription: { model: QWEN_REALTIME_INPUT_TRANSCRIPTION_MODEL },
        turn_detection: this.buildTurnDetection(),
        temperature: cfg.temperature ?? 0.8,
        ...(cfg.tools && cfg.tools.length > 0 ? { tools: toQwenRealtimeTools(cfg.tools) } : {}),
      },
    });
  }

  private handleEvent(event: RealtimeEvent): void {
    if (this.discardResponseAfterCreate) {
      if (event.type === "response.created") {
        this.responseActive = true;
        this.responseCreateInFlight = false;
        if (!this.responseCancelInFlight) {
          this.sendEvent({ type: "response.cancel" }, "reason=discard-barge-in-response");
          this.responseCancelInFlight = true;
        }
        return;
      }
      if (event.type === "response.cancelled" || event.type === "response.done") {
        this.responseActive = false;
        this.responseCreateInFlight = false;
        this.responseCancelInFlight = false;
        this.discardResponseAfterCreate = false;
        this.flushPendingResponseCreate();
        return;
      }
      if (
        event.type.startsWith("response.") ||
        event.type.startsWith("conversation.output_audio.") ||
        (event.type === "conversation.item.done" && event.item?.type === "function_call")
      ) {
        return;
      }
    }
    this.config.onEvent?.({
      direction: "server",
      type: event.type,
      detail: this.describeServerEvent(event),
      ...(event.item_id ? { itemId: event.item_id } : {}),
      ...((event.response_id ?? event.response?.id)
        ? { responseId: event.response_id ?? event.response?.id }
        : {}),
    });
    switch (event.type) {
      case "session.created":
        return;

      case "session.updated":
        this.sessionConfigured = true;
        for (const chunk of this.pendingAudio.splice(0)) {
          this.appendInputAudio(chunk);
        }
        if (!this.sessionReadyFired) {
          this.sessionReadyFired = true;
          this.config.onReady?.();
        }
        return;

      case "response.created":
        this.responseActive = true;
        this.responseCreateInFlight = false;
        return;

      case "conversation.output_audio.delta":
      case "response.audio.delta":
      case "response.output_audio.delta": {
        const audioDelta = event.delta ?? event.data;
        if (!audioDelta) {
          return;
        }
        this.config.onAudio(base64ToBuffer(audioDelta));
        if (event.item_id && event.item_id !== this.lastAssistantItemId) {
          this.lastAssistantItemId = event.item_id;
          this.responseStartTimestamp = this.latestMediaTimestamp;
        } else if (this.responseStartTimestamp === null) {
          this.responseStartTimestamp = this.latestMediaTimestamp;
        }
        this.responseActive = true;
        this.sendMark();
        return;
      }

      case "input_audio_buffer.speech_started":
        if (this.config.interruptResponseOnInputAudio ?? this.config.autoRespondToAudio ?? true) {
          // barge-in:qwen 生成很快、常在用户开口前就 response.done,此时 app 仍在放排队的缓冲音频。
          // responseActive=true(还在生成)→ 走完整打断(response.cancel + truncate + 清 app 缓冲);
          // responseActive=false(已生成完,只剩 app 缓冲在放)→ 直接清 app 缓冲,让用户插话立即生效。
          if (this.responseActive || this.responseCreateInFlight) {
            this.handleBargeIn({ audioPlaybackActive: true });
          } else {
            this.config.onClearAudio();
          }
        }
        return;

      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
      case "response.output_text.delta":
        if (event.delta) {
          this.config.onTranscript?.("assistant", event.delta, false);
        }
        return;

      case "response.audio_transcript.done":
      case "response.output_audio_transcript.done":
      case "response.output_text.done": {
        const transcript = event.transcript ?? event.text;
        if (transcript) {
          this.config.onTranscript?.("assistant", transcript, true);
        }
        return;
      }

      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          this.config.onTranscript?.("user", event.delta, false);
        }
        return;

      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.config.onTranscript?.("user", event.transcript, true);
        }
        return;

      case "response.cancelled":
      case "response.done":
        this.responseActive = false;
        this.responseCreateInFlight = false;
        this.responseCancelInFlight = false;
        this.discardResponseAfterCreate = false;
        this.flushPendingResponseCreate();
        return;

      case "response.function_call_arguments.delta": {
        const key = event.item_id ?? "unknown";
        const existing = this.toolCallBuffers.get(key);
        if (existing && event.delta) {
          existing.args += event.delta;
        } else if (event.item_id) {
          this.toolCallBuffers.set(event.item_id, {
            name: event.name ?? "",
            callId: event.call_id ?? "",
            args: event.delta ?? "",
          });
        }
        return;
      }

      case "response.function_call_arguments.done": {
        const key = event.item_id ?? "unknown";
        const buffered = this.toolCallBuffers.get(key);
        this.emitToolCallOnce({
          itemId: event.item_id,
          callId: buffered?.callId || event.call_id,
          name: buffered?.name || event.name,
          rawArgs: buffered?.args || event.arguments,
        });
        this.toolCallBuffers.delete(key);
        return;
      }

      case "conversation.item.done": {
        if (event.item?.type !== "function_call") {
          return;
        }
        this.emitToolCallOnce({
          itemId: event.item.id ?? event.item_id,
          callId: event.item.call_id ?? event.call_id ?? event.item.id ?? event.item_id,
          name: event.item.name ?? event.name,
          rawArgs: event.item.arguments ?? event.arguments,
        });
        return;
      }

      case "error": {
        const detail = readRealtimeErrorDetail(event.error);
        // 响应已在进行：重同步 responseActive，别把这轮吞掉。
        if (detail.startsWith(QWEN_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX)) {
          this.responseActive = true;
          this.responseCreateInFlight = false;
          this.responseCreatePending = true;
          break;
        }
        // barge-in 竞态：cancel 时响应已结束 → 无后续 response.done 清标志。
        // 必须在此清 responseCancelInFlight 并 flush，否则之后每轮只置 pending、
        // 永不发 response.create → AI 通话中途永久静音。
        if (detail === QWEN_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR) {
          this.responseActive = false;
          this.responseCancelInFlight = false;
          this.discardResponseAfterCreate = false;
          this.flushPendingResponseCreate();
          break;
        }
        this.config.onError?.(new Error(detail));
        break;
      }

      default:
        break;
    }
  }

  handleBargeIn(options?: RealtimeVoiceBargeInOptions): void {
    // handleBargeIn 的调用者都代表真实用户打断；内部工具续答的 response.cancel 走独立路径。
    // 因此默认丢弃旧响应排队的 continuation，避免 VAD speech_started 把它重新刷出来。
    if (options?.discardPendingResponse !== false) {
      this.responseCreatePending = false;
      this.pendingResponseInstructions = undefined;
      this.continuingToolCallIds.clear();
      if (this.responseCreateInFlight) {
        this.discardResponseAfterCreate = true;
      }
    }
    const assistantItemId = this.lastAssistantItemId;
    const responseStartTimestamp = this.responseStartTimestamp;
    const force = options?.force === true;
    const shouldInterruptProvider =
      assistantItemId !== null &&
      ((responseStartTimestamp !== null &&
        (this.markQueue.length > 0 || options?.audioPlaybackActive === true)) ||
        force);
    const audioEndMs = shouldInterruptProvider
      ? Math.max(
          0,
          responseStartTimestamp === null
            ? this.latestMediaTimestamp
            : this.latestMediaTimestamp - responseStartTimestamp,
        )
      : null;
    const minBargeInAudioEndMs =
      this.config.minBargeInAudioEndMs ?? QWEN_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS;
    if (!force && audioEndMs !== null && audioEndMs < minBargeInAudioEndMs) {
      this.config.onEvent?.({
        direction: "client",
        type: "conversation.item.truncate.skipped",
        detail: `reason=barge-in audioEndMs=${audioEndMs} minAudioEndMs=${minBargeInAudioEndMs}`,
      });
      return;
    }
    if (
      options?.audioPlaybackActive === true &&
      this.responseActive &&
      !this.responseCancelInFlight
    ) {
      this.sendEvent({ type: "response.cancel" }, "reason=barge-in");
      this.responseCancelInFlight = true;
    }
    if (shouldInterruptProvider) {
      this.sendEvent(
        {
          type: "conversation.item.truncate",
          item_id: assistantItemId,
          content_index: 0,
          audio_end_ms: audioEndMs,
        },
        `reason=barge-in audioEndMs=${audioEndMs}`,
      );
      this.config.onClearAudio();
      this.markQueue = [];
      this.lastAssistantItemId = null;
      this.responseStartTimestamp = null;
      return;
    }
    this.config.onClearAudio();
  }

  private emitToolCallOnce(fields: {
    itemId?: string;
    callId?: string;
    name?: string;
    rawArgs?: string;
  }): void {
    if (!this.config.onToolCall) {
      return;
    }
    const itemId = fields.itemId || fields.callId || "unknown";
    const callId = fields.callId || itemId;
    const name = fields.name || "";
    const dedupeKey = fields.itemId || fields.callId || `${name}:${fields.rawArgs ?? ""}`;
    if (this.deliveredToolCallKeys.has(dedupeKey)) {
      return;
    }
    this.deliveredToolCallKeys.add(dedupeKey);
    let args: unknown = {};
    try {
      args = JSON.parse(fields.rawArgs || "{}");
    } catch {}
    this.config.onToolCall({ itemId, callId, name, args });
  }

  private requestResponseCreate(instructions?: string): void {
    if (instructions) {
      this.pendingResponseInstructions = instructions; // 沿 pending 链保留到真正发出
    }
    if (
      this.responseActive ||
      this.responseCreateInFlight ||
      this.responseCancelInFlight ||
      this.continuingToolCallIds.size > 0
    ) {
      this.responseCreatePending = true;
      return;
    }
    this.responseCreatePending = false;
    this.responseCreateInFlight = true;
    const perResponse = this.pendingResponseInstructions;
    this.pendingResponseInstructions = undefined;
    this.sendEvent(
      perResponse
        ? { type: "response.create", response: { instructions: perResponse } }
        : { type: "response.create" },
    );
  }

  private flushPendingResponseCreate(): void {
    if (!this.responseCreatePending) {
      return;
    }
    this.responseCreatePending = false;
    this.requestResponseCreate();
  }

  private resetRealtimeSessionState(): void {
    this.markQueue = [];
    // 注意：故意不清 pendingAudio。重连(每次 open 都走此)期间用户可能已在说话，
    // 这些缓冲要留到新会话 session.updated 后 flush(594 行),否则重连后首字被切。
    // 有 320 chunk 上限(223 行)兜底,不会无界增长。
    this.resampleCarry = [];
    this.responseStartTimestamp = null;
    this.responseActive = false;
    this.responseCreateInFlight = false;
    this.responseCancelInFlight = false;
    this.responseCreatePending = false;
    this.discardResponseAfterCreate = false;
    this.continuingToolCallIds.clear();
    this.lastAssistantItemId = null;
    this.toolCallBuffers.clear();
    this.deliveredToolCallKeys.clear();
  }

  private sendMark(): void {
    const markName = `audio-${this.markQueue.length}-${this.latestMediaTimestamp}`;
    this.markQueue.push(markName);
    this.config.onMark?.(markName);
  }

  private sendEvent(event: unknown, detail?: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    const type =
      event && typeof event === "object" && typeof (event as { type?: unknown }).type === "string"
        ? (event as { type: string }).type
        : "unknown";
    this.config.onEvent?.({ direction: "client", type, ...(detail ? { detail } : {}) });
    const payload = JSON.stringify(event);
    captureWsEvent({
      url: this.connectionUrl,
      direction: "outbound",
      kind: "ws-frame",
      flowId: this.flowId,
      payload,
      meta: { provider: "qwen", capability: "realtime-voice" },
    });
    this.ws.send(payload);
  }

  private describeServerEvent(event: RealtimeEvent): string | undefined {
    if (event.type === "error") {
      return readRealtimeErrorDetail(event.error);
    }
    if (event.type === "response.done") {
      const status = event.response?.status;
      const details =
        event.response?.status_details === undefined
          ? undefined
          : JSON.stringify(event.response.status_details);
      return (
        [status ? `status=${status}` : undefined, details].filter(Boolean).join(" ") || undefined
      );
    }
    if (event.type === "conversation.item.done" && event.item?.type) {
      return [event.item.type, event.item.name ? `name=${event.item.name}` : undefined]
        .filter(Boolean)
        .join(" ");
    }
    return undefined;
  }
}

export function buildQwenRealtimeVoiceProvider(): RealtimeVoiceProviderPlugin {
  return {
    id: "qwen",
    label: "Qwen-Omni Realtime Voice",
    defaultModel: QWEN_REALTIME_DEFAULT_MODEL,
    autoSelectOrder: 30,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      supportsBargeIn: true,
      supportsToolCalls: true,
      supportsToolCallsForModel: supportsQwenRealtimeToolCalls,
    },
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    isConfigured: ({ providerConfig }) =>
      hasQwenRealtimeApiKeyInput(normalizeProviderConfig(providerConfig)),
    createBridge: (req) => {
      const config = normalizeProviderConfig(req.providerConfig);
      return new QwenRealtimeVoiceBridge({
        ...req,
        apiKey: config.apiKey,
        model: config.model,
        voice: config.voice,
        temperature: config.temperature,
        vadThreshold: config.vadThreshold,
        silenceDurationMs: config.silenceDurationMs,
        prefixPaddingMs: config.prefixPaddingMs,
        interruptResponseOnInputAudio:
          req.interruptResponseOnInputAudio ?? config.interruptResponseOnInputAudio,
        minBargeInAudioEndMs: config.minBargeInAudioEndMs,
        turnDetectionType: config.turnDetectionType,
        baseUrl: config.baseUrl,
      });
    },
  };
}
