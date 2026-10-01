import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readKnowledgeGraph, sliceKnowledgeGraph } from "./graph.js";
import plugin from "./index.js";

const graph = {
  person: { name: "p" },
  nodes: [
    { id: "c1", tier: 1 },
    { id: "d1", tier: 2, parentId: "c1" },
    { id: "l1", tier: 3, parentId: "d1" },
    { id: "l2", tier: 3, parentId: "d2" },
    { id: "legacy" },
  ],
  edges: [],
};

function workspace(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-"));
  if (content !== undefined) {
    fs.mkdirSync(path.join(dir, "memory"));
    fs.writeFileSync(path.join(dir, "memory", "knowledge-graph.json"), content);
  }
  return dir;
}

describe("flowos-memory-graph", () => {
  it("slices skeleton (tier<3) without parentId and one dimension's leaves with it", () => {
    const skeleton = sliceKnowledgeGraph(graph, null) as { nodes: Array<{ id: string }> };
    expect(skeleton.nodes.map((n) => n.id)).toEqual(["c1", "d1", "legacy"]);
    const leaves = sliceKnowledgeGraph(graph, "d1") as { nodes: Array<{ id: string }> };
    expect(leaves.nodes.map((n) => n.id)).toEqual(["l1"]);
  });

  it("reads found/missing/corrupt/symlink without throwing", async () => {
    expect((await readKnowledgeGraph(workspace(JSON.stringify(graph)))).found).toBe(true);
    expect((await readKnowledgeGraph(workspace())).found).toBe(false);
    expect((await readKnowledgeGraph(workspace("{not json"))).found).toBe(false);
    const dir = workspace();
    fs.mkdirSync(path.join(dir, "memory"));
    const target = path.join(workspace(JSON.stringify(graph)), "memory", "knowledge-graph.json");
    fs.symlinkSync(target, path.join(dir, "memory", "knowledge-graph.json"));
    expect((await readKnowledgeGraph(dir)).found).toBe(false);
  });

  it("registers flowos.memory.knowledgeGraph (operator.read) and serves the default agent", async () => {
    const ws = workspace(JSON.stringify(graph));
    const registerGatewayMethod = vi.fn();
    const resolveAgentWorkspaceDir = vi.fn(() => ws);
    plugin.register({
      config: { agents: { list: [{ id: "Main", default: true }] } },
      registerGatewayMethod,
      runtime: { agent: { resolveAgentWorkspaceDir } },
    } as never);
    const [name, handler, opts] = registerGatewayMethod.mock.calls[0]!;
    expect(name).toBe("flowos.memory.knowledgeGraph");
    expect(opts).toEqual({ scope: "operator.read" });
    const respond = vi.fn();
    await handler({ params: { parentId: "d1" }, respond });
    expect(resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.anything(), "main");
    const payload = respond.mock.calls[0]![1];
    expect(payload).toMatchObject({
      agentId: "main",
      found: true,
      path: "memory/knowledge-graph.json",
    });
    expect(payload.graph.nodes.map((n: { id: string }) => n.id)).toEqual(["l1"]);
  });
});
