import type {
  VerificationInput,
  VerificationResult,
  VerificationStrategyDescriptor,
} from "./verification-types.js";
import { canonicalJson } from "@forexplore/workflow-core";
import {
  assertSchema,
  validateDescriptorSchema,
  validateResultSchema,
} from "./compile-schema-validators.js";
import { assertVerificationInput } from "./validate-verification-input.js";
import { createVerificationResult } from "./materialize-verification-result.js";

/** Rebuild the status-free envelope to verify exact input and result bindings. */
export function assertVerificationResult(
  result: VerificationResult,
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
): VerificationResult {
  assertVerificationInput(input);
  assertSchema(
    validateDescriptorSchema,
    descriptor,
    "Verification strategy descriptor",
  );
  assertSchema(validateResultSchema, result, "Verification result");
  if (result.strategyId !== descriptor.id) {
    throw new Error(
      "Verification result strategy ID does not match the selected strategy.",
    );
  }
  if (result.strategyVersion !== descriptor.version) {
    throw new Error(
      "Verification result strategy version does not match the selected strategy.",
    );
  }
  if (result.round !== input.translation.round) {
    throw new Error(
      "Verification result round does not match the verification input.",
    );
  }
  if (result.subjectHash !== input.translation.patchHash) {
    throw new Error(
      "Verification result subject hash does not match the selected patch hash.",
    );
  }
  const expected = createVerificationResult(
    input,
    descriptor,
    {
      mode: result.mode,
      referenceDecision: result.referenceDecision,
      referenceReason: result.referenceReason,
      executionStatus: result.executionStatus,
      sourceAssessment: result.sourceAssessment,
      targetAssessment: result.targetAssessment,
      problems: result.problems,
      summary: result.summary,
      issues: result.issues,
      artifacts: result.artifacts,
      strategyReport: result.strategyReport,
    },
    () => result.createdAt,
  );
  if (result.inputHash !== expected.inputHash) {
    throw new Error(
      "Verification result input hash does not match the request, reference policy and test basis.",
    );
  }
  if (
    result.contentHash !== expected.contentHash ||
    canonicalJson(expected) !== canonicalJson(result)
  ) {
    throw new Error(
      "Verification result content hash does not match its materialized envelope.",
    );
  }
  return result;
}
