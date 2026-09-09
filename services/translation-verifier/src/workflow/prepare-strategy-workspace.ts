import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Ajv } from "ajv";
import type InputSchema from "../schemas/verification-input.schema.json";
import { assertSchema } from "../schemas/compile-schema-validators.js";
import {
  assertJsonCompatible,
  normalizeRepositoryRelativePath,
} from "../schemas/validate-json-paths.js";
import {
  lstatSync,
  realpathSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import { assertVerificationInput } from "../schemas/validate-verification-input.js";
import {
  type VerificationPreparedProjects,
  type VerificationPreparationInput,
  type VerificationWorkspaceRequirements,
  type VerificationInput,
  type VerificationArtifact,
  type VerificationStrategyContext,
  type VerificationResultArtifact,
} from "../schemas/verification-types.js";
import {
  createVerificationArtifactStore,
  safePath,
  VerificationArtifactPersistenceError,
} from "../run-output/verification-artifact-store.js";

export interface VerificationWorkspaceOptions {
  workspaceRoot: string;
  artifactRoot: string;
  keepWorkspace?: boolean;
  requirements?: VerificationWorkspaceRequirements;
  preparedProjects?: VerificationPreparedProjects;
}

export interface VerificationWorkspaceHandle {
  context: VerificationStrategyContext;
  writtenArtifacts(): VerificationArtifact[];
  keptDir?: string;
  writeFrameworkResult(content: Uint8Array): VerificationResultArtifact;
  cleanup(options?: { discardArtifacts?: boolean }): void;
}

const inputSchema: typeof InputSchema = createRequire(import.meta.url)(
  "../schemas/verification-input.schema.json",
);
const validatePreparationSchema = new Ajv({
  strict: true,
  ownProperties: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
}).compile<VerificationPreparationInput>({
  ...inputSchema,
  $id: "urn:forexplore:verification-preparation-input:1.0",
  required: ["request", "analysisReport", "migrationPlan"],
  properties: {
    request: inputSchema.properties.request,
    analysisReport: inputSchema.properties.analysisReport,
    migrationPlan: inputSchema.properties.migrationPlan,
  },
  additionalProperties: false,
});

/** Project explicitly before dispatch so translated implementation fields never enter preparation. */
export function projectVerificationPreparationInput(
  input: VerificationPreparationInput,
): VerificationPreparationInput {
  const projected = {
    request: input?.request,
    analysisReport: input?.analysisReport,
    migrationPlan: input?.migrationPlan,
  };
  assertJsonCompatible(projected, "Verification preparation input");
  assertSchema(
    validatePreparationSchema,
    projected,
    "Verification preparation input",
  );
  for (const file of [
    ...projected.request.sourceBundle.files,
    ...projected.request.targetContext.sourceFiles,
  ]) {
    normalizeRepositoryRelativePath(
      file.path,
      "Verification preparation file path",
    );
    if (file.contentHash !== sha256(file.content!))
      throw new Error(
        "Verification preparation file contentHash does not match sha256(content).",
      );
  }
  return structuredClone(projected);
}

export function createVerificationPreparationWorkspace(
  input: VerificationPreparationInput,
  options: VerificationWorkspaceOptions,
): VerificationWorkspaceHandle {
  return createWorkspace(projectVerificationPreparationInput(input), options);
}

export function createVerificationWorkspace(
  input: VerificationInput,
  options: VerificationWorkspaceOptions,
): VerificationWorkspaceHandle {
  assertVerificationInput(input);
  return createWorkspace(input, options, input.translation.files);
}

function createWorkspace(
  input: VerificationPreparationInput,
  options: VerificationWorkspaceOptions,
  patches: VerificationInput["translation"]["files"] = [],
): VerificationWorkspaceHandle {
  if (
    options.requirements !== undefined &&
    typeof options.requirements.source !== "boolean"
  )
    throw new Error(
      "Strategy workspace requirements must declare a boolean source requirement.",
    );
  const supplied = options.preparedProjects;
  if (supplied !== undefined)
    validatePreparedProjects(input, supplied, options, patches);
  mkdirSync(options.workspaceRoot, { recursive: true });
  const root = mkdtempSync(resolve(options.workspaceRoot, "verification-"));
  const durablePrefix = `attempt-${basename(root).replace(/^verification-/, "")}`;
  const sourceSideRoot = resolve(root, "source");
  const targetSideRoot = resolve(root, "target");
  const sourceRoot =
    supplied?.sourceRoot && options.requirements?.source !== false
      ? resolve(supplied.sourceRoot)
      : resolve(sourceSideRoot, "project");
  const targetRoot = supplied
    ? resolve(supplied.targetRoot)
    : resolve(targetSideRoot, "project");
  const agentRoot = resolve(root, "agent");
  try {
    if (supplied) {
      mkdirSync(agentRoot, { recursive: true });
      if (!supplied.sourceRoot || options.requirements?.source === false)
        mkdirSync(sourceRoot, { recursive: true });
    } else {
      for (const directory of [sourceRoot, targetRoot, agentRoot]) {
        mkdirSync(directory, { recursive: true });
      }

      markVerificationPhase("source-snapshot-materialization");
      const sourceFiles =
        options.requirements?.source === false
          ? []
          : input.request.sourceBundle.files;
      for (const file of sourceFiles) {
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
      for (const patch of patches) {
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
        projectOwnership: supplied ? "caller" : "framework",
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

export function assertPreparedArtifactStorage(
  projects: VerificationPreparedProjects | undefined,
  artifactRoot: string,
): void {
  if (projects === undefined) return;
  const roots = [projects?.sourceRoot, projects?.targetRoot].filter(
    (path): path is string => typeof path === "string",
  );
  const destination = canonicalDirectory(artifactRoot);
  if (roots.some((path) => overlaps(canonicalDirectory(path), destination)))
    throw new VerificationArtifactPersistenceError(
      "Framework artifact storage must be disjoint from prepared projects; no failure report can be safely persisted.",
    );
}

function validatePreparedProjects(
  input: VerificationPreparationInput,
  projects: VerificationPreparedProjects,
  options: VerificationWorkspaceOptions,
  patches: VerificationInput["translation"]["files"],
): void {
  if (
    !projects ||
    typeof projects.targetRoot !== "string" ||
    (projects.sourceRoot !== undefined &&
      typeof projects.sourceRoot !== "string")
  )
    throw new Error("Prepared project roots must be explicit paths.");
  const roots = [
    projects.targetRoot,
    ...(projects.sourceRoot ? [projects.sourceRoot] : []),
  ];
  assertPreparedArtifactStorage(projects, options.artifactRoot);
  if (options.requirements?.source !== false && !projects.sourceRoot)
    throw new Error("Prepared source project is required by the strategy.");
  for (const path of roots) {
    if (!isAbsolute(path) || !lstatSync(path).isDirectory())
      throw new Error(
        "Prepared project roots must be absolute directories, not symbolic links.",
      );
  }
  const workspaceRoot = canonicalDirectory(options.workspaceRoot);
  if (
    (projects.sourceRoot &&
      overlaps(
        realpathSync(projects.sourceRoot),
        realpathSync(projects.targetRoot),
      )) ||
    roots.some((path) => overlaps(realpathSync(path), workspaceRoot))
  )
    throw new Error(
      "Prepared project roots must be disjoint from each other and framework storage.",
    );
  if (projects.sourceRoot) {
    for (const file of input.request.sourceBundle.files)
      assertPreparedFile(projects.sourceRoot, file.path, file.content);
  }
  const expected = new Map<string, string>();
  for (const file of input.request.targetContext.sourceFiles) {
    if (typeof file.path === "string" && typeof file.content === "string")
      expected.set(file.path, file.content);
  }
  // Calculate expected translated bytes in memory; never apply a patch to supplied projects.
  for (const patch of patches) {
    if (patch.status === "created") {
      if (expected.has(patch.path))
        throw new Error(
          `Created patch conflicts with target context: ${patch.path}`,
        );
      expected.set(patch.path, newFileContent(patch.hunks));
    } else {
      const original = expected.get(patch.path);
      if (
        original === undefined ||
        sha256(original) !== patch.expectedOriginalSha256
      )
        throw new Error(
          `Patch original hash does not match target context: ${patch.path}`,
        );
      expected.set(patch.path, applyHunksStrict(original, patch.hunks));
    }
  }
  for (const [path, content] of expected)
    assertPreparedFile(projects.targetRoot, path, content);
}

function assertPreparedFile(
  root: string,
  path: string,
  expected: string,
): void {
  const destination = safePath(root, path, "Prepared project file");
  let cursor = root;
  for (const part of relative(root, destination).split(sep)) {
    cursor = resolve(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      throw new Error(
        `Prepared project file must not share mutable links: ${path}`,
      );
  }
  if (
    !lstatSync(destination).isFile() ||
    !readFileSync(destination).equals(Buffer.from(expected, "utf8"))
  )
    throw new Error(
      `Prepared project content does not match verification input: ${path}`,
    );
}

function canonicalDirectory(path: string): string {
  return existsSync(path)
    ? realpathSync(path)
    : resolve(canonicalDirectory(dirname(path)), basename(path));
}

function overlaps(left: string, right: string): boolean {
  const contains = (root: string, path: string) => {
    const nested = relative(resolve(root), resolve(path));
    return (
      nested === "" ||
      (!isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${sep}`))
    );
  };
  return contains(left, right) || contains(right, left);
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
