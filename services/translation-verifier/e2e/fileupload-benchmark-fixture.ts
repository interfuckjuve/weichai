import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import type { VerificationInput } from "../src/schemas/verification-types.js";
import { translatedDiskJava } from "./fileupload-disk-translation.js";

export const repositoryRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);
export const javaPath =
  "src/main/java/org/apache/commons/fileupload/MultipartStream.java";
export const pythonPath = "src/commons_fileupload/core.py";
export const sourceProjectRoot = join(
  repositoryRoot,
  "fixtures/code-corpus/commons-fileupload-python",
);
export const targetProjectRoot = join(
  repositoryRoot,
  "fixtures/target-system/commons-fileupload-java-skeleton",
);
export const diskJavaPath =
  "src/main/java/org/apache/commons/fileupload/disk/DiskFileItem.java";
export const fileUploadTasks = {
  "multipart-read-body": {
    method: "readBodyData",
    sourceMethod: "read_body_data",
    path: javaPath,
    container: "org.apache.commons.fileupload.MultipartStream",
    requirement:
      "Emit exactly the body bytes, exclude delimiters, return the exact byte count even for null output, preserve subsequent boundaries, and never close the caller's output.",
  },
  "multipart-skip-preamble": {
    method: "skipPreamble",
    sourceMethod: "skip_preamble",
    path: javaPath,
    container: "org.apache.commons.fileupload.MultipartStream",
    requirement:
      "Ignore preamble, recognize the initial boundary without preceding CRLF, restore the normal delimiter, and preserve ordered iteration over multiple parts including empty bodies.",
  },
  "disk-get-input-stream": {
    method: "getInputStream",
    sourceMethod: "get_input_stream",
    path: diskJavaPath,
    container: "org.apache.commons.fileupload.disk.DiskFileItem",
    requirement:
      "After closing the output, each input stream must independently read all stored bytes from the beginning, for memory-backed and disk-backed items.",
  },
  "disk-get": {
    method: "get",
    sourceMethod: "get",
    path: diskJavaPath,
    container: "org.apache.commons.fileupload.disk.DiskFileItem",
    requirement:
      "After closing the output, return exact stored bytes for empty, memory-backed and disk-backed items without changing storage ownership. Java returns null for a disk read IOException; a Python I/O exception is an allowed representation difference, not target blame.",
  },
  "disk-write": {
    method: "write",
    sourceMethod: "write",
    path: diskJavaPath,
    container: "org.apache.commons.fileupload.disk.DiskFileItem",
    requirement:
      "After closing the output, persist exact bytes to a destination and preserve size after moving disk-backed data. Propagate write failures. Only the first write is guaranteed; post-move reads and repeated writes are outside this contract.",
  },
  "disk-get-output-stream": {
    method: "getOutputStream",
    sourceMethod: "get_output_stream",
    path: diskJavaPath,
    container: "org.apache.commons.fileupload.disk.DiskFileItem",
    requirement:
      "Store exact bytes after closing a single output stream; sizes at the threshold stay in memory and sizes above it spill to disk. Java must reuse its deferred output stream. Python creates a new buffering wrapper; distinguish source limitations from target defects and do not require wrapper identity equality.",
  },
} as const;
export type FileUploadTaskId = keyof typeof fileUploadTasks;
export function isFileUploadTask(value: string): value is FileUploadTaskId {
  return Object.hasOwn(fileUploadTasks, value);
}
export const sha256 = (content: string) =>
  createHash("sha256").update(content).digest("hex");
export const variants = ["correct", "count-plus-one", "drop-output"] as const;
export type Variant = (typeof variants)[number];

/** Host-only request cases. These mutate only the staged source snapshot or policy. */
export const datasetVariants = [
  ...variants,
  "source-count-plus-one",
  "both-count-plus-one",
  "target-only-correct",
  "target-only-count-plus-one",
  "missing-test-basis",
  "missing-policy",
] as const;
export type DatasetVariant = (typeof datasetVariants)[number];

export function isDatasetVariant(value: string): value is DatasetVariant {
  return datasetVariants.includes(value as DatasetVariant);
}

// Method bodies derived from Apache Commons FileUpload 1.5 (Apache-2.0).
// https://github.com/apache/commons-fileupload/blob/commons-fileupload-1.5/src/main/java/org/apache/commons/fileupload/MultipartStream.java
const bodyTodo = `        // TODO(translation): stream bytes up to, but excluding, the next
        // boundary without consuming the boundary needed by readBoundary().
        throw new UnsupportedOperationException("TODO: read multipart body data");`;
const preambleTodo = `        // TODO(translation): accept the first boundary without a preceding
        // CRLF, then restore the normal delimiter for subsequent parts.
        throw new UnsupportedOperationException("TODO: skip multipart preamble");`;
const preamble = `        System.arraycopy(boundary, 2, boundary, 0, boundary.length - 2);
        boundaryLength = boundary.length - 2;
        computeBoundaryTable();
        try {
            discardBodyData();
            return readBoundary();
        } catch (MalformedStreamException e) {
            return false;
        } finally {
            System.arraycopy(boundary, 0, boundary, 2, boundary.length - 2);
            boundaryLength = boundary.length;
            boundary[0] = CR;
            boundary[1] = LF;
            computeBoundaryTable();
        }`;

export function translatedJava(original: string, variant: Variant): string {
  for (const anchor of [bodyTodo, preambleTodo]) {
    if (original.split(anchor).length !== 2)
      throw new Error("Fixture TODO changed; review benchmark patch.");
  }
  const output = variant === "drop-output" ? "null" : "output";
  const increment = variant === "count-plus-one" ? " + 1" : "";
  return original
    .replace(
      bodyTodo,
      `        return (int) Streams.copy(newInputStream(), ${output}, false)${increment};`,
    )
    .replace(preambleTodo, preamble);
}

const sourceMutationAnchor = "        return len(body)\n";

function sourceFilesFor(variant: DatasetVariant) {
  const files = projectFiles(sourceProjectRoot);
  if (variant !== "source-count-plus-one" && variant !== "both-count-plus-one")
    return files;
  if (files.filter((file) => file.path === pythonPath).length !== 1)
    throw new Error("Python source fixture changed; review source mutation.");
  return files
    .map((file) => {
      if (file.path !== pythonPath) return file;
      const occurrences = file.content.split(sourceMutationAnchor).length - 1;
      if (occurrences !== 1)
        throw new Error(
          "Python source mutation anchor must occur exactly once; review source fixture.",
        );
      return {
        ...file,
        content: file.content.replace(
          sourceMutationAnchor,
          "        return len(body) + 1\n",
        ),
      };
    })
    .map((file) => ({ ...file, contentHash: sha256(file.content) }));
}

export interface ExpectedVerificationFields {
  mode: "differential" | "target_only";
  referenceDecision: "accepted" | "rejected" | "undetermined";
  referenceReason: string;
  executionStatus: "completed" | "partial" | "failed" | "cancelled";
  sourceAssessment:
    | "bug_found"
    | "no_bug_observed"
    | "suspected_bug"
    | "inconclusive"
    | "not_checked";
  targetAssessment:
    | "bug_found"
    | "no_bug_observed"
    | "suspected_bug"
    | "inconclusive"
    | "not_checked";
  problemCodes: string[];
}

const acceptedReason =
  "Apache Commons FileUpload source is a versioned reference and the task has an independent byte-level requirement.";
const targetOnlyReason =
  "The retrieved source candidate is not trusted for differential execution; validate Java against the independent requirement.";
const testBasis =
  "Independent task requirement plus the existing project test/build and byte-level control observations.";

export function expectedVerificationFields(
  variant: DatasetVariant,
): ExpectedVerificationFields {
  if (variant === "target-only-correct")
    return {
      mode: "target_only",
      referenceDecision: "rejected",
      referenceReason: targetOnlyReason,
      executionStatus: "completed",
      sourceAssessment: "not_checked",
      targetAssessment: "no_bug_observed",
      problemCodes: [],
    };
  if (variant === "target-only-count-plus-one")
    return {
      mode: "target_only",
      referenceDecision: "rejected",
      referenceReason: targetOnlyReason,
      executionStatus: "completed",
      sourceAssessment: "not_checked",
      targetAssessment: "bug_found",
      problemCodes: [],
    };
  if (variant === "missing-test-basis" || variant === "missing-policy")
    return {
      mode: "target_only",
      referenceDecision:
        variant === "missing-policy" ? "undetermined" : "rejected",
      referenceReason:
        variant === "missing-policy"
          ? "The Host has not accepted the reference implementation."
          : targetOnlyReason,
      executionStatus: "failed",
      sourceAssessment: "not_checked",
      targetAssessment: "inconclusive",
      problemCodes: ["insufficient_test_basis"],
    };
  const sourceBug =
    variant === "source-count-plus-one" || variant === "both-count-plus-one";
  const targetBug =
    variant === "count-plus-one" ||
    variant === "drop-output" ||
    variant === "both-count-plus-one";
  return {
    mode: "differential",
    referenceDecision: "accepted",
    referenceReason: acceptedReason,
    executionStatus: "completed",
    sourceAssessment: sourceBug ? "bug_found" : "no_bug_observed",
    targetAssessment: targetBug ? "bug_found" : "no_bug_observed",
    problemCodes: [],
  };
}

export function verificationPolicyForVariant(variant: DatasetVariant):
  | {
      referenceDecision: "accepted" | "rejected" | "undetermined";
      reason: string;
      testBasis?: string;
    }
  | undefined {
  if (variant === "missing-policy") return undefined;
  if (variant === "missing-test-basis")
    return { referenceDecision: "rejected", reason: targetOnlyReason };
  if (
    variant === "target-only-correct" ||
    variant === "target-only-count-plus-one"
  )
    return {
      referenceDecision: "rejected",
      reason: targetOnlyReason,
      testBasis,
    };
  return { referenceDecision: "accepted", reason: acceptedReason, testBasis };
}

function projectFiles(root: string) {
  const excluded = new Set([
    ".git",
    "__pycache__",
    "node_modules",
    "target",
    "bin",
    "obj",
    "dist",
    "build",
    ".pytest_cache",
  ]);
  const paths = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .filter((path) => !path.split("/").some((part) => excluded.has(part)))
    .filter(
      (path) =>
        /\.(java|py|xml|md|toml|txt)$/.test(path) ||
        ["LICENSE", "NOTICE"].includes(path),
    )
    .sort();
  return paths.map((path) => {
    const content = readFileSync(join(root, path), "utf8");
    return { path, content, contentHash: sha256(content) };
  });
}

export function fileUploadInput(
  variant: DatasetVariant,
  taskId: FileUploadTaskId = "multipart-read-body",
): VerificationInput {
  if (!isFileUploadTask(taskId))
    throw new Error(`Unknown FileUpload task: ${taskId}`);
  const task = fileUploadTasks[taskId];
  if (!isDatasetVariant(variant))
    throw new Error(`Unknown variant: ${variant}`);
  if (
    (variant === "source-count-plus-one" ||
      variant === "both-count-plus-one" ||
      variant === "target-only-count-plus-one" ||
      variant === "count-plus-one" ||
      variant === "drop-output") &&
    taskId !== "multipart-read-body"
  )
    throw new Error(
      "Defect variants are supported only for multipart-read-body.",
    );
  const targetVariant: Variant =
    variant === "count-plus-one" ||
    variant === "target-only-count-plus-one" ||
    variant === "drop-output"
      ? variant === "target-only-count-plus-one"
        ? "count-plus-one"
        : variant
      : variant === "both-count-plus-one"
        ? "count-plus-one"
        : "correct";
  const sourceFiles = sourceFilesFor(variant);
  const targetFiles = projectFiles(targetProjectRoot);
  const original = targetFiles.find((file) => file.path === task.path)!.content;
  const generatedContent =
    task.path === javaPath
      ? translatedJava(original, targetVariant)
      : translatedDiskJava(original);
  const oldLines = original.trimEnd().split("\n");
  const newLines = generatedContent.trimEnd().split("\n");
  const files: FilePatch[] = [
    {
      path: task.path,
      status: "modified",
      expectedOriginalSha256: sha256(original),
      additions: newLines.length,
      deletions: oldLines.length,
      hunks: [
        {
          header: `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
          lines: [
            ...oldLines.map((content) => ({
              type: "remove" as const,
              content,
            })),
            ...newLines.map((content) => ({ type: "add" as const, content })),
          ],
        },
      ],
    },
  ];
  // SAFETY: verifier validates the artifact subset at runtime; unrelated workflow approvals are not used by this standalone benchmark.
  const request = {
    route: { sourceLanguageId: "python", targetLanguageId: "java" },
    candidate: {
      entity: {
        languageId: "python",
        name: task.sourceMethod,
        path: pythonPath,
      },
    },
    target: {
      entity: { languageId: "java", name: task.method, path: task.path },
    },
    sourceBundle: { files: sourceFiles, dependencyIds: [] },
    targetContext: {
      sourceFiles: targetFiles,
      dependencies: [],
      containers: [],
      declarations: [
        {
          path: task.path,
          attributes: {
            containerName: task.container,
            isStatic: false,
          },
        },
      ],
    },
    requirement:
      `Verify ${task.container}.${task.method} against Python ${task.sourceMethod}. ${task.requirement} ` +
      "Use the existing project classes and dependencies, never a reimplemented shadow class. Python imports are rooted at src; Java uses the existing Maven pom.xml. " +
      "Only the selected class's TODO dependency closure has been filled in; TODOs in other classes are outside this task. " +
      "Python materializes input; Java streams it, so allocation and exception timing need not match. For malformed multipart input both sides must reject it, but exception names/messages may differ. " +
      "The Python source is evidence, not an absolute oracle. Judge differences against the requirement and report source-only defects without blaming Java.",
  } as unknown as AdaptationRequestV2;
  const verificationPolicy = verificationPolicyForVariant(variant);
  return {
    schemaVersion: "1.0",
    request,
    analysisReport: {
      scope: `${task.container}.${task.method} and its class TODO dependency closure`,
    },
    migrationPlan: {
      taskId,
      scope: "selected method with class prerequisites",
      outputProvenance:
        variant === "correct" ||
        variant === "target-only-correct" ||
        variant === "missing-test-basis" ||
        variant === "missing-policy"
          ? "Apache Commons FileUpload 1.5 control, not a live translator output"
          : `Seeded ${variant} mutation of the Apache Commons FileUpload 1.5 control`,
    },
    translation: {
      round: 1,
      generatedContent,
      files,
      patchHash: calculatePatchHashV2(files),
    },
    ...(verificationPolicy === undefined ? {} : { verificationPolicy }),
  } as VerificationInput;
}
