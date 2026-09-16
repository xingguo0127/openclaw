import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { posix, resolve, sep } from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

export type SpaceArtifactValidation = {
  validatorId: "lushu-html-v1" | "space-markdown-v1";
  contentSha256: string;
};

function contained(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function isSafeSpaceId(value: string): boolean {
  const characters = Array.from(value);
  if (characters.length < 1 || characters.length > 128 || value === "." || value === "..") {
    return false;
  }
  if (characters[0] === "." && characters[1] === ".") {
    return false;
  }
  return characters.every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character !== "/" && character !== "\\" && codePoint > 0x1f && codePoint !== 0x7f;
  });
}

function resolveArtifactDestination(params: {
  workspaceDir: string;
  spaceId: string;
  filePath: string;
}): {
  workspace: string;
  spaceRoot: string;
  target: string;
} {
  if (!isSafeSpaceId(params.spaceId)) {
    throw new Error("Space Artifact has an invalid spaceId");
  }
  const parts = params.filePath.split("/");
  if (
    parts[0] !== "generated" ||
    parts.length < 2 ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Space Artifact filePath must be a generated relative path");
  }
  const workspace = realpathSync(params.workspaceDir);
  const spaceRoot = resolve(workspace, "spaces", params.spaceId);
  const target = resolve(spaceRoot, ...parts);
  if (!contained(spaceRoot, target)) {
    throw new Error("Space Artifact escaped its Space root");
  }
  let current = spaceRoot;
  for (const part of parts.slice(0, -1)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error("Space Artifact path cannot contain symbolic links");
    }
    current = resolve(current, part);
  }
  const parentStat = lstatSync(current);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Space Artifact parent must be a real directory");
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error("Space Artifact path cannot contain symbolic links");
  }
  return { workspace, spaceRoot, target };
}

function resolveArtifactPath(params: { workspaceDir: string; spaceId: string; filePath: string }): {
  workspace: string;
  target: string;
} {
  const { workspace, spaceRoot, target } = resolveArtifactDestination(params);
  const targetStat = lstatSync(target);
  if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.size < 1) {
    throw new Error("Space Artifact must be a non-empty regular file");
  }
  if (targetStat.size > 4 * 1024 * 1024 || !contained(spaceRoot, realpathSync(target))) {
    throw new Error("Space Artifact is too large or outside its Space root");
  }
  return { workspace, target };
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function validateSpaceArtifact(params: {
  runtime: Pick<PluginRuntime, "system">;
  workspaceDir: string;
  spaceId: string;
  filePath: string;
  artifactType: "html" | "markdown";
}): Promise<SpaceArtifactValidation> {
  const { workspace, target } = resolveArtifactPath(params);
  const content = readFileSync(target);
  const contentSha256 = digest(content);
  if (params.artifactType === "markdown") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (!text.trim()) {
      throw new Error("Markdown Artifact validator rejected empty content");
    }
    return { validatorId: "space-markdown-v1", contentSha256 };
  }
  if (!target.toLowerCase().endsWith(".html")) {
    throw new Error("Routebook validator only accepts HTML artifacts");
  }
  const validator = resolve(workspace, "skills", "lushu", "scripts", "validate-lushu.sh");
  const validatorStat = lstatSync(validator);
  if (validatorStat.isSymbolicLink() || !validatorStat.isFile()) {
    throw new Error("Trusted routebook validator is unavailable");
  }
  const result = await params.runtime.system.runCommandWithTimeout(["bash", validator, target], {
    cwd: workspace,
    timeoutMs: 120_000,
    maxOutputBytes: 128 * 1024,
  });
  if (result.code !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n")
      .trim()
      .slice(-16_000);
    throw new Error(
      `Routebook validator rejected Artifact with exit ${result.code ?? "signal"}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return { validatorId: "lushu-html-v1", contentSha256 };
}

export async function validateAndPromoteSpaceArtifact(params: {
  runtime: Pick<PluginRuntime, "system">;
  workspaceDir: string;
  spaceId: string;
  candidateFilePath: string;
  filePath: string;
  artifactType: "html" | "markdown";
}): Promise<SpaceArtifactValidation> {
  if (params.candidateFilePath === params.filePath) {
    throw new Error("Space Artifact candidate must differ from its published path");
  }
  const candidate = resolveArtifactPath({
    workspaceDir: params.workspaceDir,
    spaceId: params.spaceId,
    filePath: params.candidateFilePath,
  }).target;
  const target = resolveArtifactDestination({
    workspaceDir: params.workspaceDir,
    spaceId: params.spaceId,
    filePath: params.filePath,
  }).target;
  const candidateDigest = digest(readFileSync(candidate));
  const promotionId = createHash("sha256")
    .update(params.candidateFilePath)
    .update("\0")
    .update(candidateDigest)
    .digest("hex")
    .slice(0, 16);
  const extension = posix.extname(params.filePath);
  const promotionFilePath = posix.join(
    posix.dirname(params.filePath),
    `.flowos-${promotionId}.promoting${extension}`,
  );
  const promotion = resolveArtifactDestination({
    workspaceDir: params.workspaceDir,
    spaceId: params.spaceId,
    filePath: promotionFilePath,
  }).target;
  try {
    copyFileSync(candidate, promotion);
    // Validate the immutable promotion snapshot, not the worker-owned candidate.
    // A late writer can therefore never replace the last known-good published file.
    const validation = await validateSpaceArtifact({
      runtime: params.runtime,
      workspaceDir: params.workspaceDir,
      spaceId: params.spaceId,
      filePath: promotionFilePath,
      artifactType: params.artifactType,
    });
    renameSync(promotion, target);
    return validation;
  } finally {
    rmSync(promotion, { force: true });
  }
}

export function discardSpaceArtifactCandidate(params: {
  workspaceDir: string;
  spaceId: string;
  candidateFilePath: string;
}): void {
  const target = resolveArtifactDestination({
    workspaceDir: params.workspaceDir,
    spaceId: params.spaceId,
    filePath: params.candidateFilePath,
  }).target;
  if (!existsSync(target)) {
    return;
  }
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Space Artifact candidate is not a removable regular file");
  }
  rmSync(target);
}
