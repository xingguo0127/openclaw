/**
 * Realtime voice tool definition and helpers for delegating work to OpenClaw.
 *
 * Voice providers call this function tool when a spoken request needs normal
 * agent tools, memory, workspace context, or current information before reply.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { RealtimeVoiceTool } from "./provider-types.js";

/** Stable provider-facing tool name for realtime voice agent delegation. */
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME = "openclaw_agent_consult";
/** Closed policy set controlling whether the consult tool is exposed. */
export const REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES = [
  "safe-read-only",
  "owner",
  "none",
] as const;
/** Tool exposure policy for the shared realtime voice consult tool. */
export type RealtimeVoiceAgentConsultToolPolicy =
  (typeof REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES)[number];
/** Normalized tool-call arguments accepted from realtime providers. */
export type RealtimeVoiceAgentConsultArgs = {
  question: string;
  context?: string;
  responseStyle?: string;
};
/** Compact transcript entry included in delegated agent prompts. */
export type RealtimeVoiceAgentConsultTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

/** Shared realtime voice function-tool descriptor projected to providers. */
export const REALTIME_VOICE_AGENT_CONSULT_TOOL: RealtimeVoiceTool = {
  type: "function",
  name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  description:
    "Delegate the caller's request to the configured OpenClaw agent, then speak its result. " +
    "Before emitting this function call, you MUST first speak one brief, natural acknowledgement to the caller in the same response. Generate that acknowledgement from the caller's actual request and conversation context: state the concrete action you are starting and its subject, in the caller's language, and ask them to wait only when appropriate. Do not use a canned or fixed acknowledgement. " +
    "Do not emit this function call until that brief spoken acknowledgement has been produced. " +
    "Do not claim that the request is running in the background or has completed, because only the OpenClaw agent can determine that. " +
    "After the tool result arrives, combine its text commentary with any presentations card data and speak the actual result directly without repeating the waiting message. Treat presentations as verified query results: include the concrete user-relevant names, times, prices, statuses, or options needed to answer the request, while using text as the agent's recommendation or summary. Never read JSON keys, URLs, internal IDs, or say only that the details are in a card. " +
    "You MUST call this (do NOT answer yourself) for: " +
    "(1) querying tasks, spaces, plans, or any existing artifact's details; " +
    "(2) making a plan, generating a route book / document / itinerary, or creating a space; " +
    "(3) modifying, updating, redoing, or extending any existing plan / route book / space — " +
    "INCLUDING ones you just created earlier in THIS conversation; never assume it is already done just because you finished it a moment ago; " +
    "(4) answering the user's reply to a question OpenClaw asked (preferences, dates, numbers, confirmations). " +
    "Only pure greetings or idle small talk may be answered directly without this tool.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The concrete question or task the user asked.",
      },
      context: {
        type: "string",
        description: "Optional relevant context or transcript summary.",
      },
      responseStyle: {
        type: "string",
        description: "Optional style hint for the spoken answer.",
      },
    },
    required: ["question"],
  },
};

/** Build the interim spoken instruction while the delegated agent turn runs. */
export function buildRealtimeVoiceAgentConsultWorkingResponse(
  audienceLabel = "person",
): Record<string, unknown> {
  return {
    status: "working",
    tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    message: `Tell the ${audienceLabel} briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.`,
  };
}

/** Default safe tool allowlist for voice consults in read-only mode. */
const SAFE_READ_ONLY_TOOLS = [
  "read",
  "web_search",
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
] as const;

/** Type guard for user/config supplied consult tool policies. */
export function isRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
): value is RealtimeVoiceAgentConsultToolPolicy {
  return (
    typeof value === "string" &&
    REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES.includes(
      value as RealtimeVoiceAgentConsultToolPolicy,
    )
  );
}

/** Normalize a configured consult tool policy with a caller-owned fallback. */
export function resolveRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
  fallback: RealtimeVoiceAgentConsultToolPolicy,
): RealtimeVoiceAgentConsultToolPolicy {
  const normalized = normalizeOptionalLowercaseString(value);
  return isRealtimeVoiceAgentConsultToolPolicy(normalized) ? normalized : fallback;
}

/** Merge the shared consult tool with provider/plugin custom realtime tools. */
export function resolveRealtimeVoiceAgentConsultTools(
  policy: RealtimeVoiceAgentConsultToolPolicy,
  customTools: RealtimeVoiceTool[] = [],
): RealtimeVoiceTool[] {
  const tools = new Map<string, RealtimeVoiceTool>();
  if (policy !== "none") {
    tools.set(REALTIME_VOICE_AGENT_CONSULT_TOOL.name, REALTIME_VOICE_AGENT_CONSULT_TOOL);
  }
  // Keep the built-in consult tool first and prevent custom tools from
  // replacing its provider-facing contract by name.
  for (const tool of customTools) {
    if (!tools.has(tool.name)) {
      tools.set(tool.name, tool);
    }
  }
  return [...tools.values()];
}

/** Resolve the OpenClaw tool allowlist paired with the consult exposure policy. */
export function resolveRealtimeVoiceAgentConsultToolsAllow(
  policy: RealtimeVoiceAgentConsultToolPolicy,
): string[] | undefined {
  if (policy === "owner") {
    return undefined;
  }
  if (policy === "safe-read-only") {
    return [...SAFE_READ_ONLY_TOOLS];
  }
  return [];
}

/** Build model instructions for when the voice agent should call the consult tool. */
export function buildRealtimeVoiceAgentConsultPolicyInstructions(config: {
  toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
  consultPolicy?: "auto" | "substantive" | "always";
}): string | undefined {
  if (config.toolPolicy === "none" || !config.consultPolicy || config.consultPolicy === "auto") {
    return undefined;
  }
  if (config.consultPolicy === "always") {
    return [
      "Consult behavior:",
      "- Call openclaw_agent_consult before every substantive answer.",
      "- You may answer directly only for greetings, acknowledgements, brief latency tests, or filler while waiting for the consult result.",
      "- After the consult result arrives, combine its text commentary with any verified presentations data and speak the concrete result concisely; do not merely refer the caller to a card.",
    ].join("\n");
  }
  return [
    "Consult behavior:",
    "- Answer directly for greetings, acknowledgements, simple conversational glue, and brief latency tests.",
    "- Call openclaw_agent_consult before answering requests that need facts, memory, current information, tools, workspace state, or the user's OpenClaw-specific context.",
    "- Keep spoken replies concise and natural.",
  ].join("\n");
}

/** Parse provider-owned consult tool arguments into the normalized contract. */
export function parseRealtimeVoiceAgentConsultArgs(args: unknown): RealtimeVoiceAgentConsultArgs {
  const question =
    readConsultStringArg(args, "question") ??
    readConsultStringArg(args, "prompt") ??
    readConsultStringArg(args, "query") ??
    readConsultStringArg(args, "task");
  if (!question) {
    throw new Error("question required");
  }
  return {
    question,
    context: readConsultStringArg(args, "context"),
    responseStyle: readConsultStringArg(args, "responseStyle"),
  };
}

/** Build the plain chat message used by browser/chat forwarding paths. */
export function buildRealtimeVoiceAgentConsultChatMessage(args: unknown): string {
  const parsed = parseRealtimeVoiceAgentConsultArgs(args);
  const body = [
    parsed.question,
    parsed.context ? `Context:\n${parsed.context}` : undefined,
    parsed.responseStyle ? `Spoken style:\n${parsed.responseStyle}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  // 通话态标记：realtime consult 用 [realtime_call]（区别于 ASR→TTS 的 [voice_call]）。两者都触发
  // AGENTS.md 通话态核心规则（口头收集、不弹交互卡）；[realtime_call] 额外走"结果简短/数据化/异步"
  // 的附则 —— 因为 realtime 语音模型(qwen/gemini)会转述概括、不逐字念长内容。
  return `[realtime_call]\n${body}`;
}

/** Build the delegated OpenClaw agent prompt for a live voice consult. */
export function buildRealtimeVoiceAgentConsultPrompt(params: {
  args: unknown;
  transcript: RealtimeVoiceAgentConsultTranscriptEntry[];
  surface: string;
  userLabel: string;
  assistantLabel?: string;
  questionSourceLabel?: string;
}): string {
  const parsed = parseRealtimeVoiceAgentConsultArgs(params.args);
  const assistantLabel = params.assistantLabel ?? "Agent";
  const questionSourceLabel = params.questionSourceLabel ?? params.userLabel.toLowerCase();
  // Bound transcript context so long meetings do not crowd out the live request.
  const transcript = params.transcript
    .slice(-12)
    .map(
      (entry) => `${entry.role === "assistant" ? assistantLabel : params.userLabel}: ${entry.text}`,
    )
    .join("\n");

  return [
    // 通话态标记：realtime 用 [realtime_call](区别于 ASR→TTS 的 [voice_call]),触发 AGENTS.md
    // 通话态核心规则 + realtime 附则(结果简短/数据化/异步)。
    "[realtime_call]",
    `Live voice request from the ${questionSourceLabel} during ${params.surface}.`,
    "Act as the configured OpenClaw agent on behalf of this user. Use available tools when the request asks you to do work.",
    "When finished, return only the concise result the realtime voice agent should speak back.",
    "Do not include markdown, tool logs, or private reasoning. Include citations only when the spoken answer needs them.",
    parsed.responseStyle ? `Spoken style: ${parsed.responseStyle}` : undefined,
    transcript ? `Recent voice transcript for context:\n${transcript}` : undefined,
    parsed.context ? `Additional realtime context:\n${parsed.context}` : undefined,
    `User request:\n${parsed.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Collect only visible answer text from streamed delegated-agent payloads. */
export function collectRealtimeVoiceAgentConsultVisibleText(
  payloads: Array<{ text?: unknown; isError?: boolean; isReasoning?: boolean }>,
): string | null {
  const chunks: string[] = [];
  for (const payload of payloads) {
    // Spoken replies must not include hidden reasoning or error-channel text.
    if (payload.isError || payload.isReasoning) {
      continue;
    }
    const text = normalizeOptionalString(payload.text);
    if (text) {
      chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join("\n\n").trim() : null;
}

function readConsultStringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  return normalizeOptionalString((args as Record<string, unknown>)[key]);
}
