import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { readKnowledgeGraph, sliceKnowledgeGraph } from "./graph.js";

function defaultAgentId(config: {
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  return normalizeAgentId(agents.find((item) => item.default)?.id ?? agents[0]?.id ?? "main");
}

export default definePluginEntry({
  id: "flowos-memory-graph",
  name: "FlowOS Memory Graph",
  description: "Read-only personal knowledge graph for the FlowOS app",
  register(api) {
    // Replaces the former core method doctor.memory.knowledgeGraph (same payload shape).
    api.registerGatewayMethod(
      "flowos.memory.knowledgeGraph",
      async ({ params, respond }) => {
        const requested =
          typeof params?.agentId === "string" ? normalizeAgentId(params.agentId) : "";
        const agentId = requested || defaultAgentId(api.config);
        const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
        const read = await readKnowledgeGraph(workspaceDir);
        const parentId = typeof params?.parentId === "string" ? params.parentId : null;
        respond(true, {
          agentId,
          found: read.found,
          path: read.path,
          updatedAtMs: read.updatedAtMs,
          graph: read.found ? sliceKnowledgeGraph(read.graph, parentId) : undefined,
        });
      },
      { scope: "operator.read" },
    );
  },
});
