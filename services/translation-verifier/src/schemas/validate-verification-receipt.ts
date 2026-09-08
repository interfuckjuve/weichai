import type {
  VerificationInput,
  VerificationReceipt,
  VerificationStrategyDescriptor,
} from "./verification-types.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "@forexplore/workflow-core";
import {
  assertSchema,
  validateReceiptSchema,
} from "./compile-schema-validators.js";
import { assertVerificationResult } from "./validate-verification-result.js";
import { normalizeArtifactPath } from "./validate-json-paths.js";

export function assertVerificationReceipt(
  receipt: VerificationReceipt,
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
): VerificationReceipt {
  assertSchema(validateReceiptSchema, receipt, "Verification receipt");
  assertVerificationResult(receipt.result, input, descriptor);
  if (receipt.resultArtifact === undefined) {
    if (
      receipt.result.executionStatus !== "failed" ||
      receipt.result.artifacts.length !== 0 ||
      [receipt.result.sourceAssessment, receipt.result.targetAssessment].some(
        (assessment) =>
          assessment === "bug_found" || assessment === "no_bug_observed",
      ) ||
      !receipt.result.problems.some(
        (problem) => problem.code === "artifact_persistence_failed",
      )
    ) {
      throw new Error(
        "Verification receipt may omit its result artifact only for artifact-persistence-failed.",
      );
    }
    return receipt;
  }
  const artifact = receipt.resultArtifact;
  const path = normalizeArtifactPath(artifact.path);
  const bytes = Buffer.from(canonicalJson(receipt.result), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (
    artifact.path !== path ||
    artifact.contentHash !== hash ||
    artifact.size !== bytes.byteLength ||
    artifact.id !== `verification-result:${path}`
  ) {
    throw new Error(
      "Verification receipt result artifact metadata does not match the canonical result bytes.",
    );
  }
  return receipt;
}
