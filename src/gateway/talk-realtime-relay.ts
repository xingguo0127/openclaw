// Gateway Talk realtime relay.
// Bridges browser Talk audio sessions with realtime voice provider plugins.
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.js";
import { onAgentEvent } from "../infra/agent-events.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  appendRealtimeVoicePresentation,
  formatRealtimeVoiceConsultResultForSpeech,
  readRealtimeVoicePresentationFromAgentEvent,
  withRealtimeVoicePresentations,
  type RealtimeVoicePresentation,
} from "../talk/agent-consult-presentations.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultWorkingResponse,
} from "../talk/agent-consult-tool.js";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  controlRealtimeVoiceAgentRun,
  resolveRealtimeVoiceAgentControlIntent,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "../talk/agent-run-control.js";
import {
  readRealtimeVoiceConsultQuestion,
  readSpeakableRealtimeVoiceToolResult,
} from "../talk/consult-question.js";
import {
  formatRealtimeExecutionAnnouncement,
  registerRealtimeExecutionFeedbackSink,
  realtimeExecutionFeedbackKey,
  type RealtimeExecutionFeedback,
} from "../talk/execution-feedback.js";
import {
  createRealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinator,
} from "../talk/forced-consult-coordinator.js";
import { recordTalkObservabilityEvent } from "../talk/observability.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBrowserAudioContract,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
import {
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceTranscriptEntry,
} from "../talk/session-log-runtime.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
} from "../talk/session-runtime.js";
import { isLossyTalkEventType } from "../talk/talk-events.js";
import {
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
  createTalkSessionController,
} from "../talk/talk-session-controller.js";
import { abortChatRunById } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import {
  closeExpiredTalkRelaySessions,
  requireActiveTalkRelaySession,
} from "./talk-relay-session-lifecycle.js";
import { forgetUnifiedTalkSession } from "./talk-session-registry.js";

const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.event";
const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;
const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_RESULT_MAX_CHARS = 12_000;
const REALTIME_PRESENTATION_RETENTION_MS = 5 * 60 * 1000;
const MAX_CANCELLED_RELAY_TOOL_CALLS = 128;
const MAX_RELAY_RESPONSE_CORRELATIONS = 128;
const EXECUTION_ANNOUNCEMENT_TTL_MS = 120_000;
const MAX_EXECUTION_ANNOUNCEMENT_HISTORY = 256;
const REALTIME_AGENT_CONSULT_ACKNOWLEDGEMENT_MAX_CHARS = 400;
const REALTIME_OUTPUT_PLAYBACK_IDLE_GRACE_MS = 500;

type PendingRealtimePresentations = {
  presentations: RealtimeVoicePresentation[];
  expiresAt: number;
};

const pendingRealtimePresentations = new Map<string, PendingRealtimePresentations>();
let realtimePresentationListenerReady = false;

function prunePendingRealtimePresentations(now = Date.now()): void {
  for (const [runId, pending] of pendingRealtimePresentations) {
    if (pending.expiresAt <= now) {
      pendingRealtimePresentations.delete(runId);
    }
  }
}

function ensureRealtimePresentationListener(): void {
  if (realtimePresentationListenerReady) {
    return;
  }
  realtimePresentationListenerReady = true;
  onAgentEvent((event) => {
    const pending = pendingRealtimePresentations.get(event.runId);
    if (!pending) {
      return;
    }
    appendRealtimeVoicePresentation(
      pending.presentations,
      readRealtimeVoicePresentationFromAgentEvent(event),
    );
    if (
      event.stream === "lifecycle" &&
      (event.data.phase === "end" || event.data.phase === "error")
    ) {
      pending.expiresAt = Date.now() + REALTIME_PRESENTATION_RETENTION_MS;
    }
  });
}

/** Starts collecting structured card data before a realtime chat run can emit tool events. */
export function prepareTalkRealtimeRelayAgentRun(runId: string): void {
  prunePendingRealtimePresentations();
  ensureRealtimePresentationListener();
  pendingRealtimePresentations.set(runId, {
    presentations: [],
    expiresAt: Date.now() + REALTIME_PRESENTATION_RETENTION_MS,
  });
}

/** Drops presentation state when a realtime chat run failed to start. */
export function releaseTalkRealtimeRelayAgentRun(runId: string): void {
  pendingRealtimePresentations.delete(runId);
}

function promoteTalkRealtimeRelayAgentRun(preparedRunId: string, runId: string): void {
  if (preparedRunId === runId) {
    return;
  }
  const pending = pendingRealtimePresentations.get(preparedRunId);
  if (!pending) {
    return;
  }
  pendingRealtimePresentations.delete(preparedRunId);
  pendingRealtimePresentations.set(runId, pending);
}

function attachTalkRealtimeRelayPresentations(runId: string | undefined, result: unknown): unknown {
  if (!runId) {
    return result;
  }
  const presentations = pendingRealtimePresentations.get(runId)?.presentations ?? [];
  return withRealtimeVoicePresentations(result, presentations);
}

type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | {
      relaySessionId: string;
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { relaySessionId: string; type: "audioDone"; itemId?: string; responseId?: string }
  | { relaySessionId: string; type: "clear" }
  | { relaySessionId: string; type: "mark"; markName: string }
  | {
      relaySessionId: string;
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | {
      relaySessionId: string;
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | { relaySessionId: string; type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | {
      relaySessionId: string;
      type: "error";
      message: string;
      code?: "realtime_unavailable";
      provider?: string;
      model?: string;
      transport?: "gateway-relay";
      phase?: string;
    }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  talk: TalkSessionController;
  sessionKey?: string;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, string>;
  activeAgentToolCalls: Map<string, string>;
  completedAgentToolCalls: Set<string>;
  toolCalls: Map<
    string,
    {
      name: string;
      turnId: string;
      functionResponseDone: boolean;
      resultSubmitted: boolean;
      expectsContinuation: boolean;
    }
  >;
  cancelledToolCalls: Map<string, { turnId: string }>;
  responseTurns: Map<string, string>;
  cancelledResponseTurns: Map<string, string>;
  providerCancelRequests: Array<{ turnId: string; toolContinuation: boolean }>;
  forcedConsults: RealtimeVoiceForcedConsultCoordinator;
  transcript: RealtimeVoiceTranscriptEntry[];
  executionFeedback: Map<string, RealtimeExecutionFeedback>;
  pendingExecutionAnnouncements: Map<
    string,
    { feedback: RealtimeExecutionFeedback; expiresAtMs: number }
  >;
  announcedExecutionFeedback: Set<string>;
  executionFeedbackSessionKey?: string;
  executionFeedbackUnsubscribe?: () => void;
  executionFeedbackExpiryTimer?: ReturnType<typeof setTimeout>;
  executionFeedbackIdleTimer?: ReturnType<typeof setTimeout>;
  outputPlaybackExpectedEndMs: number;
};

type TalkRealtimeRelayIssue = {
  code: "realtime_unavailable";
  message: string;
  provider: string;
  model?: string;
  transport: "gateway-relay";
  phase: string;
};

type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  sessionKey?: string;
  voice?: string;
  forceAgentConsultOnFinalTranscript?: boolean;
};

type TalkRealtimeRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  sessionKey?: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt: number;
};

const relaySessions = new Map<string, RelaySession>();

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRealtimeAgentConsultStartSpeechMessage(args: unknown): string {
  const question = readRealtimeVoiceConsultQuestion(args);
  const boundedQuestion = question?.slice(0, REALTIME_AGENT_CONSULT_ACKNOWLEDGEMENT_MAX_CHARS);
  return [
    "Internal OpenClaw realtime consult-start acknowledgement.",
    "Do not call tools and do not answer the request yet.",
    "Speak exactly one brief, natural sentence acknowledging that you are starting the request below.",
    "Name its concrete action and subject in the caller's language; ask them to wait only when appropriate.",
    "Do not claim that it is running in the background or that it has completed.",
    `Request: ${JSON.stringify(boundedQuestion ?? "the caller's current request")}`,
  ].join("\n");
}

function clearRelayExecutionFeedback(session: RelaySession): void {
  session.executionFeedbackUnsubscribe?.();
  session.executionFeedbackUnsubscribe = undefined;
  session.executionFeedbackSessionKey = undefined;
  if (session.executionFeedbackExpiryTimer) {
    clearTimeout(session.executionFeedbackExpiryTimer);
    session.executionFeedbackExpiryTimer = undefined;
  }
  if (session.executionFeedbackIdleTimer) {
    clearTimeout(session.executionFeedbackIdleTimer);
    session.executionFeedbackIdleTimer = undefined;
  }
  session.pendingExecutionAnnouncements.clear();
  session.executionFeedback.clear();
}

function isRelayOutputPlaybackActive(session: RelaySession, nowMs = Date.now()): boolean {
  return nowMs < session.outputPlaybackExpectedEndMs + REALTIME_OUTPUT_PLAYBACK_IDLE_GRACE_MS;
}

function scheduleExecutionAnnouncementIdleRetry(session: RelaySession): void {
  if (session.executionFeedbackIdleTimer) {
    clearTimeout(session.executionFeedbackIdleTimer);
    session.executionFeedbackIdleTimer = undefined;
  }
  const delayMs =
    session.outputPlaybackExpectedEndMs + REALTIME_OUTPUT_PLAYBACK_IDLE_GRACE_MS - Date.now();
  if (delayMs <= 0) {
    return;
  }
  session.executionFeedbackIdleTimer = setTimeout(() => {
    session.executionFeedbackIdleTimer = undefined;
    flushRelayExecutionAnnouncements(session);
  }, delayMs);
  session.executionFeedbackIdleTimer.unref?.();
}

function scheduleExecutionAnnouncementExpiry(session: RelaySession): void {
  if (session.executionFeedbackExpiryTimer) {
    clearTimeout(session.executionFeedbackExpiryTimer);
    session.executionFeedbackExpiryTimer = undefined;
  }
  const nextExpiry = [...session.pendingExecutionAnnouncements.values()].reduce(
    (earliest, item) => Math.min(earliest, item.expiresAtMs),
    Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(nextExpiry)) {
    return;
  }
  session.executionFeedbackExpiryTimer = setTimeout(
    () => {
      session.executionFeedbackExpiryTimer = undefined;
      flushRelayExecutionAnnouncements(session);
    },
    Math.max(0, nextExpiry - Date.now()),
  );
  session.executionFeedbackExpiryTimer.unref?.();
}

function flushRelayExecutionAnnouncements(session: RelaySession): void {
  if (!relaySessions.has(session.id)) {
    return;
  }
  const now = Date.now();
  for (const [key, item] of session.pendingExecutionAnnouncements) {
    if (item.expiresAtMs <= now) {
      session.pendingExecutionAnnouncements.delete(key);
    }
  }
  if (session.pendingExecutionAnnouncements.size === 0 || !session.bridge.sendUserMessage) {
    scheduleExecutionAnnouncementExpiry(session);
    return;
  }
  const outputPlaybackActive = isRelayOutputPlaybackActive(session, now);
  if (session.talk.activeTurnId || session.talk.outputAudioActive || outputPlaybackActive) {
    scheduleExecutionAnnouncementExpiry(session);
    if (outputPlaybackActive) {
      scheduleExecutionAnnouncementIdleRetry(session);
    }
    return;
  }
  if (session.executionFeedbackIdleTimer) {
    clearTimeout(session.executionFeedbackIdleTimer);
    session.executionFeedbackIdleTimer = undefined;
  }
  const pending = [...session.pendingExecutionAnnouncements.entries()].toSorted(
    ([, a], [, b]) => a.feedback.updatedAt - b.feedback.updatedAt,
  );
  const spoken = pending
    .slice(0, 3)
    .map(([, item]) => formatRealtimeExecutionAnnouncement(item.feedback));
  if (pending.length > 3) {
    spoken.push(`另外还有 ${pending.length - 3} 个后台任务也已更新。`);
  }
  const announcementTurnId = ensureRelayTurn(session);
  try {
    session.bridge.sendUserMessage(buildRealtimeVoiceAgentControlSpeechMessage(spoken.join("")));
  } catch (error) {
    if (session.talk.activeTurnId === announcementTurnId) {
      cancelRelayTurnState(session, "execution-announcement-failed");
    }
    session.context.logGateway?.warn(
      `[talk] realtime Execution announcement failed relaySessionId=${session.id}: ${formatError(error)}`,
    );
    scheduleExecutionAnnouncementExpiry(session);
    return;
  }
  for (const [key] of pending) {
    session.pendingExecutionAnnouncements.delete(key);
    session.announcedExecutionFeedback.add(key);
  }
  while (session.announcedExecutionFeedback.size > MAX_EXECUTION_ANNOUNCEMENT_HISTORY) {
    const oldest = session.announcedExecutionFeedback.values().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    session.announcedExecutionFeedback.delete(oldest);
  }
  scheduleExecutionAnnouncementExpiry(session);
}

function receiveRelayExecutionFeedback(
  session: RelaySession,
  feedback: RealtimeExecutionFeedback,
): void {
  const snapshotKey = realtimeExecutionFeedbackKey(feedback);
  const previous = session.executionFeedback.get(snapshotKey);
  if (previous && feedback.updatedAt < previous.updatedAt) {
    return;
  }
  session.executionFeedback.set(snapshotKey, feedback);
  if (feedback.disposition === "ANNOUNCE_WHEN_IDLE") {
    const terminalKey = `${snapshotKey}:${feedback.status}`;
    if (session.announcedExecutionFeedback.has(terminalKey)) {
      return;
    }
    const existing = session.pendingExecutionAnnouncements.get(terminalKey);
    session.pendingExecutionAnnouncements.set(terminalKey, {
      feedback,
      expiresAtMs: existing?.expiresAtMs ?? Date.now() + EXECUTION_ANNOUNCEMENT_TTL_MS,
    });
  }
  flushRelayExecutionAnnouncements(session);
}

function attachRelayExecutionFeedback(session: RelaySession): void {
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey || session.executionFeedbackSessionKey === sessionKey) {
    return;
  }
  session.executionFeedbackUnsubscribe?.();
  session.executionFeedbackSessionKey = sessionKey;
  session.executionFeedbackUnsubscribe = registerRealtimeExecutionFeedbackSink(
    sessionKey,
    (feedback) => receiveRelayExecutionFeedback(session, feedback),
  );
}

function realtimeRelayIssue(params: {
  message: string;
  provider: string;
  model?: string;
  phase: string;
}): TalkRealtimeRelayIssue {
  return {
    code: "realtime_unavailable",
    message: params.message,
    provider: params.provider,
    ...(params.model ? { model: params.model } : {}),
    transport: "gateway-relay",
    phase: params.phase,
  };
}

function relayIssuePayload(
  relaySessionId: string,
  issue: TalkRealtimeRelayIssue,
): Extract<TalkRealtimeRelayEventPayload, { type: "error" }> {
  return {
    relaySessionId,
    type: "error",
    message: issue.message,
    code: issue.code,
    provider: issue.provider,
    ...(issue.model ? { model: issue.model } : {}),
    transport: issue.transport,
    phase: issue.phase,
  };
}

function isWorkingToolResult(result: unknown): boolean {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).status === "working"
  );
}

function isRelayAssistantEchoTranscript(session: RelaySession | undefined, text: string): boolean {
  if (!session) {
    return false;
  }
  return isLikelyRealtimeVoiceAssistantEchoTranscript({
    transcript: session.transcript,
    text,
    lookbackMs: RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
  });
}
function buildForcedConsultCheckingPrompt(): string {
  return [
    "Briefly tell the person that you are checking with OpenClaw.",
    "Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
  ].join(" ");
}

function buildForcedConsultSpeechPrompt(result: unknown): string {
  const context = formatRealtimeVoiceConsultResultForSpeech(
    result,
    FORCED_CONSULT_RESULT_MAX_CHARS,
  );
  return [
    "OpenClaw produced agent commentary plus optional verified card data below.",
    "Combine both into a natural spoken answer. Use the card data as the factual query result and the commentary as recommendations or context.",
    "State the concrete names, times, prices, statuses, and representative options needed to answer the caller. Do not merely tell them to look at a card.",
    "Do not read JSON keys, URLs, internal IDs, tools, or routing. Do not invent facts. Speak only the answer itself.",
    "",
    context,
  ].join("\n");
}

function buildAlreadyDeliveredToolResult(): Record<string, string> {
  return {
    status: "already_delivered",
    message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
  };
}

function cancelForcedConsults(session: RelaySession): void {
  for (const handle of session.forcedConsults.handles()) {
    session.forcedConsults.markCancelled(handle);
  }
}

function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
  options: { dropIfSlow?: boolean } = { dropIfSlow: false },
): void {
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), options);
}

function relayEventDeliveryOptions(talkEvent?: TalkEvent): { dropIfSlow?: boolean } {
  return { dropIfSlow: talkEvent ? isLossyTalkEventType(talkEvent.type) : false };
}

function abortRelayAgentRuns(session: RelaySession, reason: string): void {
  for (const [runId, sessionKey] of session.activeAgentRuns) {
    abortChatRunById(session.context, {
      runId,
      sessionKey,
      stopReason: reason,
    });
  }
  session.activeAgentRuns.clear();
  session.activeAgentToolCalls.clear();
}

function pruneInactiveRelayAgentRuns(session: RelaySession): number {
  for (const runId of session.activeAgentRuns.keys()) {
    if (!session.context.chatAbortControllers.has(runId)) {
      session.activeAgentRuns.delete(runId);
    }
  }
  for (const [callId, runId] of session.activeAgentToolCalls) {
    if (!session.activeAgentRuns.has(runId)) {
      session.activeAgentToolCalls.delete(callId);
    }
  }
  return session.activeAgentRuns.size;
}

function broadcastToolResultToOwner(
  session: RelaySession,
  params: {
    callId: string;
    turnId: string;
    result: unknown;
    final: boolean;
    forced?: boolean;
  },
): void {
  const payload =
    params.forced === true ? { result: params.result, forced: true } : { result: params.result };
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId: params.callId,
    talkEvent: session.talk.emit({
      type: "tool.result",
      callId: params.callId,
      turnId: params.turnId,
      payload,
      final: params.final,
    }),
  });
}

function submitRelayAgentControlProviderResults(
  session: RelaySession,
  result: RealtimeVoiceAgentControlResult,
  turnId: string,
): void {
  if (result.mode !== "cancel" || !result.ok || !result.providerResult) {
    return;
  }
  const activeCallIds = [...session.activeAgentToolCalls.keys()];
  for (const callId of activeCallIds) {
    const forcedConsult = session.forcedConsults.handles().find((handle) => handle.id === callId);
    if (forcedConsult) {
      // Forced consults may have both synthetic and provider-native call ids;
      // cancelling must satisfy every native id or the provider keeps waiting.
      session.forcedConsults.markCancelled(forcedConsult);
      for (const nativeCallId of session.forcedConsults.nativeCallIds(forcedConsult)) {
        session.bridge.submitToolResult(nativeCallId, result.providerResult, {
          suppressResponse: true,
        });
      }
    } else {
      session.bridge.submitToolResult(callId, result.providerResult, { suppressResponse: true });
    }
    broadcastToolResultToOwner(session, {
      callId,
      turnId,
      result: result.providerResult,
      final: true,
    });
    session.activeAgentToolCalls.delete(callId);
    session.completedAgentToolCalls.add(callId);
  }
  session.activeAgentRuns.clear();
}

function closeRelaySession(session: RelaySession, reason: "completed" | "error"): void {
  session.forcedConsults.clear();
  clearRelayExecutionFeedback(session);
  relaySessions.delete(session.id);
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  abortRelayAgentRuns(session, reason === "error" ? "relay-error" : "relay-closed");
  session.bridge.close();
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "close",
    reason,
    talkEvent: session.talk.emit({
      type: "session.closed",
      payload: { reason },
      final: true,
    }),
  });
}

function pruneExpiredRelaySessions(nowMs = Date.now()): void {
  closeExpiredTalkRelaySessions({
    sessions: relaySessions.values(),
    closeSession: (session) => closeRelaySession(session, "completed"),
    nowMs,
  });
}

function countRelaySessionsForConn(connId: string): number {
  let count = 0;
  for (const session of relaySessions.values()) {
    if (session.connId === connId) {
      count += 1;
    }
  }
  return count;
}

function enforceRelaySessionLimits(connId: string): void {
  pruneExpiredRelaySessions();
  if (relaySessions.size >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  if (countRelaySessionsForConn(connId) >= MAX_RELAY_SESSIONS_PER_CONN) {
    throw new Error("Too many active realtime relay sessions for this connection");
  }
}

/** Creates a realtime voice relay session and returns the browser audio contract. */
export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  enforceRelaySessionLimits(params.connId);
  const forceAgentConsultOnFinalTranscript = params.forceAgentConsultOnFinalTranscript === true;
  const relaySessionId = randomUUID();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(RELAY_SESSION_TTL_MS);
  if (expiresAtMs === undefined) {
    throw new Error("Realtime relay session expiry is outside the supported Date range");
  }
  const talk = createTalkSessionController(
    {
      sessionId: relaySessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const emit = (event: TalkRealtimeRelayEventPayload, talkEventInput?: TalkEventInput) => {
    const talkEvent = talkEventInput ? talk.emit(talkEventInput) : undefined;
    broadcastToOwner(
      params.context,
      params.connId,
      {
        ...event,
        ...(talkEvent ? { talkEvent } : {}),
      },
      relayEventDeliveryOptions(talkEvent),
    );
  };
  let currentOutputItemId: string | undefined;
  let currentOutputResponseId: string | undefined;
  let spokenOutputResponseId: string | undefined;
  let providerResponseHasSpokenAudio = false;
  let ready = false;
  let failureEmitted = false;
  const relayRef: { current?: RelaySession } = {};
  const bridge = createRealtimeVoiceBridgeSession({
    provider: params.provider,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
    interruptResponseOnInputAudio: !forceAgentConsultOnFinalTranscript,
    tools: params.tools,
    markStrategy: "ack-immediately",
    audioSink: {
      isOpen: () => Boolean(relayRef.current && relaySessions.has(relayRef.current.id)),
      sendAudio: (audio) => {
        const relay = relayRef.current;
        const turnId = relay ? ensureRelayTurn(relay) : undefined;
        if (relay) {
          const bytesPerSecond = REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz * 2;
          const chunkDurationMs = (audio.length / bytesPerSecond) * 1000;
          relay.outputPlaybackExpectedEndMs =
            Math.max(Date.now(), relay.outputPlaybackExpectedEndMs) + chunkDurationMs;
          if (relay.pendingExecutionAnnouncements.size > 0) {
            scheduleExecutionAnnouncementIdleRetry(relay);
          }
        }
        emit(
          {
            relaySessionId,
            type: "audio",
            audioBase64: audio.toString("base64"),
            ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
            ...(currentOutputResponseId ? { responseId: currentOutputResponseId } : {}),
          },
          {
            type: "output.audio.delta",
            turnId,
            payload: { byteLength: audio.length },
          },
        );
      },
      clearAudio: () => {
        const relay = relayRef.current;
        const turnId = relay?.talk.activeTurnId;
        if (relay) {
          relay.outputPlaybackExpectedEndMs = 0;
          queueMicrotask(() => flushRelayExecutionAnnouncements(relay));
        }
        emit(
          { relaySessionId, type: "clear" },
          turnId
            ? {
                type: "output.audio.done",
                turnId,
                payload: { reason: "clear" },
                final: true,
              }
            : undefined,
        );
      },
      sendMark: (markName) => {
        const turnId = relayRef.current ? ensureRelayTurn(relayRef.current) : undefined;
        emit(
          { relaySessionId, type: "mark", markName },
          {
            type: "output.audio.done",
            turnId,
            payload: { markName },
            final: true,
          },
        );
      },
    },
    onEvent: (event) => {
      const relay = relayRef.current;
      if (event.direction === "client") {
        if (event.type === "response.barge_in" && relay?.talk.activeTurnId) {
          if (event.detail?.includes("state=active-response") === true) {
            relay.providerCancelRequests.push({
              turnId: relay.talk.activeTurnId,
              toolContinuation: false,
            });
            if (relay.providerCancelRequests.length > MAX_RELAY_RESPONSE_CORRELATIONS) {
              relay.providerCancelRequests.shift();
            }
          }
          emit({ relaySessionId, type: "clear" }, cancelRelayTurnState(relay, "provider-barge-in"));
          return;
        }
        if (
          event.type === "response.cancel" &&
          event.detail?.includes("reason=discard-barge-in-response") !== true &&
          relay?.talk.activeTurnId
        ) {
          relay.providerCancelRequests.push({
            turnId: relay.talk.activeTurnId,
            toolContinuation: event.detail?.includes("reason=deliver-tool-result") === true,
          });
          if (relay.providerCancelRequests.length > MAX_RELAY_RESPONSE_CORRELATIONS) {
            relay.providerCancelRequests.shift();
          }
        }
        return;
      }
      if (event.direction !== "server") {
        return;
      }
      if (event.type === "input_audio_buffer.speech_started") {
        params.context.logGateway?.info(
          `[talk] provider VAD speech_started relaySessionId=${relaySessionId}${event.detail ? ` ${event.detail}` : ""}`,
        );
      }
      if (
        event.responseId &&
        relay &&
        !relay.responseTurns.has(event.responseId) &&
        !relay.cancelledResponseTurns.has(event.responseId)
      ) {
        const pendingCancel = relay.providerCancelRequests[0];
        const turnId = pendingCancel?.turnId ?? relay.talk.activeTurnId;
        if (turnId) {
          relay.responseTurns.set(event.responseId, turnId);
          if (turnId !== relay.talk.activeTurnId) {
            relay.cancelledResponseTurns.set(event.responseId, turnId);
          }
        }
        while (relay.responseTurns.size > MAX_RELAY_RESPONSE_CORRELATIONS) {
          const oldestResponseId = relay.responseTurns.keys().next().value;
          if (typeof oldestResponseId !== "string") {
            break;
          }
          relay.responseTurns.delete(oldestResponseId);
        }
      }
      if (
        event.type === "conversation.output_audio.delta" ||
        event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta"
      ) {
        currentOutputItemId = event.itemId ?? currentOutputItemId;
        currentOutputResponseId = event.responseId ?? currentOutputResponseId;
        spokenOutputResponseId = event.responseId ?? spokenOutputResponseId;
        providerResponseHasSpokenAudio = true;
        return;
      }
      if (
        event.type === "response.audio.done" ||
        event.type === "response.output_audio.done" ||
        event.type === "conversation.output_audio.done" ||
        event.type === "response.done" ||
        event.type === "response.cancelled"
      ) {
        const talkEvent = relay
          ? settleRelayProviderResponse(relay, event.type, event.responseId)
          : undefined;
        emit(
          {
            relaySessionId,
            type: "audioDone",
            ...((event.itemId ?? currentOutputItemId)
              ? { itemId: event.itemId ?? currentOutputItemId }
              : {}),
            ...((event.responseId ?? currentOutputResponseId)
              ? { responseId: event.responseId ?? currentOutputResponseId }
              : {}),
          },
          talkEvent,
        );
        currentOutputItemId = undefined;
        currentOutputResponseId = undefined;
        if (relay) {
          queueMicrotask(() => flushRelayExecutionAnnouncements(relay));
        }
        if (event.type === "response.done" || event.type === "response.cancelled") {
          spokenOutputResponseId = undefined;
          providerResponseHasSpokenAudio = false;
        }
      }
    },
    onTranscript: (role, text, final) => {
      const relay = relayRef.current;
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      if (final && relay) {
        recordRealtimeVoiceTranscript(relay.transcript, role, text);
      }
      const eventType =
        role === "assistant"
          ? final
            ? "output.text.done"
            : "output.text.delta"
          : final
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emit(
        { relaySessionId, type: "transcript", role, text, final },
        {
          type: eventType,
          turnId,
          payload,
          final,
        },
      );
      if (role === "user" && final && text.trim()) {
        const question = text.trim();
        if (isRelayAssistantEchoTranscript(relay, question)) {
          return;
        }
        const activeRunCount = relay ? pruneInactiveRelayAgentRuns(relay) : 0;
        const controlIntent = resolveRealtimeVoiceAgentControlIntent({ text: question });
        const hasExecutionStatus = Boolean(relay?.executionFeedback.size);
        if (
          relay &&
          shouldAutoControlRealtimeVoiceAgentText(question) &&
          (activeRunCount > 0 || (hasExecutionStatus && controlIntent.mode === "status"))
        ) {
          // While an agent consult is active, short user utterances like "stop"
          // steer the chat run instead of becoming a new consult.
          void steerTalkRealtimeRelayAgentRun({
            relaySessionId,
            connId: params.connId,
            text: question,
          })
            .then((result) => {
              if (result.speak && !result.suppress && result.message.trim()) {
                bridge.sendUserMessage(buildRealtimeVoiceAgentControlSpeechMessage(result.message));
              }
            })
            .catch((error: unknown) => {
              emit(
                { relaySessionId, type: "error", message: formatError(error) },
                {
                  type: "session.error",
                  payload: { message: formatError(error) },
                  final: true,
                },
              );
            });
          return;
        }
        if (forceAgentConsultOnFinalTranscript) {
          scheduleForcedAgentConsult(relay, question);
        }
      }
    },
    onToolCall: (toolCall) => {
      const relay = relayRef.current;
      const turnId = relay
        ? resolveRelayProviderToolCallTurn(relay, toolCall.responseId)
        : undefined;
      if (relay && !turnId) {
        relay.bridge.submitToolResult(
          toolCall.callId,
          { ok: false, errorCode: "TURN_CANCELLED" },
          { suppressResponse: true },
        );
        return;
      }
      if (relay && turnId && !relay.toolCalls.has(toolCall.callId)) {
        relay.toolCalls.set(toolCall.callId, {
          name: toolCall.name,
          turnId,
          functionResponseDone: false,
          resultSubmitted: false,
          expectsContinuation: false,
        });
      }
      if (relay && toolCall.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        const providerAlreadyAcknowledged =
          providerResponseHasSpokenAudio &&
          (!toolCall.responseId ||
            !spokenOutputResponseId ||
            toolCall.responseId === spokenOutputResponseId);
        const forcedConsult = relay.forcedConsults.recordNativeConsult(
          toolCall.args,
          toolCall.callId,
        );
        if (forcedConsult.kind === "in_flight" || forcedConsult.kind === "already_delivered") {
          if (forcedConsult.kind === "already_delivered") {
            submitAlreadyDeliveredToolResult(relay, toolCall.callId, turnId);
          } else {
            submitRealtimeAgentConsultWorkingResponse(
              relay,
              toolCall.callId,
              turnId,
              toolCall.args,
              providerAlreadyAcknowledged,
            );
          }
          return;
        }
        submitRealtimeAgentConsultWorkingResponse(
          relay,
          toolCall.callId,
          turnId,
          toolCall.args,
          providerAlreadyAcknowledged,
        );
      }
      emit(
        {
          relaySessionId,
          type: "toolCall",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          name: toolCall.name,
          args: toolCall.args,
        },
        {
          type: "tool.call",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          turnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
    },
    onReady: () => {
      ready = true;
      emit({ relaySessionId, type: "ready" }, { type: "session.ready", payload: null });
    },
    onError: (error) => {
      const issue = realtimeRelayIssue({
        message: formatError(error),
        provider: params.provider.id,
        model: params.model,
        phase: ready ? "stream" : "connect",
      });
      failureEmitted = true;
      emit(relayIssuePayload(relaySessionId, issue), {
        type: "session.error",
        payload: issue,
        final: true,
      });
    },
    onClose: (reason) => {
      const active = relaySessions.get(relaySessionId);
      if (!active) {
        return;
      }
      active.forcedConsults.clear();
      clearRelayExecutionFeedback(active);
      relaySessions.delete(relaySessionId);
      forgetUnifiedTalkSession(relaySessionId);
      clearTimeout(active.cleanupTimer);
      abortRelayAgentRuns(active, "relay-closed");
      if (!ready && !failureEmitted) {
        const issue = realtimeRelayIssue({
          message: "Realtime provider closed before the session became ready.",
          provider: params.provider.id,
          model: params.model,
          phase: "connect",
        });
        emit(relayIssuePayload(relaySessionId, issue), {
          type: "session.error",
          payload: issue,
          final: true,
        });
      }
      emit(
        { relaySessionId, type: "close", reason },
        { type: "session.closed", payload: { reason }, final: true },
      );
    },
  });
  const relay: RelaySession = {
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    talk,
    sessionKey: params.sessionKey?.trim() || undefined,
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
    activeAgentRuns: new Map(),
    activeAgentToolCalls: new Map(),
    completedAgentToolCalls: new Set(),
    toolCalls: new Map(),
    cancelledToolCalls: new Map(),
    responseTurns: new Map(),
    cancelledResponseTurns: new Map(),
    providerCancelRequests: [],
    forcedConsults: createRealtimeVoiceForcedConsultCoordinator(),
    transcript: [],
    executionFeedback: new Map(),
    pendingExecutionAnnouncements: new Map(),
    announcedExecutionFeedback: new Set(),
    outputPlaybackExpectedEndMs: 0,
  };
  relayRef.current = relay;
  relay.cleanupTimer.unref?.();
  relaySessions.set(relaySessionId, relay);
  attachRelayExecutionFeedback(relay);
  bridge.connect().catch((error: unknown) => {
    const issue = realtimeRelayIssue({
      message: formatError(error),
      provider: params.provider.id,
      model: params.model,
      phase: "connect",
    });
    failureEmitted = true;
    emit(relayIssuePayload(relaySessionId, issue), {
      type: "session.error",
      payload: issue,
      final: true,
    });
    const active = relaySessions.get(relaySessionId);
    if (active) {
      closeRelaySession(active, "error");
    }
  });

  return {
    provider: params.provider.id,
    transport: "gateway-relay",
    relaySessionId,
    ...(relay.sessionKey ? { sessionKey: relay.sessionKey } : {}),
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      outputEncoding: "pcm16",
      outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    },
    ...(params.model ? { model: params.model } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

function finishRelayTurnAfterProviderResponse(session: RelaySession): TalkEvent | undefined {
  const activeTurnId = session.talk.activeTurnId;
  if (!activeTurnId) {
    return undefined;
  }
  const calls = [...session.toolCalls.entries()].filter(([, call]) => call.turnId === activeTurnId);
  const unseenFunctionResponse = calls.filter(([, call]) => !call.functionResponseDone);
  for (const [, call] of unseenFunctionResponse) {
    call.functionResponseDone = true;
  }
  if (
    calls.some(([, call]) => !call.resultSubmitted) ||
    (unseenFunctionResponse.length > 0 && calls.some(([, call]) => call.expectsContinuation))
  ) {
    return undefined;
  }
  for (const [callId] of calls) {
    session.toolCalls.delete(callId);
  }
  const ended = session.talk.endTurn({
    turnId: activeTurnId,
    payload: { reason: "provider-response-done" },
  });
  return ended.ok ? ended.event : undefined;
}

function settleRelayProviderResponse(
  session: RelaySession,
  eventType: string,
  responseId: string | undefined,
): TalkEvent | undefined {
  if (eventType !== "response.done" && eventType !== "response.cancelled") {
    return undefined;
  }
  const correlatedTurnId = responseId ? session.responseTurns.get(responseId) : undefined;
  if (responseId) {
    session.responseTurns.delete(responseId);
  }
  const cancelRequest = session.providerCancelRequests.shift();
  const terminalTurnId = correlatedTurnId ?? cancelRequest?.turnId ?? session.talk.activeTurnId;
  if (!terminalTurnId || terminalTurnId !== session.talk.activeTurnId) {
    return undefined;
  }
  if (eventType === "response.done" || cancelRequest?.toolContinuation === true) {
    return finishRelayTurnAfterProviderResponse(session);
  }
  return cancelRelayTurnState(session, "provider-response-cancelled");
}

function resolveRelayProviderToolCallTurn(
  session: RelaySession,
  responseId: string | undefined,
): string | undefined {
  if (responseId) {
    if (session.cancelledResponseTurns.has(responseId)) {
      return undefined;
    }
    const correlatedTurnId = session.responseTurns.get(responseId);
    if (correlatedTurnId) {
      return correlatedTurnId === session.talk.activeTurnId ? correlatedTurnId : undefined;
    }
  }
  return session.talk.activeTurnId;
}

function rememberCancelledRelayToolCalls(session: RelaySession, turnId: string): void {
  for (const [callId, call] of session.toolCalls) {
    if (call.turnId !== turnId) {
      continue;
    }
    session.toolCalls.delete(callId);
    session.cancelledToolCalls.set(callId, { turnId: call.turnId });
  }
  while (session.cancelledToolCalls.size > MAX_CANCELLED_RELAY_TOOL_CALLS) {
    const oldestCallId = session.cancelledToolCalls.keys().next().value;
    if (typeof oldestCallId !== "string") {
      break;
    }
    session.cancelledToolCalls.delete(oldestCallId);
  }
}

function cancelRelayTurnState(session: RelaySession, reason: string): TalkEvent | undefined {
  const activeTurnId = session.talk.activeTurnId;
  if (!activeTurnId) {
    return undefined;
  }
  for (const [responseId, turnId] of session.responseTurns) {
    if (turnId === activeTurnId) {
      session.cancelledResponseTurns.set(responseId, turnId);
    }
  }
  while (session.cancelledResponseTurns.size > MAX_RELAY_RESPONSE_CORRELATIONS) {
    const oldestResponseId = session.cancelledResponseTurns.keys().next().value;
    if (typeof oldestResponseId !== "string") {
      break;
    }
    session.cancelledResponseTurns.delete(oldestResponseId);
  }
  rememberCancelledRelayToolCalls(session, activeTurnId);
  const cancelled = session.talk.cancelTurn({
    turnId: activeTurnId,
    payload: { reason },
  });
  return cancelled.ok ? cancelled.event : undefined;
}

function scheduleForcedAgentConsult(session: RelaySession | undefined, question: string): void {
  if (!session || !question.trim()) {
    return;
  }
  if (session.forcedConsults.hasRecentNativeConsult(question)) {
    return;
  }
  session.forcedConsults.clearPending();
  const handle = session.forcedConsults.prepare(question);
  if (!handle) {
    return;
  }
  session.forcedConsults.schedule(handle, FORCED_CONSULT_FALLBACK_DELAY_MS, () => {
    if (!relaySessions.has(session.id)) {
      return;
    }
    const turnId = ensureRelayTurn(session);
    const callId = handle.id;
    const itemId = `forced-consult-item-${randomUUID()}`;
    session.forcedConsults.markStarted(handle);
    session.bridge.handleBargeIn({ audioPlaybackActive: true, force: true });
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "toolCall",
      itemId,
      callId,
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      forced: true,
      args: {
        question: handle.question,
        context:
          "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult for realtime Talk.",
        responseStyle: "Reply in a concise spoken tone.",
      },
      talkEvent: session.talk.emit({
        type: "tool.call",
        itemId,
        callId,
        turnId,
        payload: {
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: handle.question },
          forced: true,
        },
      }),
    });
  });
}

function submitAlreadyDeliveredToolResult(
  session: RelaySession,
  callId: string,
  turnId = ensureRelayTurn(session),
): void {
  const result = buildAlreadyDeliveredToolResult();
  session.bridge.submitToolResult(callId, result, { suppressResponse: true });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId,
    talkEvent: session.talk.emit({
      type: "tool.result",
      callId,
      turnId,
      payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, result },
      final: true,
    }),
  });
}

function submitRealtimeAgentConsultWorkingResponse(
  session: RelaySession,
  callId: string,
  turnId: string | undefined,
  args: unknown,
  providerAlreadyAcknowledged: boolean,
): void {
  if (!session.bridge.bridge.supportsToolResultContinuation) {
    if (!providerAlreadyAcknowledged && session.bridge.sendUserMessage) {
      try {
        session.bridge.sendUserMessage(buildRealtimeAgentConsultStartSpeechMessage(args));
        session.context.logGateway?.info(
          `[talk] queued realtime consult start acknowledgement relaySessionId=${session.id} callId=${callId}`,
        );
      } catch (error) {
        session.context.logGateway?.warn(
          `[talk] failed to queue realtime consult start acknowledgement relaySessionId=${session.id} callId=${callId}: ${formatError(error)}`,
        );
      }
    }
    return;
  }
  const resolvedTurnId = turnId ?? ensureRelayTurn(session);
  session.bridge.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("person"), {
    willContinue: true,
  });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId,
    talkEvent: session.talk.emit({
      type: "tool.progress",
      callId,
      turnId: resolvedTurnId,
      payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
    }),
  });
}

function ensureRelayTurn(session: RelaySession): string {
  const turn = session.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "inputAudio",
      byteLength: 0,
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}

function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  return requireActiveTalkRelaySession({
    sessions: relaySessions,
    sessionId: relaySessionId,
    connId,
    closeSession: (session) => closeRelaySession(session, "completed"),
    unknownSessionMessage: "Unknown realtime relay session",
  });
}

/** Streams one base64-encoded browser audio frame into the owning relay. */
export function sendTalkRealtimeRelayAudio(params: {
  relaySessionId: string;
  connId: string;
  audioBase64: string;
  timestamp?: number;
}): void {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Realtime relay audio frame is too large");
  }
  const session = getRelaySession(params.relaySessionId, params.connId);
  const turnId = ensureRelayTurn(session);
  const audio = Buffer.from(params.audioBase64, "base64");
  session.bridge.sendAudio(audio);
  const talkEvent = session.talk.emit({
    type: "input.audio.delta",
    turnId,
    payload: { byteLength: audio.byteLength },
  });
  broadcastToOwner(
    session.context,
    session.connId,
    {
      relaySessionId: session.id,
      type: "inputAudio",
      byteLength: audio.byteLength,
      talkEvent,
    },
    relayEventDeliveryOptions(talkEvent),
  );
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

/** Delivers a tool result from the browser/client side back to the provider. */
export function submitTalkRealtimeRelayToolResult(params: {
  relaySessionId: string;
  connId: string;
  callId: string;
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const registeredAgentRunId = session.activeAgentToolCalls.get(params.callId);
  const providerResult = attachTalkRealtimeRelayPresentations(registeredAgentRunId, params.result);
  const cancelledToolCall = session.cancelledToolCalls.get(params.callId);
  if (cancelledToolCall) {
    const final = params.options?.willContinue !== true;
    if (final) {
      session.cancelledToolCalls.delete(params.callId);
    }
    session.bridge.submitToolResult(params.callId, providerResult, { suppressResponse: true });
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId: cancelledToolCall.turnId,
      result: providerResult,
      final,
    });
    return;
  }
  if (session.completedAgentToolCalls.has(params.callId)) {
    return;
  }
  const forcedConsult = session.forcedConsults
    .handles()
    .find((handle) => handle.id === params.callId);
  if (forcedConsult) {
    const turnId = ensureRelayTurn(session);
    const cancelled = session.forcedConsults.isCancelled(forcedConsult);
    if (cancelled) {
      if (params.options?.willContinue !== true) {
        session.forcedConsults.markCancelled(forcedConsult);
      }
    } else if (isWorkingToolResult(providerResult)) {
      session.bridge.sendUserMessage(buildForcedConsultCheckingPrompt());
    } else {
      session.forcedConsults.markDelivered(forcedConsult);
      const text = readSpeakableRealtimeVoiceToolResult(providerResult, {
        maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
      });
      for (const nativeCallId of session.forcedConsults.nativeCallIds(forcedConsult)) {
        submitAlreadyDeliveredToolResult(session, nativeCallId, turnId);
      }
      if (text) {
        session.bridge.sendUserMessage(buildForcedConsultSpeechPrompt(providerResult));
      }
    }
    const final = params.options?.willContinue !== true;
    if (final && !cancelled && !isWorkingToolResult(providerResult)) {
      session.forcedConsults.markDelivered(forcedConsult);
    }
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId,
      result: providerResult,
      forced: true,
      final,
    });
    return;
  }
  const toolCall = session.toolCalls.get(params.callId);
  if (!toolCall && registeredAgentRunId) {
    session.bridge.submitToolResult(params.callId, providerResult, params.options);
    const turnId = ensureRelayTurn(session);
    const final = params.options?.willContinue !== true;
    if (final) {
      session.activeAgentRuns.delete(registeredAgentRunId);
      session.activeAgentToolCalls.delete(params.callId);
    }
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId,
      result: providerResult,
      final,
    });
    return;
  }
  if (!toolCall) {
    session.bridge.submitToolResult(params.callId, providerResult, { suppressResponse: true });
    return;
  }
  const providerOptions: RealtimeVoiceToolResultOptions | undefined = params.options;
  session.bridge.submitToolResult(params.callId, providerResult, providerOptions);
  const turnId = toolCall.turnId;
  const final = params.options?.willContinue !== true;
  if (final) {
    toolCall.resultSubmitted = true;
    toolCall.expectsContinuation = providerOptions?.suppressResponse !== true;
    const runId = session.activeAgentToolCalls.get(params.callId);
    if (runId) {
      session.activeAgentRuns.delete(runId);
      session.activeAgentToolCalls.delete(params.callId);
    }
  }
  broadcastToolResultToOwner(session, {
    callId: params.callId,
    turnId,
    result: providerResult,
    final,
  });
}

/** Tracks the chat run started for a realtime agent-consult tool call. */
export function registerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
  runId: string;
  callId?: string;
  preparedRunId?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (params.preparedRunId) {
    promoteTalkRealtimeRelayAgentRun(params.preparedRunId, params.runId);
  }
  session.activeAgentRuns.set(params.runId, params.sessionKey);
  if (params.callId?.trim()) {
    session.activeAgentToolCalls.set(params.callId.trim(), params.runId);
  }
  if (!session.sessionKey) {
    session.sessionKey = params.sessionKey;
    attachRelayExecutionFeedback(session);
  }
}

/** Resolves the canonical session key owned by one realtime relay connection. */
export function resolveTalkRealtimeRelaySessionKey(params: {
  relaySessionId: string;
  connId: string;
}): string | undefined {
  return getRelaySession(params.relaySessionId, params.connId).sessionKey;
}

/** Applies realtime voice-control text to the active agent-consult chat run. */
export async function steerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey?: string;
  text: string;
  mode?: string;
}): Promise<RealtimeVoiceAgentControlResult> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const sessionKey = session.sessionKey;
  if (!sessionKey) {
    throw new Error("Realtime relay steering requires a session key");
  }
  const requestedSessionKey = params.sessionKey?.trim();
  if (requestedSessionKey && requestedSessionKey !== sessionKey) {
    throw new Error("Realtime relay steering session key does not match the relay session");
  }
  const result = await controlRealtimeVoiceAgentRun({
    sessionKey,
    text: params.text,
    mode: params.mode,
    recentEvents: session.talk.recentEvents,
    executionFeedback: [...session.executionFeedback.values()],
  });
  const turnId = ensureRelayTurn(session);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolProgress",
    result,
    talkEvent: session.talk.emit({
      type: "tool.progress",
      turnId,
      payload: {
        name: "openclaw_agent_control",
        phase: result.mode,
        result,
      },
      final: result.mode === "cancel" || result.mode === "status",
    }),
  });
  submitRelayAgentControlProviderResults(session, result, turnId);
  return result;
}

/** Cancels the active relay turn, aborts agent work, and clears provider audio. */
export function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  turnId?: string;
  reason?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const requestedTurnId = params.turnId?.trim();
  if (requestedTurnId && requestedTurnId !== session.talk.activeTurnId) {
    throw new Error("Realtime relay cancellation turn does not match the active turn");
  }
  const reason = params.reason ?? "client-cancelled";
  cancelForcedConsults(session);
  session.bridge.handleBargeIn({
    audioPlaybackActive: true,
    discardPendingResponse: true,
  });
  abortRelayAgentRuns(session, reason);
  const talkEvent = cancelRelayTurnState(session, reason);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "clear",
    talkEvent,
  });
}

/** Closes a realtime relay session owned by the current connection. */
export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  closeRelaySession(session, "completed");
}

/** Clears process-local realtime relays between tests. */
export function clearTalkRealtimeRelaySessionsForTest(): void {
  for (const session of relaySessions.values()) {
    session.forcedConsults.clear();
    clearRelayExecutionFeedback(session);
    clearTimeout(session.cleanupTimer);
    forgetUnifiedTalkSession(session.id);
    session.bridge.close();
  }
  relaySessions.clear();
}
