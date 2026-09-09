import type {
  VerificationAssessment,
  VerificationInput,
  VerificationProblem,
} from "./verification-types.js";

/** Legacy smoke policy; resource access and autonomous strategies do not use this decision. */
export function resolveVerificationPolicy(
  input: Pick<VerificationInput, "verificationPolicy">,
): {
  mode: VerificationAssessment["mode"];
  referenceDecision: VerificationAssessment["referenceDecision"];
  referenceReason: string;
  testBasis?: string;
} {
  const policy = input.verificationPolicy;
  return {
    mode:
      policy?.referenceDecision === "accepted" ? "differential" : "target_only",
    referenceDecision: policy?.referenceDecision ?? "undetermined",
    referenceReason:
      policy?.reason ??
      "The Host has not accepted the reference implementation.",
    ...(policy?.testBasis === undefined ? {} : { testBasis: policy.testBasis }),
  };
}

export function failureAssessment(
  input: Pick<VerificationInput, "verificationPolicy">,
  code: VerificationProblem["code"],
  message: string,
): VerificationAssessment {
  const { testBasis: _basis, ...policy } = resolveVerificationPolicy(input);
  return {
    ...policy,
    executionStatus: code === "cancelled" ? "cancelled" : "failed",
    sourceAssessment:
      policy.mode === "target_only" ? "not_checked" : "inconclusive",
    targetAssessment: "inconclusive",
    problems: [{ code, message }],
  };
}

export function assertVerificationAssessment(
  value: VerificationAssessment,
  _input: VerificationInput,
): void {
  if (value.mode === "differential" && value.referenceDecision !== "accepted")
    throw new Error(
      "Differential verification requires an accepted reference.",
    );
  if (value.mode === "target_only" && value.sourceAssessment !== "not_checked")
    throw new Error(
      "Target-only verification cannot assess the unexecuted source.",
    );
  if (
    value.executionStatus === "failed" &&
    [value.sourceAssessment, value.targetAssessment].some(
      (side) => side === "bug_found" || side === "no_bug_observed",
    )
  )
    throw new Error(
      "Failed execution cannot claim completed findings; preserve valid findings as partial instead.",
    );
  if (
    value.executionStatus === "completed" &&
    value.targetAssessment === "not_checked"
  )
    throw new Error("Completed verification must assess the target.");
  if (value.executionStatus === "completed" && value.problems.length > 0)
    throw new Error(
      "Completed verification cannot contain unresolved execution problems.",
    );
  if (
    value.problems.some((problem) => problem.code === "cancelled") &&
    value.executionStatus !== "cancelled"
  )
    throw new Error(
      "Cancellation problems require cancelled execution status.",
    );
  if (value.executionStatus !== "completed" && value.problems.length === 0)
    throw new Error(
      "Incomplete verification must explain its execution problems.",
    );
  if (
    value.problems.some(
      (problem) =>
        problem.code === "insufficient_test_basis" ||
        problem.code === "workspace_integrity_violation" ||
        problem.code === "report_evidence_invalid" ||
        problem.code === "report_invalid_json" ||
        problem.code === "report_schema_invalid" ||
        problem.code === "report_missing",
    ) &&
    [value.sourceAssessment, value.targetAssessment].some(
      (side) => side === "bug_found" || side === "no_bug_observed",
    )
  )
    throw new Error(
      "Invalid report or evidence cannot establish code findings.",
    );
}
