// Qwen-Audio-TTS speech provider: wraps the DashScope tts_v2 duplex WebSocket
// so cloned/system Qwen voices are usable as an OpenClaw TTS provider (e.g. the
// TTS leg of an ASR->LLM->TTS `stt-tts` talk session).
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  SpeechProviderPlugin,
} from "openclaw/plugin-sdk/speech-core";
import {
  asObject,
  parseSpeechDirectiveNumberOverride,
  trimToUndefined,
} from "openclaw/plugin-sdk/speech-core";
import { asFiniteNumberInRange } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_QWEN_AUDIO_TTS_MODEL,
  DEFAULT_QWEN_AUDIO_TTS_REGION,
  QWEN_AUDIO_TTS_MODELS,
  qwenAudioTTS,
} from "./tts.js";

const TELEPHONY_SAMPLE_RATE = 24_000;

type QwenAudioTtsProviderConfig = {
  apiKey?: string;
  workspace?: string;
  baseUrl?: string;
  region: string;
  voiceId?: string;
  modelId: string;
  instruction?: string;
  speechRate?: number;
  pitchRate?: number;
  volume?: number;
};

type QwenAudioTtsProviderOverrides = {
  voiceId?: string;
  modelId?: string;
  instruction?: string;
  speechRate?: number;
  pitchRate?: number;
  volume?: number;
};

const normRate = (value: unknown): number | undefined =>
  asFiniteNumberInRange(value, { min: 0.5, max: 2 });
const normVolume = (value: unknown): number | undefined =>
  asFiniteNumberInRange(value, { min: 0, max: 100 });

function normalizeProviderConfig(rawConfig: Record<string, unknown>): QwenAudioTtsProviderConfig {
  const providers = asObject(rawConfig.providers);
  const raw = asObject(providers?.["qwen-audio-tts"]) ?? asObject(rawConfig["qwen-audio-tts"]);
  return {
    apiKey: normalizeResolvedSecretInputString({
      value: raw?.apiKey,
      path: "messages.tts.providers.qwen-audio-tts.apiKey",
    }),
    workspace: trimToUndefined(raw?.workspace),
    baseUrl: trimToUndefined(raw?.baseUrl),
    region: trimToUndefined(raw?.region) ?? DEFAULT_QWEN_AUDIO_TTS_REGION,
    voiceId: trimToUndefined(raw?.voiceId ?? raw?.voice),
    modelId: trimToUndefined(raw?.modelId ?? raw?.model) ?? DEFAULT_QWEN_AUDIO_TTS_MODEL,
    instruction: trimToUndefined(raw?.instruction),
    speechRate: normRate(raw?.speechRate ?? raw?.rate),
    pitchRate: normRate(raw?.pitchRate ?? raw?.pitch),
    volume: normVolume(raw?.volume),
  };
}

function readProviderConfig(config: SpeechProviderConfig): QwenAudioTtsProviderConfig {
  const defaults = normalizeProviderConfig({});
  return {
    apiKey: trimToUndefined(config.apiKey) ?? defaults.apiKey ?? process.env.DASHSCOPE_API_KEY,
    workspace: trimToUndefined(config.workspace) ?? defaults.workspace,
    baseUrl: trimToUndefined(config.baseUrl) ?? defaults.baseUrl,
    region: trimToUndefined(config.region) ?? defaults.region,
    voiceId: trimToUndefined(config.voiceId ?? config.voice) ?? defaults.voiceId,
    modelId: trimToUndefined(config.modelId ?? config.model) ?? defaults.modelId,
    instruction: trimToUndefined(config.instruction) ?? defaults.instruction,
    speechRate: normRate(config.speechRate ?? config.rate) ?? defaults.speechRate,
    pitchRate: normRate(config.pitchRate ?? config.pitch) ?? defaults.pitchRate,
    volume: normVolume(config.volume) ?? defaults.volume,
  };
}

function readOverrides(
  overrides: SpeechProviderOverrides | undefined,
): QwenAudioTtsProviderOverrides {
  if (!overrides) {
    return {};
  }
  return {
    voiceId: trimToUndefined(overrides.voiceId ?? overrides.voice),
    modelId: trimToUndefined(overrides.modelId ?? overrides.model),
    instruction: trimToUndefined(overrides.instruction),
    speechRate: normRate(overrides.speechRate ?? overrides.rate),
    pitchRate: normRate(overrides.pitchRate ?? overrides.pitch),
    volume: normVolume(overrides.volume),
  };
}

function isConfigured(config: QwenAudioTtsProviderConfig): boolean {
  return Boolean(config.apiKey && config.workspace && config.voiceId);
}

function parseDirectiveToken(ctx: SpeechDirectiveTokenParseContext): {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
} {
  switch (ctx.key) {
    case "voice":
    case "voiceid":
    case "voice_id":
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      return { handled: true, overrides: { voiceId: ctx.value } };
    case "model":
    case "modelid":
    case "model_id":
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      return { handled: true, overrides: { modelId: ctx.value } };
    case "instruction":
      return { handled: true, overrides: { instruction: ctx.value } };
    case "rate":
    case "speech_rate":
    case "speechrate":
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "speechRate",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid Qwen-Audio-TTS rate "${value}"`,
      });
    case "pitch":
    case "pitch_rate":
    case "pitchrate":
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: "pitchRate",
        range: { min: 0.5, max: 2 },
        warning: (value) => `invalid Qwen-Audio-TTS pitch "${value}"`,
      });
    default:
      return { handled: false };
  }
}

export function buildQwenAudioTtsSpeechProvider(): SpeechProviderPlugin {
  const requireReady = (config: QwenAudioTtsProviderConfig): void => {
    if (!config.apiKey) {
      throw new Error("Qwen-Audio-TTS requires a DashScope API key");
    }
    if (!config.workspace) {
      throw new Error("Qwen-Audio-TTS requires a Bailian workspace id");
    }
    if (!config.voiceId) {
      throw new Error("Qwen-Audio-TTS requires a voice id");
    }
  };

  return {
    id: "qwen-audio-tts",
    label: "Qwen-Audio-TTS",
    autoSelectOrder: 35,
    defaultModel: DEFAULT_QWEN_AUDIO_TTS_MODEL,
    models: QWEN_AUDIO_TTS_MODELS,
    resolveConfig: ({ rawConfig }) => normalizeProviderConfig(rawConfig),
    parseDirectiveToken,
    isConfigured: ({ providerConfig }) => isConfigured(readProviderConfig(providerConfig)),
    synthesize: async (req) => {
      const config = readProviderConfig(req.providerConfig);
      const overrides = readOverrides(req.providerOverrides);
      requireReady(config);
      const audioBuffer = await qwenAudioTTS({
        text: req.text,
        apiKey: config.apiKey!,
        workspace: config.workspace!,
        baseUrl: config.baseUrl,
        region: config.region,
        model: overrides.modelId ?? config.modelId,
        voice: overrides.voiceId ?? config.voiceId!,
        format: "mp3",
        sampleRate: 24_000,
        instruction: overrides.instruction ?? config.instruction,
        speechRate: overrides.speechRate ?? config.speechRate,
        pitchRate: overrides.pitchRate ?? config.pitchRate,
        volume: overrides.volume ?? config.volume,
        timeoutMs: req.timeoutMs,
      });
      return { audioBuffer, outputFormat: "mp3", fileExtension: ".mp3", voiceCompatible: false };
    },
    synthesizeTelephony: async (req) => {
      const config = readProviderConfig(req.providerConfig);
      const overrides = readOverrides(req.providerOverrides);
      requireReady(config);
      const audioBuffer = await qwenAudioTTS({
        text: req.text,
        apiKey: config.apiKey!,
        workspace: config.workspace!,
        baseUrl: config.baseUrl,
        region: config.region,
        model: overrides.modelId ?? config.modelId,
        voice: overrides.voiceId ?? config.voiceId!,
        format: "pcm",
        sampleRate: TELEPHONY_SAMPLE_RATE,
        instruction: overrides.instruction ?? config.instruction,
        speechRate: overrides.speechRate ?? config.speechRate,
        pitchRate: overrides.pitchRate ?? config.pitchRate,
        volume: overrides.volume ?? config.volume,
        timeoutMs: req.timeoutMs,
      });
      return { audioBuffer, outputFormat: "pcm", sampleRate: TELEPHONY_SAMPLE_RATE };
    },
  };
}
