import { closeSync, fchmodSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalJson } from "@forexplore/workflow-core";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import type {
  VerificationPreparation,
  VerificationPreparationInput,
  VerificationStrategyDescriptor,
} from "../../schemas/verification-types.js";
import {
  hashContent,
  isProjectTestPath,
  readTestFile,
  TEST_DIRECTORY,
} from "./behavior-workspace.js";

function digest(value: unknown): string {
  return hashContent(canonicalJson(value));
}

/** Only explicit pretranslation context participates, never translation or extension fields. */
export function createPreparation(
  descriptor: VerificationStrategyDescriptor,
  input: VerificationPreparationInput,
  payload: RepositoryIngestionJsonValue,
): VerificationPreparation {
  const { request, analysisReport, migrationPlan } = input;
  const envelope = {
    schemaVersion: "1.0" as const,
    strategyId: descriptor.id,
    strategyVersion: descriptor.version,
    inputHash: digest({ request, analysisReport, migrationPlan }),
    payload: structuredClone(payload),
  };
  return { ...envelope, contentHash: digest(envelope) };
}
export function assertPreparation(
  preparation: VerificationPreparation | undefined,
  descriptor: VerificationStrategyDescriptor,
  input: VerificationPreparationInput,
): RepositoryIngestionJsonValue {
  if (
    !preparation ||
    preparation.schemaVersion !== "1.0" ||
    preparation.strategyId !== descriptor.id ||
    preparation.strategyVersion !== descriptor.version
  )
    throw new Error("Missing or different-strategy verification preparation.");
  const expected = createPreparation(descriptor, input, preparation.payload);
  if (
    preparation.inputHash !== expected.inputHash ||
    preparation.contentHash !== expected.contentHash
  )
    throw new Error("Stale or mutated verification preparation.");
  return structuredClone(preparation.payload);
}

export function assertUntranslatedTarget(
  input: VerificationPreparationInput,
  root: string,
): void {
  for (const file of input.request.targetContext.sourceFiles) {
    if (typeof file.path !== "string" || typeof file.content !== "string")
      continue;
    if (
      file.path.split(/[\\/]/)[0] === TEST_DIRECTORY ||
      readTestFile(root, file.path) !== file.content
    )
      throw new Error(
        `Target copy differs from the submitted snapshot before translation: ${file.path}`,
      );
  }
}
export function assertSourceSnapshot(
  input: VerificationPreparationInput,
  root: string,
): void {
  for (const file of input.request.sourceBundle.files)
    if (
      file.path.split(/[\\/]/)[0] === TEST_DIRECTORY ||
      readTestFile(root, file.path) !== file.content
    )
      throw new Error(
        `Source copy differs from the submitted snapshot: ${file.path}`,
      );
}

export interface FrozenPreparationFile {
  path: string;
  content: string;
  mode: number;
}
export function capturePreparationFiles(
  root: string,
  paths: string[],
): FrozenPreparationFile[] {
  return [...new Set(paths)].map((path) => ({
    path,
    content: readTestFile(root, path),
    mode: lstatSync(join(root, path)).mode,
  }));
}

/** Restore only missing handoff files; existing files and every parent must be unlinked and exact. */
export function restorePreparationFiles(
  root: string,
  files: FrozenPreparationFile[],
): void {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Invalid preparation root.");
  for (const file of files) {
    if (
      !isProjectTestPath(file.path) ||
      typeof file.content !== "string" ||
      Buffer.byteLength(file.content) > 1024 * 1024 ||
      !Number.isInteger(file.mode) ||
      (file.mode & 0o170000) !== 0o100000 ||
      (file.mode & 0o7000) !== 0
    )
      throw new Error("Invalid preparation handoff file.");
    const parts = file.path.split("/");
    if (
      isAbsolute(file.path) ||
      file.path.includes("\\") ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe preparation file path.");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const stat = lstatSync(parent, { throwIfNoEntry: false });
      if (!stat) mkdirSync(parent);
      else if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Invalid linked preparation parent.");
    }
    const path = join(root, file.path);
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (!existing) {
      const fd = openSync(path, "wx", file.mode & 0o777);
      try {
        writeFileSync(fd, file.content);
        fchmodSync(fd, file.mode & 0o777);
      } finally { closeSync(fd); }
    }
    if (
      readTestFile(root, file.path) !== file.content ||
      lstatSync(path).mode !== file.mode
    )
      throw new Error(`Frozen Agent1 handoff changed: ${file.path}`);
  }
}
