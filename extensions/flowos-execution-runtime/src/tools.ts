import { createHash } from "node:crypto";
import { jsonResult } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import {
  childSessionKey,
  type FinalizationPlan,
  normalizeChildAgentId,
  type RunBinding,
  RunBindingStore,
} from "./bindings.js";
import { FlowosExecutionClient, type ActiveExecution } from "./client.js";
import { ExecutionLocks } from "./locks.js";
import { FlowosExecutionRuntime } from "./runtime.js";
import type { SpaceArtifactValidation } from "./validation.js";

const activeStatuses = new Set(["QUEUED", "PLANNING", "RUNNING", "AWAITING_USER", "PAUSED"]);
const plannedRoutebookTaskKind = "ROUTEBOOK_GENERATION";
const errorCodes = [
  "AUTHORIZATION_DENIED",
  "GRANT_EXPIRED",
  "CONFLICT",
  "VALIDATION_FAILED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_REJECTED",
  "CHECKPOINT_INVALID",
  "CANCELLED_BY_USER",
  "INTERNAL",
] as const;

type ToolDeps = {
  api: OpenClawPluginApi;
  context: OpenClawPluginToolContext;
  client: FlowosExecutionClient;
  bindings: RunBindingStore;
  locks: ExecutionLocks;
  runtime: FlowosExecutionRuntime;
  ownerAgentId: string;
  validateArtifact: (params: {
    spaceId: string;
    filePath: string;
    artifactType: "html" | "markdown";
  }) => Promise<SpaceArtifactValidation>;
};

function requireSession(context: OpenClawPluginToolContext): string {
  const sessionKey = context.sessionKey?.trim();
  if (!sessionKey) {
    throw new Error("FlowOS Execution tools require a trusted session context");
  }
  return sessionKey;
}

function requireWorkspaceDir(context: OpenClawPluginToolContext): string {
  const workspaceDir = context.workspaceDir?.trim();
  if (!workspaceDir) {
    throw new Error("FlowOS Execution result plan requires a trusted workspace");
  }
  return workspaceDir;
}

function sameFinalizationPlan(
  actual: FinalizationPlan | undefined,
  expected: FinalizationPlan | undefined,
): boolean {
  if (!actual || !expected) {
    return actual === expected;
  }
  return (
    actual.workspaceDir === expected.workspaceDir &&
    actual.spaceId === expected.spaceId &&
    actual.artifactTitle === expected.artifactTitle &&
    actual.artifactFilePath === expected.artifactFilePath &&
    actual.artifactType === expected.artifactType &&
    actual.cardCaption === expected.cardCaption
  );
}

function contextAgentId(context: OpenClawPluginToolContext): string {
  const agentId = context.agentId?.trim();
  if (!agentId) {
    throw new Error("FlowOS Execution tools require a trusted agent context");
  }
  return agentId.startsWith("agent:") ? agentId : `agent:${agentId}`;
}

function requireOwnerContext(context: OpenClawPluginToolContext, ownerAgentId: string): string {
  const sessionKey = requireSession(context);
  if (isSubagentSessionKey(sessionKey) || contextAgentId(context) !== ownerAgentId) {
    throw new Error("FlowOS Execution owner tool is unavailable to this agent");
  }
  return sessionKey;
}

function requireOwnerBinding(binding: RunBinding, sessionKey: string, ownerAgentId: string): void {
  if (binding.ownerAgentId !== ownerAgentId || binding.requesterSessionKey !== sessionKey) {
    throw new Error("FlowOS Execution belongs to another owner session");
  }
}

async function requireStageBinding(
  deps: ToolDeps,
  executionId: string,
  attemptId?: string,
): Promise<RunBinding> {
  const sessionKey = requireSession(deps.context);
  const agentId = contextAgentId(deps.context);
  const childBinding = await deps.bindings.byChild(sessionKey);
  if (childBinding) {
    const childAgentId = agentId.startsWith("agent:") ? agentId.slice("agent:".length) : agentId;
    if (
      childBinding.executionId !== executionId ||
      childBinding.targetAgentId !== childAgentId ||
      childBinding.status !== "RUNNING"
    ) {
      throw new Error("child progress capability is unavailable or does not match this Execution");
    }
    if (attemptId && childBinding.attemptId !== attemptId) {
      throw new Error("child progress capability does not match this Attempt");
    }
    return childBinding;
  }
  if (agentId === deps.ownerAgentId) {
    if (!attemptId) {
      throw new Error("owner stage requires attemptId");
    }
    const binding = await deps.bindings.byExecution(executionId, attemptId);
    if (!binding) {
      throw new Error("FlowOS Execution binding not found");
    }
    requireOwnerBinding(binding, sessionKey, deps.ownerAgentId);
    return binding;
  }
  throw new Error("child progress capability is unavailable or does not match this Execution");
}

async function requireCurrentExecution(
  deps: ToolDeps,
  binding: RunBinding,
  expectedVersion?: number,
): Promise<ActiveExecution> {
  const detail = await deps.client.detail(binding.executionId);
  if (
    detail.ownerAgentId !== binding.ownerAgentId ||
    detail.currentAttemptId !== binding.attemptId ||
    !activeStatuses.has(detail.status)
  ) {
    throw new Error("FlowOS Execution is no longer active for this binding");
  }
  if (expectedVersion !== undefined && expectedVersion !== detail.version) {
    throw new Error("expectedVersion does not match the current FlowOS Execution");
  }
  return detail;
}

function scopedIdempotencyKey(sessionKey: string, value: string): string {
  const digest = createHash("sha256").update(`${sessionKey}\0${value}`).digest("hex");
  return `flowos-session:${digest}`;
}

function stableRunId(executionId: string, attemptId: string, agentId: string): string {
  const digest = createHash("sha256")
    .update(`${executionId}\0${attemptId}\0${agentId}`)
    .digest("hex");
  return `flowos-run:${digest}`;
}

function stableTaskId(spaceId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${spaceId}\0${idempotencyKey}`).digest("hex");
  return `task-flowos-${digest.slice(0, 24)}`;
}

function executionBinding(params: {
  executionId: string;
  attemptId: string;
  requesterSessionKey: string;
  ownerAgentId: string;
  taskKind: string;
}): RunBinding {
  const now = Date.now();
  return {
    ...params,
    status: "CREATED",
    createdAt: now,
    updatedAt: now,
  };
}

export function createFlowosExecutionTools(deps: ToolDeps): AnyAgentTool[] {
  const start: AnyAgentTool = {
    name: "flowos_execution_start",
    label: "FlowOS Execution Start",
    description:
      "Create one standard USER or SPACE_TASK long-running Execution for this owner session.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        source: Type.Union([Type.Literal("USER"), Type.Literal("SPACE_TASK")]),
        taskKind: Type.String({ minLength: 1, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 120 }),
        idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }),
        spaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        visibilityPolicy: Type.Optional(
          Type.Union([Type.Literal("DEFAULT"), Type.Literal("SUPPRESS_ISLAND_WHILE_CALL_ACTIVE")]),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        source: "USER" | "SPACE_TASK";
        taskKind: string;
        title: string;
        idempotencyKey: string;
        spaceId?: string;
        visibilityPolicy?: "DEFAULT" | "SUPPRESS_ISLAND_WHILE_CALL_ACTIVE";
      };
      const requesterSessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
      const idempotencyKey = scopedIdempotencyKey(requesterSessionKey, params.idempotencyKey);
      if (params.source === "SPACE_TASK" && !params.spaceId) {
        throw new Error("SPACE_TASK execution requires spaceId");
      }
      if (params.source === "USER" && params.spaceId) {
        throw new Error("USER execution cannot carry spaceId");
      }
      return await deps.locks.run("start", idempotencyKey, async () => {
        const item = await deps.client.create({
          source: params.source,
          taskKind: params.taskKind,
          title: params.title,
          idempotencyKey,
          ownerAgentId: deps.ownerAgentId,
          surfaceKind: "AI_TASK",
          visibilityPolicy: params.visibilityPolicy ?? "DEFAULT",
          ...(params.spaceId ? { spaceId: params.spaceId } : {}),
          ...(params.spaceId ? { taskId: stableTaskId(params.spaceId, idempotencyKey) } : {}),
        });
        const attemptId = item.currentAttemptId;
        if (!attemptId) {
          throw new Error("Assist created an Execution without a current Attempt");
        }
        const current = await deps.bindings.byExecution(item.executionId, attemptId);
        let binding: RunBinding;
        if (current) {
          requireOwnerBinding(current, requesterSessionKey, deps.ownerAgentId);
          binding = current;
        } else {
          binding = executionBinding({
            executionId: item.executionId,
            attemptId,
            requesterSessionKey,
            ownerAgentId: deps.ownerAgentId,
            taskKind: params.taskKind,
          });
          await deps.bindings.save(binding);
        }
        deps.runtime.watchOwnerSpawn(binding);
        return jsonResult(item);
      });
    },
  };

  const stage: AnyAgentTool = {
    name: "flowos_execution_stage",
    label: "FlowOS Execution Stage",
    description:
      "Update the structured stage for the bound Execution. Child agents can only update their current Attempt.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        stageKey: Type.String({ minLength: 1, maxLength: 64 }),
        stageLabel: Type.String({ minLength: 1, maxLength: 120 }),
        progress: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId?: string;
        stageKey: string;
        stageLabel: string;
        progress?: number;
      };
      const lockAttemptId =
        params.attemptId ?? (await deps.bindings.byChild(requireSession(deps.context)))?.attemptId;
      if (!lockAttemptId) {
        throw new Error("FlowOS Execution binding not found");
      }
      return await deps.locks.run(params.executionId, lockAttemptId, async () => {
        const binding = await requireStageBinding(deps, params.executionId, params.attemptId);
        // The plugin serializes stage writers and resolves the live version here.
        // Agent prompts must not carry a CAS token that expires after their first update.
        const current = await requireCurrentExecution(deps, binding);
        const latestBinding = await deps.bindings.byExecution(
          binding.executionId,
          binding.attemptId,
        );
        if (
          !latestBinding ||
          (isSubagentSessionKey(requireSession(deps.context)) && latestBinding.status !== "RUNNING")
        ) {
          throw new Error("child progress capability is no longer active");
        }
        if (latestBinding.finalizationPlan && !isSubagentSessionKey(requireSession(deps.context))) {
          throw new Error(
            "FlowOS Execution owner stage is unavailable after result plan acceptance",
          );
        }
        if (
          latestBinding.resultDelivery?.status === "PREPARED" ||
          latestBinding.resultDelivery?.status === "EXECUTION_COMPLETED"
        ) {
          throw new Error("FlowOS Execution stage is frozen after result preparation");
        }
        const item = await deps.client.stage(params.executionId, {
          expectedVersion: current.version,
          stageKey: params.stageKey,
          stageLabel: params.stageLabel,
          ...(params.progress === undefined ? {} : { progress: params.progress }),
        });
        return jsonResult(item);
      });
    },
  };

  const spawn: AnyAgentTool = {
    name: "flowos_execution_spawn",
    label: "FlowOS Execution Spawn",
    description: "Spawn one idempotent subagent run bound to an existing FlowOS Execution Attempt.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.String({ minLength: 1, maxLength: 128 }),
        agentId: Type.String({ minLength: 1, maxLength: 64 }),
        task: Type.String({ minLength: 1, maxLength: 100_000 }),
        resultPlan: Type.Optional(
          Type.Object(
            {
              spaceId: Type.String({ minLength: 1, maxLength: 128 }),
              artifactTitle: Type.String({ minLength: 1, maxLength: 160 }),
              artifactFilePath: Type.String({ minLength: 1, maxLength: 512 }),
              artifactType: Type.Union([Type.Literal("html"), Type.Literal("markdown")]),
              cardCaption: Type.String({ minLength: 1, maxLength: 500 }),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId: string;
        agentId: string;
        task: string;
        resultPlan?: Omit<FinalizationPlan, "workspaceDir">;
      };
      const requesterSessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
      const targetAgentId = normalizeChildAgentId(params.agentId);
      const finalizationPlan = params.resultPlan
        ? { ...params.resultPlan, workspaceDir: requireWorkspaceDir(deps.context) }
        : undefined;
      let rejected: { error: unknown; binding: RunBinding } | undefined;
      const result = await deps.locks.run(params.executionId, params.attemptId, async () => {
        const current = await deps.bindings.byExecution(params.executionId, params.attemptId);
        if (!current) {
          throw new Error("FlowOS Execution binding not found");
        }
        requireOwnerBinding(current, requesterSessionKey, deps.ownerAgentId);
        if (current.taskKind === plannedRoutebookTaskKind && !finalizationPlan) {
          throw new Error(
            "ROUTEBOOK_GENERATION spawn requires resultPlan with spaceId, artifactTitle, artifactFilePath, artifactType, and cardCaption",
          );
        }
        if (
          current.taskKind === plannedRoutebookTaskKind &&
          finalizationPlan?.artifactType !== "html"
        ) {
          throw new Error("ROUTEBOOK_GENERATION result plan requires an HTML Artifact");
        }
        if (current.taskKind !== plannedRoutebookTaskKind && finalizationPlan) {
          throw new Error("FlowOS Execution result plan is only available to ROUTEBOOK_GENERATION");
        }
        if (current.targetAgentId) {
          if (current.targetAgentId !== targetAgentId) {
            throw new Error("FlowOS Execution Attempt is already assigned to another agent");
          }
          if (!sameFinalizationPlan(current.finalizationPlan, finalizationPlan)) {
            throw new Error("FlowOS Execution result plan does not match the accepted spawn");
          }
          return current;
        }
        const detail = await deps.client.detail(params.executionId);
        if (
          detail.currentAttemptId !== params.attemptId ||
          detail.ownerAgentId !== deps.ownerAgentId ||
          !activeStatuses.has(detail.status)
        ) {
          throw new Error("FlowOS Execution is not eligible for subagent spawn");
        }
        if (finalizationPlan && detail.spaceId !== finalizationPlan.spaceId) {
          throw new Error("FlowOS Execution result plan does not match the bound space");
        }
        const childKey = childSessionKey(targetAgentId, params.executionId, params.attemptId);
        const runId = stableRunId(params.executionId, params.attemptId, targetAgentId);
        const claim = await deps.bindings.claimSpawn({
          executionId: params.executionId,
          attemptId: params.attemptId,
          targetAgentId,
          childSessionKey: childKey,
          runId,
          finalizationPlan,
          now: Date.now(),
        });
        if (!claim.claimed) {
          return claim.binding;
        }
        let run: { runId: string };
        try {
          run = await deps.api.runtime.subagent.run({
            sessionKey: childKey,
            message:
              `[FlowOS Execution]\nexecutionId=${params.executionId}\nattemptId=${params.attemptId}\n` +
              "Only report structured progress with flowos_execution_stage. Do not complete or fail the Execution.\n\n" +
              params.task,
            deliver: false,
            lightContext: true,
            lane: `flowos-execution:${params.executionId}`,
            idempotencyKey: runId,
          });
        } catch (error) {
          const pending: RunBinding = {
            ...claim.binding,
            status: "SPAWN_FAILED_PENDING_SYNC",
            updatedAt: Date.now(),
          };
          await deps.bindings
            .save(pending)
            .catch(async () => await deps.bindings.save(pending))
            .catch(() => undefined);
          rejected = { error, binding: pending };
          return pending;
        }
        const running: RunBinding = {
          ...claim.binding,
          runId: run.runId,
          status: "RUNNING",
          updatedAt: Date.now(),
        };
        await deps.bindings.save(running);
        deps.runtime.markSpawnAccepted(running);
        return running;
      });
      if (rejected) {
        await deps.runtime.syncSpawnFailure(rejected.binding);
        throw rejected.error;
      }
      return jsonResult(result);
    },
  };

  const complete: AnyAgentTool = {
    name: "flowos_execution_complete",
    label: "FlowOS Execution Complete",
    description:
      "Register one validated Space Artifact, persist its requester card, then complete the owner Execution.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: Type.Integer({ minimum: 1 }),
        spaceId: Type.String({ minLength: 1, maxLength: 128 }),
        artifactTitle: Type.String({ minLength: 1, maxLength: 160 }),
        artifactFilePath: Type.String({ minLength: 1, maxLength: 512 }),
        artifactType: Type.Union([Type.Literal("html"), Type.Literal("markdown")]),
        cardCaption: Type.String({ minLength: 1, maxLength: 500 }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId: string;
        expectedVersion: number;
        spaceId: string;
        artifactTitle: string;
        artifactFilePath: string;
        artifactType: "html" | "markdown";
        cardCaption: string;
      };
      return await deps.locks.run(params.executionId, params.attemptId, async () => {
        const sessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
        const binding = await deps.bindings.byExecution(params.executionId, params.attemptId);
        if (!binding) {
          throw new Error("FlowOS Execution binding not found");
        }
        requireOwnerBinding(binding, sessionKey, deps.ownerAgentId);
        if (binding.finalizationPlan) {
          throw new Error(
            "FlowOS Execution owner completion is unavailable after result plan acceptance",
          );
        }
        if (!binding.targetAgentId || binding.status !== "ENDED_OK") {
          throw new Error("FlowOS Execution child run has not ended successfully");
        }
        const current = await requireCurrentExecution(deps, binding, params.expectedVersion);
        if (current.spaceId !== params.spaceId) {
          throw new Error("Space Artifact does not match the bound Execution space");
        }
        if (current.stageKey !== "validating") {
          throw new Error("FlowOS Execution is not in the validating stage");
        }
        const validation = await deps.validateArtifact({
          spaceId: params.spaceId,
          filePath: params.artifactFilePath,
          artifactType: params.artifactType,
        });
        const resultRef = await deps.client.registerSpaceArtifact(params.executionId, {
          attemptId: params.attemptId,
          expectedVersion: current.version,
          title: params.artifactTitle,
          filePath: params.artifactFilePath,
          artifactType: params.artifactType,
          ...validation,
        });
        const item = await deps.runtime.prepareAndCompleteResult(binding, {
          expectedVersion: current.version,
          resultRef,
          card: {
            spaceId: params.spaceId,
            artifactTitle: params.artifactTitle,
            artifactFilePath: params.artifactFilePath,
            caption: params.cardCaption,
          },
        });
        return jsonResult(item);
      });
    },
  };

  const fail: AnyAgentTool = {
    name: "flowos_execution_fail",
    label: "FlowOS Execution Fail",
    description: "Fail the owner session Execution with a fixed safe error code.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        executionId: Type.String({ minLength: 1, maxLength: 128 }),
        attemptId: Type.String({ minLength: 1, maxLength: 128 }),
        expectedVersion: Type.Integer({ minimum: 1 }),
        errorCode: Type.Union(errorCodes.map((value) => Type.Literal(value))),
        retryable: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, args) {
      const params = args as {
        executionId: string;
        attemptId: string;
        expectedVersion: number;
        errorCode: (typeof errorCodes)[number];
        retryable?: boolean;
      };
      return await deps.locks.run(params.executionId, params.attemptId, async () => {
        const sessionKey = requireOwnerContext(deps.context, deps.ownerAgentId);
        const binding = await deps.bindings.byExecution(params.executionId, params.attemptId);
        if (!binding) {
          throw new Error("FlowOS Execution binding not found");
        }
        requireOwnerBinding(binding, sessionKey, deps.ownerAgentId);
        if (binding.finalizationPlan) {
          throw new Error(
            "FlowOS Execution owner failure is unavailable after result plan acceptance",
          );
        }
        const current = await requireCurrentExecution(deps, binding, params.expectedVersion);
        const item = await deps.client.fail(params.executionId, {
          expectedVersion: current.version,
          errorCode: params.errorCode,
          retryable: params.retryable ?? false,
        });
        await deps.runtime.markOwnerFailed(binding);
        return jsonResult(item);
      });
    },
  };

  return [start, stage, spawn, complete, fail];
}
