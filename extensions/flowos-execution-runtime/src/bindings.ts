import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type RunBindingStatus =
  | "CREATED"
  | "STARTING"
  | "RUNNING"
  | "ENDED_OK_PENDING_SYNC"
  | "ENDED_ERROR_PENDING_SYNC"
  | "ENDED_OK"
  | "ENDED_ERROR"
  | "SPAWN_FAILED_PENDING_SYNC"
  | "SPAWN_FAILED";

export type ResultDelivery = {
  status: "PREPARED" | "EXECUTION_COMPLETED" | "DELIVERED" | "ABORTED";
  expectedVersion: number;
  resultRef: { type: "SPACE_ARTIFACT"; id: string; spaceId: string };
  card: {
    spaceId: string;
    artifactTitle: string;
    artifactFilePath: string;
    caption: string;
  };
};

export type FinalizationPlan = {
  workspaceDir: string;
  spaceId: string;
  artifactTitle: string;
  artifactFilePath: string;
  artifactCandidateFilePath: string;
  artifactType: "html" | "markdown";
  cardCaption: string;
};

export type FinalizationFailure = {
  errorCode: "VALIDATION_FAILED";
  retryable: false;
  outcome: "planned_validation_failed";
};

export type RunBinding = {
  executionId: string;
  attemptId: string;
  requesterSessionKey: string;
  ownerAgentId: string;
  taskKind?: string;
  targetAgentId?: string;
  childSessionKey?: string;
  runId?: string;
  status: RunBindingStatus;
  outcome?: string;
  closureWakeCount?: number;
  validationRepairCount?: number;
  finalizationPlan?: FinalizationPlan;
  finalizationFailure?: FinalizationFailure;
  resultDelivery?: ResultDelivery;
  createdAt: number;
  updatedAt: number;
};

const terminalBindingTtlMs = 6 * 60 * 60 * 1_000;

function isExpirableBinding(binding: RunBinding): boolean {
  if (binding.status === "ENDED_ERROR" || binding.status === "SPAWN_FAILED") {
    return true;
  }
  if (binding.status !== "ENDED_OK") {
    return false;
  }
  return (
    binding.resultDelivery?.status === "DELIVERED" || binding.resultDelivery?.status === "ABORTED"
  );
}

export class RunBindingStore {
  constructor(private readonly store: PluginStateKeyedStore<RunBinding>) {}

  async byExecution(executionId: string, attemptId: string): Promise<RunBinding | undefined> {
    return await this.store.lookup(this.executionKey(executionId, attemptId));
  }

  async byChild(sessionKey: string): Promise<RunBinding | undefined> {
    return (await this.canonicalEntries()).find(
      (binding) => binding.childSessionKey === sessionKey,
    );
  }

  async byRun(runId: string): Promise<RunBinding | undefined> {
    return (await this.canonicalEntries()).find((binding) => binding.runId === runId);
  }

  async save(binding: RunBinding): Promise<void> {
    await this.store.register(
      this.executionKey(binding.executionId, binding.attemptId),
      binding,
      isExpirableBinding(binding) ? { ttlMs: terminalBindingTtlMs } : undefined,
    );
  }

  async claimSpawn(params: {
    executionId: string;
    attemptId: string;
    targetAgentId: string;
    childSessionKey: string;
    runId: string;
    finalizationPlan?: FinalizationPlan;
    now: number;
  }): Promise<{ binding: RunBinding; claimed: boolean }> {
    if (!this.store.update) {
      throw new Error("FlowOS Execution binding store does not support atomic updates");
    }
    let result: RunBinding | undefined;
    let claimed = false;
    await this.store.update(this.executionKey(params.executionId, params.attemptId), (current) => {
      if (!current) {
        throw new Error("FlowOS Execution binding not found");
      }
      if (current.targetAgentId || current.status !== "CREATED") {
        result = current;
        return current;
      }
      claimed = true;
      result = {
        ...current,
        targetAgentId: params.targetAgentId,
        childSessionKey: params.childSessionKey,
        runId: params.runId,
        ...(params.finalizationPlan ? { finalizationPlan: params.finalizationPlan } : {}),
        status: "STARTING",
        updatedAt: params.now,
      };
      return result;
    });
    if (!result) {
      throw new Error("FlowOS Execution binding claim failed");
    }
    return { binding: result, claimed };
  }

  async canonicalEntries(): Promise<RunBinding[]> {
    const entries = await this.store.entries();
    return entries
      .filter((entry) => entry.key.startsWith("execution:"))
      .map((entry) => entry.value);
  }

  private executionKey(executionId: string, attemptId: string): string {
    return `execution:${executionId}:${attemptId}`;
  }
}

export function normalizeChildAgentId(agentId: string): string {
  const unprefixed = agentId.trim().replace(/^agent:/, "");
  return unprefixed.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "agent";
}

export function childSessionKey(agentId: string, executionId: string, attemptId: string): string {
  const safeAgent = normalizeChildAgentId(agentId);
  const suffix = `${executionId}-${attemptId}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  return `agent:${safeAgent}:subagent:flowos-${suffix}`;
}
