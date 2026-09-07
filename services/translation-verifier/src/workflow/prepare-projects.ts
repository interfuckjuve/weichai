import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import { assertVerificationInput } from "../schemas/validate-verification-input.js";
import { type VerificationInput, type VerificationArtifact, type VerificationStrategyContext, type VerificationResultArtifact } from "../schemas/verification-types.js";
import { createVerificationArtifactStore, safePath } from "../run-output/verification-artifact-store.js";

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
  cleanup(options?: { discardArtifacts?: boolean }): void;
}

export function createVerificationWorkspace(
  input: VerificationInput,
  options: VerificationWorkspaceOptions,
): VerificationWorkspaceHandle {
  assertVerificationInput(input);
  mkdirSync(options.workspaceRoot, { recursive: true });
  const root = mkdtempSync(resolve(options.workspaceRoot, "verification-"));
  const durablePrefix = `attempt-${basename(root).replace(/^verification-/, "")}`;
  const sourceSideRoot = resolve(root, "source");
  const targetSideRoot = resolve(root, "target");
  const sourceRoot = resolve(sourceSideRoot, "project");
  const targetRoot = resolve(targetSideRoot, "project");
  const agentRoot = resolve(root, "agent");
  try {
    for (const directory of [
      sourceRoot,
      targetRoot,
      agentRoot,
      resolve(sourceSideRoot, ".forexplore-tests"),
      resolve(targetSideRoot, ".forexplore-tests"),
    ]) {
      mkdirSync(directory, { recursive: true });
    }

    markVerificationPhase("source-snapshot-materialization");
    for (const file of input.request.sourceBundle.files) {
      writeStagedFile(
        sourceRoot,
        file.path,
        file.content,
        "Source implementation file",
      );
    }
    markVerificationPhase("target-snapshot-materialization");
    for (const fact of input.request.targetContext.sourceFiles) {
      if (typeof fact.path === "string" && typeof fact.content === "string") {
        writeStagedFile(
          targetRoot,
          fact.path,
          fact.content,
          "Target context source file",
        );
      }
    }
    markVerificationPhase("translation-patch-application");
    for (const patch of input.translation.files) {
      const targetPath = safePath(targetRoot, patch.path, "Patch path");
      if (patch.status === "created") {
        if (existsSync(targetPath))
          throw new Error(
            `Target file already exists for created patch: ${patch.path}`,
          );
        writeStagedFile(
          targetRoot,
          patch.path,
          newFileContent(patch.hunks),
          "Created patch path",
        );
      } else {
        const original = readFileSync(targetPath, "utf8");
        if (sha256(original) !== patch.expectedOriginalSha256) {
          throw new Error(
            `Patch original hash does not match staged target file: ${patch.path}`,
          );
        }
        writeFileSync(
          targetPath,
          applyHunksStrict(original, patch.hunks),
          "utf8",
        );
      }
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  const store = createVerificationArtifactStore({
    artifactRoot: options.artifactRoot,
    durablePrefix,
    agentRoot,
  });
  return {
    ...store,
    context: {
      workspace: {
        root,
        sourceRoot,
        targetRoot,
        strategyRoot: agentRoot,
        evidenceRoot: agentRoot,
      },
      deadlineAt: Number.POSITIVE_INFINITY,
      writeArtifact: store.writeArtifact,
    },
    ...(options.keepWorkspace ? { keptDir: root } : {}),
    cleanup(cleanupOptions = {}) {
      try {
        store.cleanup(cleanupOptions);
      } finally {
        if (!options.keepWorkspace)
          rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function writeStagedFile(
  root: string,
  path: string,
  content: string,
  label: string,
): void {
  const destination = safePath(root, path, label);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content, "utf8");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
