import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAndPromoteSpaceArtifact, validateSpaceArtifact } from "./validation.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(content = "<html>validated</html>", spaceId = "sp-trip") {
  const workspaceDir = mkdtempSync(join(tmpdir(), "flowos-artifact-validator-"));
  roots.push(workspaceDir);
  const generated = join(workspaceDir, "spaces", spaceId, "generated");
  const scripts = join(workspaceDir, "skills", "lushu", "scripts");
  mkdirSync(generated, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(generated, "lushu.html"), content);
  writeFileSync(join(scripts, "validate-lushu.sh"), "#!/usr/bin/env bash\nexit 0\n");
  return { workspaceDir, content };
}

describe("trusted Space Artifact validator", () => {
  it("binds a successful routebook validator run to the exact content digest", async () => {
    const { workspaceDir, content } = fixture();
    const runCommandWithTimeout = vi.fn(async () => ({ code: 0 }));

    const result = await validateSpaceArtifact({
      runtime: { system: { runCommandWithTimeout } } as never,
      workspaceDir,
      spaceId: "sp-trip",
      filePath: "generated/lushu.html",
      artifactType: "html",
    });

    expect(result).toEqual({
      validatorId: "lushu-html-v1",
      contentSha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(runCommandWithTimeout).toHaveBeenCalledWith(
      [
        "bash",
        join(workspaceDir, "skills", "lushu", "scripts", "validate-lushu.sh"),
        join(workspaceDir, "spaces", "sp-trip", "generated", "lushu.html"),
      ],
      expect.objectContaining({ cwd: workspaceDir, timeoutMs: 120_000 }),
    );
  });

  it("rejects a non-zero routebook validator result", async () => {
    const { workspaceDir } = fixture();

    await expect(
      validateSpaceArtifact({
        runtime: {
          system: {
            runCommandWithTimeout: vi.fn(async () => ({
              code: 1,
              stdout: "FAIL: card time is not updated",
              stderr: "",
            })),
          },
        } as never,
        workspaceDir,
        spaceId: "sp-trip",
        filePath: "generated/lushu.html",
        artifactType: "html",
      }),
    ).rejects.toThrow("card time is not updated");
  });

  it("publishes a validated candidate atomically without consuming the retry source", async () => {
    const { workspaceDir } = fixture("<html>old</html>");
    const generated = join(workspaceDir, "spaces", "sp-trip", "generated");
    writeFileSync(join(generated, ".lushu.attempt.candidate.html"), "<html>new</html>");

    const result = await validateAndPromoteSpaceArtifact({
      runtime: {
        system: { runCommandWithTimeout: vi.fn(async () => ({ code: 0 })) },
      } as never,
      workspaceDir,
      spaceId: "sp-trip",
      candidateFilePath: "generated/.lushu.attempt.candidate.html",
      filePath: "generated/lushu.html",
      artifactType: "html",
    });

    expect(readFileSync(join(generated, "lushu.html"), "utf8")).toBe("<html>new</html>");
    expect(readFileSync(join(generated, ".lushu.attempt.candidate.html"), "utf8")).toBe(
      "<html>new</html>",
    );
    expect(result.contentSha256).toBe(
      createHash("sha256").update("<html>new</html>").digest("hex"),
    );
  });

  it("leaves the published artifact untouched when candidate validation fails", async () => {
    const { workspaceDir } = fixture("<html>last-known-good</html>");
    const generated = join(workspaceDir, "spaces", "sp-trip", "generated");
    writeFileSync(join(generated, ".lushu.attempt.candidate.html"), "<html>invalid</html>");

    await expect(
      validateAndPromoteSpaceArtifact({
        runtime: {
          system: {
            runCommandWithTimeout: vi.fn(async () => ({
              code: 1,
              stdout: "FAIL: invalid candidate",
              stderr: "",
            })),
          },
        } as never,
        workspaceDir,
        spaceId: "sp-trip",
        candidateFilePath: "generated/.lushu.attempt.candidate.html",
        filePath: "generated/lushu.html",
        artifactType: "html",
      }),
    ).rejects.toThrow("invalid candidate");

    expect(readFileSync(join(generated, "lushu.html"), "utf8")).toBe(
      "<html>last-known-good</html>",
    );
    expect(readFileSync(join(generated, ".lushu.attempt.candidate.html"), "utf8")).toBe(
      "<html>invalid</html>",
    );
  });

  it("accepts a path-safe Unicode Space id", async () => {
    const spaceId = "sp_烟台看海_483cfc";
    const { workspaceDir } = fixture("<html>validated</html>", spaceId);
    const runCommandWithTimeout = vi.fn(async () => ({ code: 0 }));

    await expect(
      validateSpaceArtifact({
        runtime: { system: { runCommandWithTimeout } } as never,
        workspaceDir,
        spaceId,
        filePath: "generated/lushu.html",
        artifactType: "html",
      }),
    ).resolves.toMatchObject({ validatorId: "lushu-html-v1" });
  });

  it.each([
    ".",
    "..",
    "../escape",
    "sp/escape",
    "sp\\escape",
    "sp\u0000escape",
    `sp-${"a".repeat(126)}`,
  ])("rejects an unsafe Space id: %s", async (spaceId) => {
    const { workspaceDir } = fixture();
    await expect(
      validateSpaceArtifact({
        runtime: { system: { runCommandWithTimeout: vi.fn() } } as never,
        workspaceDir,
        spaceId,
        filePath: "generated/lushu.html",
        artifactType: "html",
      }),
    ).rejects.toThrow("invalid spaceId");
  });
});
