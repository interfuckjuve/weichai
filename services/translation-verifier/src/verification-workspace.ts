import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import type { VerificationArtifact, VerificationInput, VerificationStrategyContext, VerificationResultArtifact } from "./verification-types.js";
import { assertVerificationInput } from "./verification-types.js";

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export class VerificationArtifactPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VerificationArtifactPersistenceError";
  }
}
export interface VerificationWorkspaceOptions {
  workspaceRoot: string;
  artifactRoot: string;
  keepWorkspace?: boolean;
}

export interface VerificationWorkspaceHandle {
  context: VerificationStrategyContext;
  writtenArtifacts(): VerificationArtifact[];
  keptDir?: string;
  writeFrameworkResult(content: Uint8Array): VerificationResultArtifact;
  cleanup(): void;
}

export function createVerificationWorkspace(
  input: VerificationInput,
  options: VerificationWorkspaceOptions,
): VerificationWorkspaceHandle {
  assertVerificationInput(input);
  mkdirSync(options.workspaceRoot, { recursive: true });
  const root = mkdtempSync(resolve(options.workspaceRoot, "verification-"));
  const durablePrefix = `attempt-${basename(root).replace(/^verification-/, "")}`;
  const artifactRoot = resolve(options.artifactRoot);
  const sourceSideRoot = resolve(root, "source");
  const targetSideRoot = resolve(root, "target");
  const sourceRoot = resolve(sourceSideRoot, "project");
  const targetRoot = resolve(targetSideRoot, "project");
  const agentRoot = resolve(root, "agent");
  let closed = false;
  const written: VerificationArtifact[] = [];
  const writtenIds = new Set<string>();
  const writtenPaths = new Set<string>();
  let writtenBytes = 0;

  try {
    for (const directory of [sourceRoot, targetRoot, agentRoot, resolve(sourceSideRoot, ".forexplore-tests"), resolve(targetSideRoot, ".forexplore-tests")]) {
      mkdirSync(directory, { recursive: true });
    }

    for (const file of input.request.sourceBundle.files) {
      writeStagedFile(sourceRoot, file.path, file.content, "Source implementation file");
    }
    for (const fact of input.request.targetContext.sourceFiles) {
      if (typeof fact.path === "string" && typeof fact.content === "string") {
        writeStagedFile(targetRoot, fact.path, fact.content, "Target context source file");
      }
    }
    for (const patch of input.translation.files) {
      const targetPath = safePath(targetRoot, patch.path, "Patch path");
      if (patch.status === "created") {
        if (existsSync(targetPath)) throw new Error(`Target file already exists for created patch: ${patch.path}`);
        writeStagedFile(targetRoot, patch.path, newFileContent(patch.hunks), "Created patch path");
      } else {
        const original = readFileSync(targetPath, "utf8");
        if (sha256(original) !== patch.expectedOriginalSha256) {
          throw new Error(`Patch original hash does not match staged target file: ${patch.path}`);
        }
        writeFileSync(targetPath, applyHunksStrict(original, patch.hunks), "utf8");
      }
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const context: VerificationStrategyContext = {
    workspace: {
      root,
      sourceRoot,
      targetRoot,
      strategyRoot: agentRoot,
      evidenceRoot: agentRoot,
    },
    deadlineAt: Number.POSITIVE_INFINITY,
    writeArtifact(artifact) {
      if (closed) throw new Error("Verification workspace is closed.");
      const sourcePath = safeRelativePath(artifact.path, "Verification artifact path");
      const durablePath = `${durablePrefix}/${sourcePath}`;
      const source = safeExistingFile(agentRoot, sourcePath, "Verification artifact source");
      const sourceSize = statSync(source).size;
      if (sourceSize > MAX_ARTIFACT_BYTES || writtenBytes + sourceSize > MAX_ARTIFACT_BYTES) {
        throw new VerificationArtifactPersistenceError("Verification artifact size budget exceeded.");
      }
      if (writtenIds.has(artifact.id) || writtenPaths.has(durablePath)) {
        throw new VerificationArtifactPersistenceError("Verification artifact ID or path was already written.");
      }
      const content = readFileSync(source);
      const stored: VerificationArtifact = {
        ...artifact,
        path: durablePath,
        contentHash: createHash("sha256").update(content).digest("hex"),
      };
      let temporary: string | undefined;
      try {
        const { destination, parent, rootRealPath } = safeArtifactDestination(artifactRoot, durablePath);
        temporary = resolve(parent, `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`);
        const destinationStat = lstatIfExists(destination);
        if (destinationStat !== undefined) throw new Error("Verification artifact destination already exists.");
        assertRealPathContained(parent, rootRealPath, "Verification artifact parent");
        writeFileSync(temporary, content);
        assertRealPathContained(temporary, rootRealPath, "Verification artifact temporary file");
        assertRealPathContained(parent, rootRealPath, "Verification artifact parent");
        renameSync(temporary, destination);
        written.push({ ...stored });
        writtenIds.add(stored.id);
        writtenPaths.add(stored.path);
        writtenBytes += content.byteLength;
      } catch (error) {
        if (temporary !== undefined) rmSync(temporary, { force: true });
        throw new VerificationArtifactPersistenceError(`Verification artifact persistence failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }

      return { ...stored };
    },
  };

  return {
    context,
    ...(options.keepWorkspace ? { keptDir: root } : {}),
    writtenArtifacts() {
      return written.map((artifact) => ({ ...artifact }));
    },
    writeFrameworkResult(content) {
      if (closed) throw new Error("Verification workspace is closed.");
      const durablePath = `${durablePrefix}/verification-result-${createHash("sha256").update(content).digest("hex")}.json`;
      const temporary = resolve(resolve(artifactRoot), `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`);
      try {
        const { destination, parent, rootRealPath } = safeArtifactDestination(artifactRoot, durablePath);
        assertRealPathContained(parent, rootRealPath, "Verification result parent");
        writeFileSync(temporary, content);
        assertRealPathContained(temporary, rootRealPath, "Verification result temporary file");
        if (lstatIfExists(destination) !== undefined) throw new Error("Verification result destination already exists.");
        renameSync(temporary, destination);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw new VerificationArtifactPersistenceError("Verification result persistence failed.", { cause: error });
      }
      return {
        id: `verification-result:${durablePath}`,
        kind: "verification-result",
        path: durablePath,
        contentHash: createHash("sha256").update(content).digest("hex"),
        size: content.byteLength,
        mediaType: "application/json",
      };
    },
    cleanup() {
      closed = true;
      if (!options.keepWorkspace) rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeStagedFile(root: string, path: string, content: string, label: string): void {
  const destination = safePath(root, path, label);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

function safeExistingFile(root: string, path: string, label: string): string {
  const file = safePath(root, path, label);
  const baseRealPath = realpathSync(resolve(root));
  const parts = safeRelativePath(path, label).split("/");
  let current = resolve(root);
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symlink path components.`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} parent must be a directory.`);
    }
    assertRealPathContained(current, baseRealPath, label);
  }
  if (!lstatSync(file).isFile()) throw new Error(`${label} must be a file.`);
  return file;
}

function safeArtifactDestination(root: string, path: string): { destination: string; parent: string; rootRealPath: string } {
  const artifactPath = safeRelativePath(path, "Verification artifact path");
  const base = resolve(root);
  mkdirSync(base, { recursive: true });
  if (lstatSync(base).isSymbolicLink()) throw new Error("Verification artifact root must not be a symlink.");
  const rootRealPath = realpathSync(base);
  const parts = artifactPath.split("/");
  const fileName = parts.pop()!;
  let parent = base;

  for (const part of parts) {
    parent = resolve(parent, part);
    const stat = lstatIfExists(parent);
    if (stat !== undefined) {
      if (stat.isSymbolicLink()) throw new Error("Verification artifact path must not contain symlink path components.");
      if (!stat.isDirectory()) throw new Error("Verification artifact path parent must be a directory.");
    } else {
      mkdirSync(parent);
    }
    assertRealPathContained(parent, rootRealPath, "Verification artifact path");
  }

  const destination = resolve(parent, fileName);
  const destinationStat = lstatIfExists(destination);
  if (destinationStat !== undefined) {
    if (destinationStat.isSymbolicLink()) throw new Error("Verification artifact path must not contain symlink path components.");
    if (!destinationStat.isFile()) throw new Error("Verification artifact path destination must be a file.");
    assertRealPathContained(destination, rootRealPath, "Verification artifact path");
  }
  return { destination, parent, rootRealPath };
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertRealPathContained(path: string, rootRealPath: string, label: string): void {
  const realPath = realpathSync(path);
  if (realPath !== rootRealPath && !realPath.startsWith(`${rootRealPath}${sep}`)) {
    throw new Error(`${label} must stay within the artifact root.`);
  }
}

function safePath(root: string, path: string, label: string): string {
  const safeRelative = safeRelativePath(path, label);
  const base = resolve(root);
  const candidate = resolve(base, safeRelative);
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) {
    throw new Error(`${label} must be a normalized relative path.`);
  }
  return candidate;
}

function safeRelativePath(path: string, label: string): string {
  if (typeof path !== "string" || path.trim().length === 0 || path.includes("\\") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new Error(`${label} must be a normalized relative path.`);
  }
  const candidate = resolve("/", path);
  const normalized = candidate.slice(1);
  if (normalized !== path || normalized === "" || normalized.startsWith(`..${sep}`) || path === ".." || path.includes("/../")) {
    throw new Error(`${label} must be a normalized relative path.`);
  }
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
