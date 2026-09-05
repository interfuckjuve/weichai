import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import type { VerificationArtifact, VerificationInput, VerificationStrategyContext } from "./verification-types.js";
import { assertVerificationInput } from "./verification-types.js";

export interface VerificationWorkspaceOptions {
  workspaceRoot: string;
  artifactRoot: string;
  keepWorkspace?: boolean;
}

export interface VerificationWorkspaceHandle {
  context: VerificationStrategyContext;
  writtenArtifacts(): VerificationArtifact[];
  keptDir?: string;
  cleanup(): void;
}

export function createVerificationWorkspace(
  input: VerificationInput,
  options: VerificationWorkspaceOptions,
): VerificationWorkspaceHandle {
  assertVerificationInput(input);
  mkdirSync(options.workspaceRoot, { recursive: true });
  const root = mkdtempSync(resolve(options.workspaceRoot, "verification-"));
  const artifactRoot = resolve(options.artifactRoot);
  const sourceSideRoot = resolve(root, "source");
  const targetSideRoot = resolve(root, "target");
  const sourceRoot = resolve(sourceSideRoot, "project");
  const targetRoot = resolve(targetSideRoot, "project");
  const agentRoot = resolve(root, "agent");
  const written: VerificationArtifact[] = [];

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
      const artifactPath = safeRelativePath(artifact.path, "Verification artifact path");
      const source = safePath(agentRoot, artifactPath, "Verification artifact path");
      const destination = safePath(artifactRoot, artifactPath, "Verification artifact path");
      const content = readFileSync(source);
      const stored: VerificationArtifact = {
        ...artifact,
        path: artifactPath,
        contentHash: createHash("sha256").update(content).digest("hex"),
      };
      mkdirSync(dirname(destination), { recursive: true });
      const temporary = resolve(dirname(destination), `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`);
      try {
        writeFileSync(temporary, content);
        renameSync(temporary, destination);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      written.push({ ...stored });
      return { ...stored };
    },
  };

  return {
    context,
    ...(options.keepWorkspace ? { keptDir: root } : {}),
    writtenArtifacts() {
      return written.map((artifact) => ({ ...artifact }));
    },
    cleanup() {
      if (!options.keepWorkspace) rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeStagedFile(root: string, path: string, content: string, label: string): void {
  const destination = safePath(root, path, label);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
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
