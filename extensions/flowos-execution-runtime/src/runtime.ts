import { resolve } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  type FinalizationPlan,
  RunBindingStore,
  type ResultDelivery,
  type RunBinding,
} from "./bindings.js";
import { FlowosExecutionClient, type ActiveExecution, type SpaceArtifactRef } from "./client.js";
import { ExecutionLocks } from "./locks.js";
import type { SpaceArtifactValidation } from "./validation.js";

const activeStatuses = new Set(["QUEUED", "PLANNING", "RUNNING", "AWAITING_USER", "PAUSED"]);
// Agent lifecycle hooks can fire before automatic retries, so durable bindings
// use bounded timers instead of treating an intermediate agent_end as terminal.
const spawnGuardMs = 60_000;
const closureGuardMs = 60_000;
const maxClosureWakeRetries = 2;
const maxValidationRepairRetries = 2;
const routebookRepairTimeoutSeconds = 30 * 60;

type RuntimeLogger = {
  warn(message: string): void;
  info(message: string): void;
};

type RuntimeSystem = Pick<PluginRuntime["system"], "enqueueSystemEvent" | "requestHeartbeat">;

type ResultCardDelivery = (params: {
  sessionKey: string;
  executionId: string;
  attemptId: string;
  spaceId: string;
  artifactTitle: string;
  artifactFilePath: string;
  caption: string;
}) => Promise<void>;

type PlannedArtifactValidator = (plan: FinalizationPlan) => Promise<SpaceArtifactValidation>;
type PlannedArtifactDiscarder = (plan: FinalizationPlan) => Promise<void> | void;

type EndedEvent = {
  targetSessionKey: string;
  targetKind: "subagent" | "acp";
  runId?: string;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
};

type SubagentContext = {
  childSessionKey?: string;
  requesterSessionKey?: string;
};

function terminal(binding: RunBinding): boolean {
  return (
    binding.status === "ENDED_OK" ||
    binding.status === "ENDED_ERROR" ||
    binding.status === "SPAWN_FAILED"
  );
}

function errorForOutcome(outcome: string | undefined): { errorCode: string; retryable: boolean } {
  if (outcome === "timeout") {
    return { errorCode: "PROVIDER_TIMEOUT", retryable: true };
  }
  if (outcome === "error") {
    return { errorCode: "PROVIDER_REJECTED", retryable: true };
  }
  if (outcome === "killed") {
    return { errorCode: "CANCELLED_BY_USER", retryable: false };
  }
  return { errorCode: "INTERNAL", retryable: false };
}

async function latestStillNeedsSync(
  client: FlowosExecutionClient,
  binding: RunBinding,
): Promise<ActiveExecution | null> {
  const detail = await client.detail(binding.executionId);
  if (detail.currentAttemptId !== binding.attemptId || !activeStatuses.has(detail.status)) {
    return null;
  }
  return detail;
}

function sameResultRef(actual: ActiveExecution["resultRef"], expected: SpaceArtifactRef): boolean {
  return (
    actual?.type === expected.type &&
    actual.id === expected.id &&
    actual.spaceId === expected.spaceId
  );
}

export class FlowosExecutionRuntime {
  private readonly spawnGuards = new Map<string, NodeJS.Timeout>();
  private readonly closureGuards = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly client: FlowosExecutionClient,
    private readonly bindings: RunBindingStore,
    private readonly subagent: PluginRuntime["subagent"],
    private readonly system: RuntimeSystem,
    private readonly deliverResultCard: ResultCardDelivery,
    private readonly logger: RuntimeLogger,
    private readonly locks: ExecutionLocks,
    private readonly validatePlannedArtifact?: PlannedArtifactValidator,
    private readonly discardPlannedArtifact?: PlannedArtifactDiscarder,
  ) {}

  async subagentEnded(event: EndedEvent, ctx: SubagentContext): Promise<void> {
    if (event.targetKind !== "subagent") {
      return;
    }
    const found = event.runId
      ? await this.bindings.byRun(event.runId)
      : await this.bindings.byChild(event.targetSessionKey);
    if (!found) {
      return;
    }
    let wake: { binding: RunBinding; outcome: string; version: number } | undefined;
    await this.locks.run(found.executionId, found.attemptId, async () => {
      const binding = await this.bindings.byExecution(found.executionId, found.attemptId);
      if (
        !binding ||
        terminal(binding) ||
        binding.childSessionKey !== event.targetSessionKey ||
        binding.childSessionKey !== ctx.childSessionKey ||
        (event.runId && binding.runId !== event.runId)
      ) {
        return;
      }
      const outcome = event.outcome ?? "error";
      const pending: RunBinding = {
        ...binding,
        outcome,
        status: outcome === "ok" ? "ENDED_OK_PENDING_SYNC" : "ENDED_ERROR_PENDING_SYNC",
        updatedAt: Date.now(),
      };
      await this.bindings.save(pending);
      const version = await this.syncTerminalLocked(pending);
      if (version !== null) {
        const synced = await this.bindings.byExecution(binding.executionId, binding.attemptId);
        if (outcome === "ok" && synced?.status === "ENDED_OK" && synced.finalizationPlan) {
          await this.syncOwnerClosureLocked(synced);
        } else {
          wake = { binding: synced ?? pending, outcome, version };
        }
      }
    });
    if (wake) {
      this.wakeRequester(wake.binding, wake.outcome, wake.version);
      if (wake.outcome === "ok") {
        this.watchOwnerClosure(wake.binding);
      }
    }
  }

  watchOwnerSpawn(binding: RunBinding): void {
    const key = this.bindingKey(binding);
    this.scheduleGuard(this.spawnGuards, key, spawnGuardMs, async () => {
      const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
      if (current?.status === "STARTING") {
        await this.reconcileStarting(current);
        return;
      }
      await this.locks.run(binding.executionId, binding.attemptId, async () => {
        const locked = await this.bindings.byExecution(binding.executionId, binding.attemptId);
        if (locked?.status === "SPAWN_FAILED_PENDING_SYNC") {
          await this.syncSpawnFailureLocked(locked);
          return;
        }
        if (locked?.status !== "CREATED") {
          return;
        }
        const pending: RunBinding = {
          ...locked,
          status: "SPAWN_FAILED_PENDING_SYNC",
          updatedAt: Date.now(),
        };
        await this.bindings.save(pending);
        await this.syncSpawnFailureLocked(pending);
      });
    });
  }

  markSpawnAccepted(binding: RunBinding): void {
    this.clearGuard(this.spawnGuards, this.bindingKey(binding));
  }

  markTerminal(binding: RunBinding): void {
    const key = this.bindingKey(binding);
    this.clearGuard(this.spawnGuards, key);
    this.clearGuard(this.closureGuards, key);
  }

  async markOwnerFailed(binding: RunBinding): Promise<void> {
    const failed: RunBinding = {
      ...binding,
      status: "ENDED_ERROR",
      outcome: "owner_failed",
      updatedAt: Date.now(),
    };
    await this.bindings.save(failed);
    this.markTerminal(failed);
  }

  async cancelExecution(executionId: string): Promise<ActiveExecution> {
    const initial = await this.client.detail(executionId);
    const attemptId = initial.currentAttemptId;
    if (!attemptId) {
      throw new Error("FlowOS Execution has no active Attempt");
    }
    let childSessionKey: string | undefined;
    let stoppedBinding: RunBinding | undefined;
    const cancelled = await this.locks.run(executionId, attemptId, async () => {
      const current = await this.client.detail(executionId);
      if (current.currentAttemptId !== attemptId) {
        throw new Error("FlowOS Execution Attempt changed before cancellation");
      }
      const item = await this.client.cancel(executionId, current.version);
      const binding = await this.bindings.byExecution(executionId, attemptId);
      if (binding && !terminal(binding)) {
        childSessionKey = binding.childSessionKey;
        const stopped: RunBinding = {
          ...binding,
          status: "ENDED_ERROR",
          outcome: "killed",
          updatedAt: Date.now(),
        };
        await this.bindings.save(stopped);
        stoppedBinding = stopped;
        this.markTerminal(stopped);
      }
      return item;
    });
    if (childSessionKey) {
      await this.subagent
        .deleteSession({ sessionKey: childSessionKey, deleteTranscript: false })
        .catch((error: unknown) => {
          this.logger.warn(
            `FlowOS Execution worker stop failed for ${executionId}: ${error instanceof Error ? error.message : "error"}`,
          );
        });
    }
    if (stoppedBinding) {
      await this.discardCandidate(stoppedBinding);
    }
    return cancelled;
  }

  async prepareAndCompleteResult(
    binding: RunBinding,
    params: {
      expectedVersion: number;
      resultRef: SpaceArtifactRef;
      card: ResultDelivery["card"];
    },
  ): Promise<ActiveExecution> {
    const prepared: RunBinding = {
      ...binding,
      resultDelivery: {
        status: "PREPARED",
        expectedVersion: params.expectedVersion,
        resultRef: params.resultRef,
        card: params.card,
      },
      updatedAt: Date.now(),
    };
    await this.bindings.save(prepared);
    try {
      return await this.syncResultDeliveryLocked(prepared);
    } catch (error) {
      await this.watchResultDeliveryIfPending(prepared);
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    for (const binding of await this.bindings.canonicalEntries()) {
      if (binding.status === "CREATED" || binding.status === "STARTING") {
        // Registry restoration and plugin gateway_start can race. The bounded
        // guard queries the durable run record after startup settles.
        this.watchOwnerSpawn(binding);
        continue;
      }
      if (binding.status === "ENDED_OK") {
        await this.locks.run(binding.executionId, binding.attemptId, async () => {
          const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
          if (current?.status === "ENDED_OK") {
            await this.syncOwnerClosureLocked(current);
          }
        });
        continue;
      }
      if (binding.status === "SPAWN_FAILED_PENDING_SYNC") {
        await this.locks.run(binding.executionId, binding.attemptId, async () => {
          const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
          if (current?.status === "SPAWN_FAILED_PENDING_SYNC") {
            await this.syncSpawnFailureLocked(current);
          }
        });
        continue;
      }
      if (binding.status.endsWith("_PENDING_SYNC")) {
        await this.locks.run(binding.executionId, binding.attemptId, async () => {
          const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
          if (current?.status.endsWith("_PENDING_SYNC")) {
            const version = await this.syncTerminalLocked(current);
            if (version !== null) {
              const synced = await this.bindings.byExecution(
                current.executionId,
                current.attemptId,
              );
              if (synced?.status === "ENDED_OK" && synced.finalizationPlan) {
                await this.syncOwnerClosureLocked(synced);
              } else {
                this.wakeRequester(synced ?? current, current.outcome ?? "error", version);
                if (current.outcome === "ok") {
                  this.watchOwnerClosure(synced ?? current);
                }
              }
            }
          }
        });
        continue;
      }
      if (binding.status !== "RUNNING" || !binding.runId || !binding.childSessionKey) {
        continue;
      }
      const result = await this.subagent
        .waitForRun({ runId: binding.runId, timeoutMs: 1 })
        .catch(() => undefined);
      if (!result || result.status === "timeout") {
        continue;
      }
      await this.subagentEnded(
        {
          targetSessionKey: binding.childSessionKey,
          targetKind: "subagent",
          runId: binding.runId,
          outcome: result.status === "ok" ? "ok" : "error",
        },
        {
          childSessionKey: binding.childSessionKey,
          requesterSessionKey: binding.requesterSessionKey,
        },
      );
    }
  }

  async syncSpawnFailure(binding: RunBinding): Promise<void> {
    await this.locks.run(binding.executionId, binding.attemptId, async () => {
      const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
      const candidate =
        current?.status === "SPAWN_FAILED_PENDING_SYNC"
          ? current
          : current?.status === "STARTING" && current.runId === binding.runId
            ? binding
            : undefined;
      if (candidate) {
        await this.syncSpawnFailureLocked(candidate);
      }
    });
  }

  private async syncSpawnFailureLocked(binding: RunBinding): Promise<void> {
    try {
      const detail = await latestStillNeedsSync(this.client, binding);
      if (detail) {
        await this.client.fail(binding.executionId, {
          expectedVersion: detail.version,
          errorCode: "INTERNAL",
          retryable: true,
        });
      }
      await this.bindings.save({
        ...binding,
        status: "SPAWN_FAILED",
        updatedAt: Date.now(),
      });
      this.markTerminal(binding);
    } catch (error) {
      this.logger.warn(
        `FlowOS Execution spawn failure sync deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
      this.watchOwnerSpawn(binding);
    }
  }

  private async reconcileStarting(binding: RunBinding): Promise<void> {
    const runStatus = await this.subagent.getRunStatus({
      runId: binding.runId ?? "",
      sessionKey: binding.childSessionKey ?? "",
    });
    if (runStatus.status === "missing") {
      await this.locks.run(binding.executionId, binding.attemptId, async () => {
        const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
        if (current?.status !== "STARTING") {
          return;
        }
        const pending = {
          ...current,
          status: "SPAWN_FAILED_PENDING_SYNC" as const,
          updatedAt: Date.now(),
        };
        await this.bindings.save(pending);
        await this.syncSpawnFailureLocked(pending);
      });
      return;
    }

    let recovered: RunBinding | undefined;
    await this.locks.run(binding.executionId, binding.attemptId, async () => {
      const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
      if (current?.status !== "STARTING") {
        return;
      }
      recovered = { ...current, status: "RUNNING", updatedAt: Date.now() };
      await this.bindings.save(recovered);
      this.markSpawnAccepted(recovered);
    });
    if (!recovered || runStatus.status !== "ended") {
      return;
    }
    await this.subagentEnded(
      {
        targetSessionKey: recovered.childSessionKey ?? "",
        targetKind: "subagent",
        runId: recovered.runId,
        outcome: runStatus.outcome,
      },
      {
        childSessionKey: recovered.childSessionKey,
        requesterSessionKey: recovered.requesterSessionKey,
      },
    );
  }

  private async syncTerminalLocked(binding: RunBinding): Promise<number | null> {
    try {
      const detail = await latestStillNeedsSync(this.client, binding);
      let syncedVersion = detail?.version ?? null;
      if (detail) {
        if (binding.outcome === "ok") {
          if (detail.stageKey !== "validating") {
            const validating = await this.client.stage(binding.executionId, {
              expectedVersion: detail.version,
              stageKey: "validating",
              stageLabel: "正在验证结果",
              progress: 0.95,
            });
            syncedVersion = validating.version;
          }
        } else {
          const failure = errorForOutcome(binding.outcome);
          const failed = await this.client.fail(binding.executionId, {
            expectedVersion: detail.version,
            ...failure,
          });
          syncedVersion = failed.version;
          await this.discardCandidate(binding);
        }
      }
      await this.bindings.save({
        ...binding,
        status: binding.outcome === "ok" ? "ENDED_OK" : "ENDED_ERROR",
        updatedAt: Date.now(),
      });
      return syncedVersion;
    } catch (error) {
      this.logger.warn(
        `FlowOS Execution terminal sync deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
      this.watchOwnerClosure(binding);
      return null;
    }
  }

  private async syncOwnerClosureLocked(binding: RunBinding): Promise<void> {
    if (binding.resultDelivery?.status === "DELIVERED") {
      return;
    }
    if (binding.resultDelivery) {
      try {
        await this.syncResultDeliveryLocked(binding);
      } catch (error) {
        this.logger.warn(
          `FlowOS Execution result delivery deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
        );
        await this.watchResultDeliveryIfPending(binding);
      }
      return;
    }
    if (binding.finalizationFailure) {
      try {
        await this.syncPlannedFailureLocked(binding);
      } catch (error) {
        this.logger.warn(
          `FlowOS Execution planned failure sync deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
        );
        this.watchOwnerClosure(binding);
      }
      return;
    }
    if (binding.finalizationPlan) {
      try {
        await this.syncPlannedFinalizationLocked(binding);
      } catch (error) {
        this.logger.warn(
          `FlowOS Execution planned finalization deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
        );
        try {
          await this.deferPlannedFinalizationLocked(binding);
        } catch (deferError) {
          this.logger.warn(
            `FlowOS Execution planned finalization failure sync deferred for ${binding.executionId}: ${deferError instanceof Error ? deferError.message : "error"}`,
          );
          this.watchOwnerClosure(binding);
        }
      }
      return;
    }
    try {
      const detail = await latestStillNeedsSync(this.client, binding);
      if (!detail) {
        return;
      }
      const wakeCount = binding.closureWakeCount ?? 0;
      if (wakeCount < maxClosureWakeRetries) {
        const retrying = {
          ...binding,
          closureWakeCount: wakeCount + 1,
          updatedAt: Date.now(),
        };
        await this.bindings.save(retrying);
        this.wakeRequester(retrying, "ok", detail.version);
        this.watchOwnerClosure(retrying);
        return;
      }
      await this.client.fail(binding.executionId, {
        expectedVersion: detail.version,
        errorCode: "INTERNAL",
        retryable: true,
      });
      await this.bindings.save({
        ...binding,
        status: "ENDED_ERROR",
        outcome: "owner_closure_failed",
        updatedAt: Date.now(),
      });
      this.markTerminal(binding);
    } catch (error) {
      this.logger.warn(
        `FlowOS Execution owner closure sync deferred for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
      this.watchOwnerClosure(binding);
    }
  }

  private async syncPlannedFinalizationLocked(binding: RunBinding): Promise<void> {
    const plan = binding.finalizationPlan;
    if (!plan || !this.validatePlannedArtifact) {
      throw new Error("FlowOS Execution planned finalizer is unavailable");
    }
    const detail = await this.client.detail(binding.executionId);
    if (
      detail.currentAttemptId !== binding.attemptId ||
      detail.ownerAgentId !== binding.ownerAgentId ||
      !activeStatuses.has(detail.status)
    ) {
      await this.bindings.save({
        ...binding,
        status: "ENDED_ERROR",
        outcome: "planned_finalization_no_longer_active",
        updatedAt: Date.now(),
      });
      this.markTerminal(binding);
      return;
    }
    if (detail.spaceId !== plan.spaceId || detail.stageKey !== "validating") {
      throw new Error("FlowOS Execution planned result no longer matches the active Execution");
    }

    let validation: SpaceArtifactValidation;
    try {
      validation = await this.validatePlannedArtifact(plan);
    } catch (error) {
      if (await this.retryPlannedValidationLocked(binding, error)) {
        return;
      }
      await this.discardCandidate(binding);
      const failedValidation: RunBinding = {
        ...binding,
        finalizationFailure: {
          errorCode: "VALIDATION_FAILED",
          retryable: false,
          outcome: "planned_validation_failed",
        },
        updatedAt: Date.now(),
      };
      await this.bindings.save(failedValidation);
      await this.syncPlannedFailureLocked(failedValidation);
      this.logger.warn(
        `FlowOS Execution planned artifact validation failed for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
      return;
    }

    const resultRef = await this.client.registerSpaceArtifact(binding.executionId, {
      attemptId: binding.attemptId,
      expectedVersion: detail.version,
      title: plan.artifactTitle,
      filePath: plan.artifactFilePath,
      artifactType: plan.artifactType,
      ...validation,
    });
    await this.prepareAndCompleteResult(binding, {
      expectedVersion: detail.version,
      resultRef,
      card: {
        spaceId: plan.spaceId,
        artifactTitle: plan.artifactTitle,
        artifactFilePath: plan.artifactFilePath,
        caption: plan.cardCaption,
      },
    });
    await this.discardCandidate(binding);
  }

  private async retryPlannedValidationLocked(
    binding: RunBinding,
    error: unknown,
  ): Promise<boolean> {
    const plan = binding.finalizationPlan;
    const childSessionKey = binding.childSessionKey;
    const repairCount = binding.validationRepairCount ?? 0;
    if (!plan || !childSessionKey || repairCount >= maxValidationRepairRetries) {
      return false;
    }
    const nextRepairCount = repairCount + 1;
    const candidatePath = resolve(
      plan.workspaceDir,
      "spaces",
      plan.spaceId,
      ...plan.artifactCandidateFilePath.split("/"),
    );
    const reason = error instanceof Error ? error.message : "validator rejected the candidate";
    const run = await this.subagent.run({
      sessionKey: childSessionKey,
      message:
        `[FlowOS validation repair ${nextRepairCount}/${maxValidationRepairRetries}]\n` +
        `The trusted Runtime validator rejected ${candidatePath}.\n` +
        `${reason}\n\n` +
        "Repair the candidate in place, rerun validate-lushu.sh, and end only after EXIT 0. " +
        "Do not write the published artifact path and do not complete or fail the Execution.",
      deliver: false,
      lightContext: true,
      lane: `flowos-execution:${binding.executionId}`,
      idempotencyKey: `flowos-validation-repair:${binding.executionId}:${binding.attemptId}:${nextRepairCount}`,
      runTimeoutSeconds: routebookRepairTimeoutSeconds,
    });
    const retrying: RunBinding = {
      ...binding,
      runId: run.runId,
      status: "RUNNING",
      outcome: undefined,
      closureWakeCount: 0,
      validationRepairCount: nextRepairCount,
      updatedAt: Date.now(),
    };
    await this.bindings.save(retrying);
    this.logger.info(
      `FlowOS Execution resumed ${binding.executionId} for planned validation repair ${nextRepairCount}`,
    );
    return true;
  }

  private async discardCandidate(binding: RunBinding): Promise<void> {
    if (!binding.finalizationPlan || !this.discardPlannedArtifact) {
      return;
    }
    try {
      await this.discardPlannedArtifact(binding.finalizationPlan);
    } catch (error) {
      this.logger.warn(
        `FlowOS Execution candidate cleanup failed for ${binding.executionId}: ${error instanceof Error ? error.message : "error"}`,
      );
    }
  }

  private async syncPlannedFailureLocked(binding: RunBinding): Promise<void> {
    const failure = binding.finalizationFailure;
    if (!failure) {
      throw new Error("FlowOS Execution planned failure is unavailable");
    }
    const detail = await this.client.detail(binding.executionId);
    if (
      detail.currentAttemptId === binding.attemptId &&
      detail.ownerAgentId === binding.ownerAgentId &&
      activeStatuses.has(detail.status)
    ) {
      await this.client.fail(binding.executionId, {
        expectedVersion: detail.version,
        errorCode: failure.errorCode,
        retryable: failure.retryable,
      });
    }
    const failed: RunBinding = {
      ...binding,
      status: "ENDED_ERROR",
      outcome: failure.outcome,
      updatedAt: Date.now(),
    };
    await this.bindings.save(failed);
    this.markTerminal(failed);
  }

  private async deferPlannedFinalizationLocked(binding: RunBinding): Promise<void> {
    const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
    if (!current || current.status !== "ENDED_OK") {
      return;
    }
    if (current.finalizationFailure) {
      this.watchOwnerClosure(current);
      return;
    }
    if (
      current.resultDelivery?.status === "PREPARED" ||
      current.resultDelivery?.status === "EXECUTION_COMPLETED"
    ) {
      this.watchOwnerClosure(current);
      return;
    }
    const retryCount = current.closureWakeCount ?? 0;
    if (retryCount < maxClosureWakeRetries) {
      const retrying = {
        ...current,
        closureWakeCount: retryCount + 1,
        updatedAt: Date.now(),
      };
      await this.bindings.save(retrying);
      this.watchOwnerClosure(retrying);
      return;
    }
    const detail = await latestStillNeedsSync(this.client, current);
    if (detail) {
      await this.client.fail(current.executionId, {
        expectedVersion: detail.version,
        errorCode: "INTERNAL",
        retryable: true,
      });
    }
    const failed: RunBinding = {
      ...current,
      status: "ENDED_ERROR",
      outcome: "planned_finalization_failed",
      updatedAt: Date.now(),
    };
    await this.bindings.save(failed);
    this.markTerminal(failed);
  }

  private async syncResultDeliveryLocked(binding: RunBinding): Promise<ActiveExecution> {
    const delivery = binding.resultDelivery;
    if (!delivery) {
      throw new Error("FlowOS Execution result delivery is not prepared");
    }
    let detail = await this.client.detail(binding.executionId);
    if (delivery.status === "ABORTED") {
      throw new Error("FlowOS Execution result delivery was aborted");
    }
    if (delivery.status === "DELIVERED") {
      return detail;
    }
    if (activeStatuses.has(detail.status)) {
      if (detail.currentAttemptId !== binding.attemptId) {
        await this.abortResultDelivery(binding, delivery, "result_attempt_replaced");
        throw new Error("FlowOS Execution Attempt changed after result preparation");
      }
      if (detail.version !== delivery.expectedVersion) {
        await this.client.fail(binding.executionId, {
          expectedVersion: detail.version,
          errorCode: "CONFLICT",
          retryable: false,
        });
        await this.abortResultDelivery(binding, delivery, "result_version_conflict");
        throw new Error("FlowOS Execution version changed after result preparation");
      }
      detail = await this.client.complete({
        executionId: binding.executionId,
        expectedVersion: delivery.expectedVersion,
        resultRef: delivery.resultRef,
      });
    }
    if (detail.status !== "SUCCEEDED" || !sameResultRef(detail.resultRef, delivery.resultRef)) {
      await this.abortResultDelivery(binding, delivery, "result_delivery_aborted");
      throw new Error("FlowOS Execution did not complete with the prepared result");
    }

    const completed: RunBinding = {
      ...binding,
      resultDelivery: { ...delivery, status: "EXECUTION_COMPLETED" },
      updatedAt: Date.now(),
    };
    await this.bindings.save(completed);
    await this.deliverResultCard({
      sessionKey: binding.requesterSessionKey,
      executionId: binding.executionId,
      attemptId: binding.attemptId,
      ...delivery.card,
    });
    const delivered: RunBinding = {
      ...completed,
      resultDelivery: { ...delivery, status: "DELIVERED" },
      updatedAt: Date.now(),
    };
    await this.bindings.save(delivered);
    this.markTerminal(delivered);
    return detail;
  }

  private async abortResultDelivery(
    binding: RunBinding,
    delivery: ResultDelivery,
    outcome: string,
  ): Promise<void> {
    const aborted: RunBinding = {
      ...binding,
      status: "ENDED_ERROR",
      outcome,
      resultDelivery: { ...delivery, status: "ABORTED" },
      updatedAt: Date.now(),
    };
    await this.bindings.save(aborted);
    this.markTerminal(aborted);
  }

  private async watchResultDeliveryIfPending(binding: RunBinding): Promise<void> {
    const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
    if (
      current?.resultDelivery?.status === "PREPARED" ||
      current?.resultDelivery?.status === "EXECUTION_COMPLETED"
    ) {
      this.watchOwnerClosure(current);
    }
  }

  private wakeRequester(binding: RunBinding, outcome: string, version: number): void {
    const event =
      `[FlowOS Execution]\nexecutionId=${binding.executionId}\nattemptId=${binding.attemptId}\n` +
      `outcome=${outcome}\nversion=${version}\n` +
      (outcome === "ok"
        ? "The child run ended successfully. You must now run the business validator and call flowos_execution_complete, or call flowos_execution_fail. Do not finish this turn while the Execution is active."
        : "The child run ended unsuccessfully. Report the controlled failure; do not complete the Execution.");
    const queued = this.system.enqueueSystemEvent(event, {
      sessionKey: binding.requesterSessionKey,
      contextKey: `flowos-execution:${binding.executionId}:${binding.attemptId}:ended`,
    });
    if (queued) {
      this.system.requestHeartbeat({
        source: "background-task",
        intent: "immediate",
        reason: "background-task",
        sessionKey: binding.requesterSessionKey,
      });
    }
  }

  private watchOwnerClosure(binding: RunBinding): void {
    const key = this.bindingKey(binding);
    this.scheduleGuard(this.closureGuards, key, closureGuardMs, async () => {
      await this.locks.run(binding.executionId, binding.attemptId, async () => {
        const current = await this.bindings.byExecution(binding.executionId, binding.attemptId);
        if (current?.status.endsWith("_PENDING_SYNC")) {
          const version = await this.syncTerminalLocked(current);
          if (version !== null) {
            const synced = await this.bindings.byExecution(current.executionId, current.attemptId);
            if (synced?.status === "ENDED_OK" && synced.finalizationPlan) {
              await this.syncOwnerClosureLocked(synced);
            } else {
              this.wakeRequester(synced ?? current, current.outcome ?? "error", version);
              if (current.outcome === "ok") {
                this.watchOwnerClosure(synced ?? current);
              }
            }
          }
          return;
        }
        if (current?.status === "ENDED_OK") {
          await this.syncOwnerClosureLocked(current);
        }
      });
    });
  }

  private scheduleGuard(
    guards: Map<string, NodeJS.Timeout>,
    key: string,
    delayMs: number,
    task: () => Promise<void>,
  ): void {
    if (guards.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      guards.delete(key);
      void task().catch((error: unknown) => {
        this.logger.warn(
          `FlowOS Execution guard failed for ${key}: ${error instanceof Error ? error.message : "error"}`,
        );
      });
    }, delayMs);
    timer.unref();
    guards.set(key, timer);
  }

  private clearGuard(guards: Map<string, NodeJS.Timeout>, key: string): void {
    const timer = guards.get(key);
    if (timer) {
      clearTimeout(timer);
      guards.delete(key);
    }
  }

  private bindingKey(binding: Pick<RunBinding, "executionId" | "attemptId">): string {
    return `${binding.executionId}:${binding.attemptId}`;
  }
}
