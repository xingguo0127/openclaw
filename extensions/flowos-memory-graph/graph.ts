import fs from "node:fs/promises";
import path from "node:path";

// Produced by the kg-worker (graph.json contract §2.1); phase 1 could also be hand-placed.
export const KNOWLEDGE_GRAPH_REL_PATH = path.join("memory", "knowledge-graph.json");

export type KnowledgeGraphRead = {
  found: boolean;
  path: string;
  graph?: unknown;
  updatedAtMs?: number;
};

/** Read the graph file from a workspace. Symlink / non-file / missing / unparsable => found=false, never throws. */
export async function readKnowledgeGraph(workspaceDir: string): Promise<KnowledgeGraphRead> {
  const filePath = path.join(workspaceDir, KNOWLEDGE_GRAPH_REL_PATH);
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    return { found: false, path: KNOWLEDGE_GRAPH_REL_PATH };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return { found: false, path: KNOWLEDGE_GRAPH_REL_PATH };
  }
  try {
    const graph = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
    return {
      found: true,
      path: KNOWLEDGE_GRAPH_REL_PATH,
      graph,
      updatedAtMs: Math.floor(stat.mtimeMs),
    };
  } catch {
    return { found: false, path: KNOWLEDGE_GRAPH_REL_PATH };
  }
}

/**
 * Lazy slice to bound response size (the full graph can be hundreds of KB and would hit the
 * talk-channel size limit).
 * parentId=null  -> only tier<3 (categories/dimensions: the drill-down skeleton)
 * parentId=<id>  -> only that dimension's tier-3 leaves (with content/facts/related)
 * person/categories/edges are small and kept as-is; the client merges leaves into its skeleton.
 */
export function sliceKnowledgeGraph(graph: unknown, parentId: string | null): unknown {
  if (!graph || typeof graph !== "object") {
    return graph;
  }
  const g = graph as Record<string, unknown>;
  const nodes = Array.isArray(g.nodes) ? (g.nodes as Array<Record<string, unknown>>) : [];
  const picked = nodes.filter((n) => {
    const tier = typeof n.tier === "number" ? n.tier : 2;
    return parentId === null ? tier < 3 : tier === 3 && n.parentId === parentId;
  });
  return { ...g, nodes: picked };
}
