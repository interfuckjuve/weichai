import { execFileSync } from "node:child_process";
import { calculatePatchHashV2, canonicalJson } from "@forexplore/workflow-core";
import type { VerificationInput } from "../src/schemas/verification-types.js";
import {
  fileUploadInput,
  fileUploadTasks,
  repositoryRoot,
  sha256,
  type DatasetVariant,
  type FileUploadTaskId,
} from "./fileupload-benchmark-fixture.js";

export const E2E_TARGET_PROJECT_ID = "commons-fileupload-java-skeleton";

/** Shared Agent-facing input; control labels belong in the Host run manifest only. */
export function fileUploadVerificationInput(
  variant: DatasetVariant,
  task: FileUploadTaskId,
): VerificationInput {
  const input = fileUploadInput(variant, task);
  delete input.verificationPolicy;
  input.migrationPlan = {
    taskId: task,
    scope: "selected method with class prerequisites",
  };
  input.analysisReport = {
    scope: `${fileUploadTasks[task].container}.${fileUploadTasks[task].method} and its class TODO dependency closure`,
    provenance:
      "Simulated Analyzer report; no live upstream analysis was executed.",
    applicability: {
      level: variant.startsWith("target-only-") ? "reference" : "direct",
    },
    notes:
      "Assess reference suitability from the requirement and actual project evidence. Python materializes input while Java streams it; representation and exception timing may differ.",
  };
  input.request.requirement =
    `Verify ${fileUploadTasks[task].container}.${fileUploadTasks[task].method} against Python ${fileUploadTasks[task].sourceMethod}. ${fileUploadTasks[task].requirement} ` +
    "Use the existing project classes and dependencies, never a reimplemented shadow class. Python imports are rooted at src; Java uses the existing Maven pom.xml. " +
    "The modification scope is the selected class's TODO dependency closure; TODOs in other classes are outside this task. " +
    "Python materializes input; Java streams it, so allocation and exception timing need not match. For malformed multipart input both sides must reject it, but exception names/messages may differ. " +
    "The Python source is evidence, not an absolute oracle. Judge differences against the requirement and report source-only defects without blaming Java.";
  return input;
}

/** Host-only identity; a custom input never inherits the control's provenance label. */
export function createE2EDatasetRecord(
  input: VerificationInput,
  task: FileUploadTaskId,
  variant: DatasetVariant,
) {
  const inputHash = sha256(canonicalJson(input));
  const standardDatasetMatch =
    task === "multipart-read-body" &&
    variant === "correct" &&
    inputHash ===
      sha256(
        canonicalJson(
          fileUploadVerificationInput("correct", "multipart-read-body"),
        ),
      );
  const { request, analysisReport, migrationPlan } = input;
  let repositoryCommit: string | null = null;
  let workingTreeDirty: boolean | null = null;
  try {
    repositoryCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    workingTreeDirty =
      execFileSync(
        "git",
        ["status", "--porcelain", "--untracked-files=normal"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          timeout: 5000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim().length > 0;
  } catch {
    // Archive checkouts may not contain Git metadata; input hashes remain available.
  }
  return {
    schemaVersion: "1.0",
    datasetId: standardDatasetMatch
      ? "fileupload-verifier-v1/multipart-read-body/correct"
      : null,
    standardDatasetMatch,
    task,
    variant,
    targetProject: E2E_TARGET_PROJECT_ID,
    sourceProject: "commons-fileupload-python",
    repositoryCommit,
    workingTreeDirty,
    inputHash,
    pretranslationInputHash: sha256(
      canonicalJson({ request, analysisReport, migrationPlan }),
    ),
    sourceSnapshotHash: sha256(canonicalJson(request.sourceBundle.files)),
    targetSnapshotHash: sha256(
      canonicalJson(request.targetContext.sourceFiles),
    ),
    patchHash: calculatePatchHashV2(input.translation.files),
    modifiedPaths: input.translation.files.map((file) => file.path),
    translationOrigin: standardDatasetMatch
      ? "fixed-upstream-control"
      : "custom-or-legacy-unverified",
    ...(standardDatasetMatch
      ? {
          translationSource:
            "https://github.com/apache/commons-fileupload/blob/commons-fileupload-1.5/src/main/java/org/apache/commons/fileupload/MultipartStream.java",
          license: "Apache-2.0",
          modifiedMethods: [
            "MultipartStream.readBodyData",
            "MultipartStream.skipPreamble",
          ],
        }
      : {}),
    limitations: [
      "Real verifier agents with fixed translation input; no live Analyzer or Translator.",
      "The control label does not prove universal source equivalence or generated test adequacy.",
      "One execution per strategy is a workflow sample, not a performance ranking.",
    ],
  };
}
