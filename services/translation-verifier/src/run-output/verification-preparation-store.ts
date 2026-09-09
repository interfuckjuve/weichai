import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { canonicalJson } from "@forexplore/workflow-core";
import type {
  VerificationArtifact,
  VerificationPreparation,
  VerificationStrategyContext,
} from "../schemas/verification-types.js";
import {
  safePath,
  VerificationArtifactPersistenceError,
} from "./verification-artifact-store.js";

const MAX_BYTES = 10 * 1024 * 1024;

/** Host-only receipt index. Capsules use the existing per-attempt artifact budget. */
export async function rememberPreparation(
  artifactRoot: string,
  preparation: VerificationPreparation,
  context: VerificationStrategyContext,
): Promise<void> {
  try {
    const path = preparationPath(artifactRoot, preparation, true);
    const content = canonicalJson(preparation);
    const staged = "host-preparation.json";
    writeFileSync(join(context.workspace.evidenceRoot, staged), content, {
      flag: "wx",
      mode: 0o600,
    });
    const artifact = await context.writeArtifact({
      id: "host-preparation",
      kind: "verification-preparation",
      path: staged,
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    });
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      assertRememberedPreparation(artifactRoot, preparation);
      return;
    }
    try {
      writeFileSync(fd, JSON.stringify(artifact), "utf8");
    } catch (cause) {
      const created = fstatSync(fd);
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.ino === created.ino && current.dev === created.dev) unlinkSync(path);
      throw cause;
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    throw new VerificationArtifactPersistenceError(
      `Cannot persist Host preparation: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** External JSON cannot establish provenance by merely recomputing its own checksum. */
export function assertRememberedPreparation(
  artifactRoot: string,
  preparation: VerificationPreparation,
): void {
  try {
    const path = preparationPath(artifactRoot, preparation, false);
    const reference: VerificationArtifact = JSON.parse(
      readUnlinkedFile(artifactRoot, path, 16 * 1024),
    );
    if (!reference || typeof reference.path !== "string")
      throw new Error("Invalid Host receipt.");
    const capsulePath = safePath(
      realpathSync(artifactRoot),
      reference.path,
      "Preparation artifact",
    );
    if (
      readUnlinkedFile(artifactRoot, capsulePath, MAX_BYTES) !==
      canonicalJson(preparation)
    )
      throw new Error("Stored capsule does not match.");
  } catch (cause) {
    throw new Error(
      "Verification requires an unchanged preparation previously issued by this Host. External JSON cannot establish its own provenance.",
      { cause },
    );
  }
}

function readUnlinkedFile(root: string, path: string, limit: number): string {
  let current = realpathSync(root);
  const parts = relative(current, path).split("/");
  if (parts.some((part) => !part || part === ".." || part === "."))
    throw new Error("Invalid preparation artifact path.");
  for (const part of parts) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Linked preparation artifact.");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
      throw new Error("Invalid preparation artifact.");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function preparationPath(
  root: string,
  preparation: VerificationPreparation,
  create: boolean,
): string {
  if (!preparation || typeof preparation.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(preparation.contentHash))
    throw new Error("Invalid preparation identity.");
  if (create) mkdirSync(root, { recursive: true });
  const directory = join(realpathSync(root), "trusted-preparations");
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Invalid Host preparation directory.");
  return join(directory, `${preparation.contentHash}.json`);
}
