// Structured presentation data returned alongside realtime voice consult text.
import type { AgentEventPayload } from "../infra/agent-events.js";

const REALTIME_VOICE_PRESENTATION_TOOL_NAME = "push_card";
const MAX_REALTIME_VOICE_PRESENTATIONS = 4;
const MAX_REALTIME_VOICE_PRESENTATION_CHARS = 48_000;

/** User-visible structured data that a realtime model can combine with agent commentary. */
export type RealtimeVoicePresentation = {
  type: string;
  payload: Record<string, unknown>;
};

/** Read a supported presentation from a sanitized agent tool-start event. */
export function readRealtimeVoicePresentationFromAgentEvent(
  event: Pick<AgentEventPayload, "stream" | "data">,
): RealtimeVoicePresentation | undefined {
  if (
    event.stream !== "tool" ||
    event.data.phase !== "start" ||
    event.data.name !== REALTIME_VOICE_PRESENTATION_TOOL_NAME
  ) {
    return undefined;
  }
  const args = event.data.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const type = (args as Record<string, unknown>).type;
  const payload = (args as Record<string, unknown>).payload;
  if (
    typeof type !== "string" ||
    !type.trim() ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const presentation = {
    type: type.trim(),
    payload: payload as Record<string, unknown>,
  };
  try {
    return JSON.stringify(presentation).length <= MAX_REALTIME_VOICE_PRESENTATION_CHARS
      ? presentation
      : undefined;
  } catch {
    return undefined;
  }
}

/** Add one bounded, deduplicated presentation to an in-flight consult collection. */
export function appendRealtimeVoicePresentation(
  presentations: RealtimeVoicePresentation[],
  presentation: RealtimeVoicePresentation | undefined,
): void {
  if (!presentation || presentations.length >= MAX_REALTIME_VOICE_PRESENTATIONS) {
    return;
  }
  const serialized = JSON.stringify(presentation);
  if (presentations.some((candidate) => JSON.stringify(candidate) === serialized)) {
    return;
  }
  presentations.push(presentation);
}

/** Merge verified presentation data into a provider-facing realtime tool result. */
export function withRealtimeVoicePresentations(
  result: unknown,
  presentations: RealtimeVoicePresentation[],
): unknown {
  if (presentations.length === 0) {
    return result;
  }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const existing = Array.isArray(record.presentations)
      ? (record.presentations as RealtimeVoicePresentation[])
      : [];
    return { ...record, presentations: [...existing, ...presentations] };
  }
  return { text: typeof result === "string" ? result : "", presentations };
}

/** Build private model context from agent commentary plus verified UI presentation data. */
export function formatRealtimeVoiceConsultResultForSpeech(
  result: unknown,
  maxChars: number,
): string {
  const record =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  const text =
    typeof record?.text === "string"
      ? record.text.trim()
      : typeof result === "string"
        ? result.trim()
        : "";
  const presentations = Array.isArray(record?.presentations) ? record.presentations : [];
  const parts = [
    text ? `Agent commentary:\n${text}` : undefined,
    presentations.length > 0 ? `Verified card data:\n${JSON.stringify(presentations)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const combined = parts.join("\n\n");
  if (combined.length <= maxChars) {
    return combined;
  }
  return `${combined.slice(0, Math.max(0, maxChars - 16)).trimEnd()} [truncated]`;
}
