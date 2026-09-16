import { createHmac } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { injectMessageBySessionKey } from "openclaw/plugin-sdk/celia-card-inject";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { RunBindingStore } from "./src/bindings.js";
import {
  createAssistRequest,
  FlowosExecutionClient,
  resolveTrustedAssistEndpoint,
} from "./src/client.js";
import { createImageGenerationTool, ImageGenerationRunStore } from "./src/image-generation.js";
import { getExecutionLocks } from "./src/locks.js";
import { FlowosExecutionRuntime } from "./src/runtime.js";
import { createSpaceMaterialTools } from "./src/space-materials.js";
import { createFlowosExecutionTools } from "./src/tools.js";
import {
  discardSpaceArtifactCandidate,
  validateAndPromoteSpaceArtifact,
  validateSpaceArtifact,
} from "./src/validation.js";

const pluginId = "flowos-execution-runtime";
const bindingNamespace = "run-bindings";
const executionRuntimePurpose = "flowos-execution-runtime-v1";
const imageGenerationRuntimePurpose = "flowos-image-generation-runtime-v1";
const standardOwnerAgentId = "agent:main";
const nodeSendKey = Symbol.for("openclaw.gateway.nodeSendToSession");

type NodeSend = (sessionKey: string, event: string, payload: unknown) => void;

function getNodeSend(): NodeSend | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[nodeSendKey] as NodeSend | undefined;
}

function trustedOperator(client: GatewayRequestHandlerOptions["client"]): boolean {
  return Boolean(
    client?.isDeviceTokenAuth && client.connect.role === "operator" && client.connect.device?.id,
  );
}

function reject(
  respond: GatewayRequestHandlerOptions["respond"],
  code: string,
  message: string,
): void {
  respond(false, undefined, { code, message });
}

type ResultCardParams = {
  sessionKey: string;
  executionId: string;
  attemptId: string;
  spaceId: string;
  artifactTitle: string;
  artifactFilePath: string;
  caption: string;
};

export async function deliverExecutionResultCard(
  params: ResultCardParams,
  inject: typeof injectMessageBySessionKey = injectMessageBySessionKey,
  nodeSend: NodeSend | undefined = getNodeSend(),
): Promise<void> {
  const cardJson = JSON.stringify({
    type: "resource_card",
    resourceType: "file",
    id: params.spaceId,
    title: params.artifactTitle,
    filePath: params.artifactFilePath,
    action: "create",
    caption: params.caption,
  });
  const delivered = await inject(params.sessionKey, `[celia_card]${cardJson}`, undefined, {
    idempotencyKey: `flowos-execution:${params.executionId}:${params.attemptId}:result-card`,
  });
  if (!delivered.ok) {
    throw new Error("FlowOS Execution result card delivery is unavailable");
  }
  nodeSend?.(params.sessionKey, "canvas.card.push", { cardJson });
}

function loadPrivateSecretFile(filePath: string): string {
  if (!filePath) {
    return "";
  }
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0) {
      return "";
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return "";
    }
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

export function deriveExecutionRuntimeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const master =
    env.FLOWOS_TASK_CENTER_JWT_SECRET?.trim() ||
    loadPrivateSecretFile(env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE?.trim() ?? "");
  if (Buffer.byteLength(master, "utf8") < 32) {
    return null;
  }
  return createHmac("sha256", master).update(executionRuntimePurpose).digest("hex");
}

export function deriveImageGenerationRuntimeToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const master =
    env.FLOWOS_TASK_CENTER_JWT_SECRET?.trim() ||
    loadPrivateSecretFile(env.FLOWOS_TASK_CENTER_JWT_SECRET_FILE?.trim() ?? "");
  if (Buffer.byteLength(master, "utf8") < 32) {
    return null;
  }
  return createHmac("sha256", master).update(imageGenerationRuntimePurpose).digest("hex");
}

export default definePluginEntry({
  id: pluginId,
  name: "FlowOS Execution Runtime",
  description: "Bind trusted FlowOS execution and paid capability tools to OpenClaw runs",
  register(api) {
    const endpoint = resolveTrustedAssistEndpoint(process.env.ASSIST_API_BASE);
    const token = deriveExecutionRuntimeToken();
    const imageToken = deriveImageGenerationRuntimeToken();
    if (!endpoint || !token || !imageToken) {
      throw new Error("FlowOS standard tenant identity config is required");
    }
    const ownerAgentId = standardOwnerAgentId;
    const locks = getExecutionLocks();
    const bindings = new RunBindingStore(
      api.runtime.state.openKeyedStore({
        namespace: bindingNamespace,
        maxEntries: 4096,
      }),
    );
    const client = new FlowosExecutionClient(createAssistRequest(endpoint, token));
    const imageRequest = createAssistRequest(endpoint, imageToken, { timeoutMs: 180_000 });
    const imageRuns = new ImageGenerationRunStore();
    const materialRequest = createAssistRequest(endpoint, token, {
      timeoutMs: 60_000,
      includeErrorDetails: true,
    });
    const runtime = new FlowosExecutionRuntime(
      client,
      bindings,
      api.runtime.subagent,
      api.runtime.system,
      deliverExecutionResultCard,
      api.logger,
      locks,
      (plan) =>
        validateAndPromoteSpaceArtifact({
          runtime: api.runtime,
          workspaceDir: plan.workspaceDir,
          spaceId: plan.spaceId,
          candidateFilePath: plan.artifactCandidateFilePath,
          filePath: plan.artifactFilePath,
          artifactType: plan.artifactType,
        }),
      (plan) =>
        discardSpaceArtifactCandidate({
          workspaceDir: plan.workspaceDir,
          spaceId: plan.spaceId,
          candidateFilePath: plan.artifactCandidateFilePath,
        }),
    );

    api.registerTool(
      (context) => [
        ...createSpaceMaterialTools(context, materialRequest),
        ...createFlowosExecutionTools({
          api,
          context,
          client,
          bindings,
          locks,
          runtime,
          ownerAgentId,
          validateArtifact: (params) => {
            const workspaceDir = context.workspaceDir?.trim();
            if (!workspaceDir) {
              throw new Error("FlowOS Execution validator requires a trusted workspace");
            }
            return validateSpaceArtifact({
              runtime: api.runtime,
              workspaceDir,
              ...params,
            });
          },
        }),
        createImageGenerationTool({
          context,
          request: imageRequest,
          runs: imageRuns,
          ownerAgentId,
        }),
      ],
      {
        names: [
          "flowos_execution_start",
          "flowos_execution_stage",
          "flowos_execution_spawn",
          "flowos_execution_complete",
          "flowos_execution_fail",
          "flowos_image_generate",
          "space_read",
          "space_material_ingest",
          "space_artifact_publish",
        ],
      },
    );

    api.registerGatewayMethod(
      "flowos.execution.cancel",
      async ({ params, client: gatewayClient, respond }) => {
        if (!trustedOperator(gatewayClient)) {
          reject(respond, "INVALID_REQUEST", "paired operator device authentication required");
          return;
        }
        const input = params ?? {};
        const executionId = typeof input.executionId === "string" ? input.executionId.trim() : "";
        if (
          Object.keys(input).toSorted().join(",") !== "executionId" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(executionId)
        ) {
          reject(respond, "INVALID_REQUEST", "valid executionId is required");
          return;
        }
        try {
          const item = await runtime.cancelExecution(executionId);
          respond(true, {
            executionId: item.executionId,
            status: item.status,
            version: item.version,
          });
        } catch (error) {
          api.logger.warn(
            `FlowOS Execution cancellation failed for ${executionId}: ${error instanceof Error ? error.message : "error"}`,
          );
          reject(respond, "EXECUTION_CANCEL_FAILED", "execution cancellation failed");
        }
      },
      { scope: "operator.write" },
    );

    api.on("subagent_ended", async (event, ctx) => {
      await runtime.subagentEnded(event, ctx);
    });
    api.on("gateway_start", async () => {
      await runtime.reconcile();
      api.logger.info("FlowOS Execution run bindings reconciled");
    });
  },
});
