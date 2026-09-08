import { describe, expect, it } from "vitest";
import {
  assertVerificationAssessment,
  failureAssessment,
  resolveVerificationPolicy,
} from "./verification-assessment.js";
import type {
  VerificationAssessment,
  VerificationInput,
} from "./verification-types.js";

const input = {
  verificationPolicy: {
    referenceDecision: "accepted",
    reason: "Reviewed reference snapshot",
    testBasis: "Return exact input length",
  },
} as VerificationInput;
function assessment(
  sourceAssessment: VerificationAssessment["sourceAssessment"],
  targetAssessment: VerificationAssessment["targetAssessment"],
): VerificationAssessment {
  const { testBasis: _basis, ...policy } = resolveVerificationPolicy(input);
  return {
    ...policy,
    executionStatus: "completed",
    sourceAssessment,
    targetAssessment,
    problems: [],
  };
}

describe("independent verification dimensions", () => {
  it("never accepts a reference without an explicit Host decision", () => {
    expect(resolveVerificationPolicy({})).toMatchObject({
      mode: "target_only",
      referenceDecision: "undetermined",
    });
    expect(
      resolveVerificationPolicy({
        verificationPolicy: {
          referenceDecision: "rejected",
          reason: "Unreliable",
        },
      }),
    ).toMatchObject({ mode: "target_only", referenceDecision: "rejected" });
    expect(resolveVerificationPolicy(input)).toMatchObject({
      mode: "differential",
      referenceDecision: "accepted",
    });
  });

  it.each([
    ["no_bug_observed", "no_bug_observed"],
    ["bug_found", "no_bug_observed"],
    ["no_bug_observed", "bug_found"],
    ["bug_found", "bug_found"],
    ["suspected_bug", "no_bug_observed"],
    ["no_bug_observed", "suspected_bug"],
    ["inconclusive", "no_bug_observed"],
  ] as const)("keeps source %s and target %s independent", (source, target) => {
    const value = assessment(source, target);
    expect(() => assertVerificationAssessment(value, input)).not.toThrow();
    expect(value).toMatchObject({
      sourceAssessment: source,
      targetAssessment: target,
    });
    expect(value).not.toHaveProperty("status");
  });

  it("retains confirmed target findings alongside a partial command timeout", () => {
    const value = assessment("inconclusive", "bug_found");
    value.executionStatus = "partial";
    value.problems = [
      {
        code: "command_timeout",
        message: "Later case timed out",
        side: "target",
        commandId: "run-2",
      },
    ];
    expect(() => assertVerificationAssessment(value, input)).not.toThrow();
    expect(value.targetAssessment).toBe("bug_found");
  });

  it("does not claim source results during target-only verification", () => {
    const targetInput = {
      verificationPolicy: {
        referenceDecision: "rejected",
        reason: "Untrusted",
        testBasis: "Return length",
      },
    } as VerificationInput;
    const value = {
      ...failureAssessment(targetInput, "agent_error", "Not started"),
      executionStatus: "completed" as const,
      targetAssessment: "no_bug_observed" as const,
      problems: [],
    };
    expect(value.sourceAssessment).toBe("not_checked");
    expect(value.targetAssessment).toBe("no_bug_observed");
    expect(() =>
      assertVerificationAssessment(value, targetInput),
    ).not.toThrow();
    expect(() =>
      assertVerificationAssessment(
        { ...value, sourceAssessment: "no_bug_observed" },
        targetInput,
      ),
    ).toThrow("unexecuted source");
    expect(() => assertVerificationAssessment(value, input)).toThrow(
      "Host reference decision",
    );
  });

  it.each([
    "insufficient_test_basis",
    "report_missing",
    "report_invalid_json",
    "report_schema_invalid",
    "report_evidence_invalid",
    "workspace_integrity_violation",
  ] as const)("does not trust code conclusions with %s", (code) => {
    const value = {
      ...assessment("no_bug_observed", "bug_found"),
      executionStatus: "partial" as const,
      problems: [{ code, message: code }],
    };
    expect(() => assertVerificationAssessment(value, input)).toThrow(
      "cannot establish code findings",
    );
    expect(failureAssessment(input, code, code)).toMatchObject({
      executionStatus: "failed",
      targetAssessment: "inconclusive",
    });
  });

  it.each([
    "cancelled",
    "agent_timeout",
    "command_timeout",
    "insufficient_test_basis",
  ] as const)(
    "rejects completed results with unresolved %s problems",
    (code) => {
      expect(() =>
        assertVerificationAssessment(
          {
            ...assessment("no_bug_observed", "no_bug_observed"),
            problems: [{ code, message: code }],
          },
          input,
        ),
      ).toThrow("Completed verification cannot contain");
    },
  );

  it("rejects a cancellation problem disguised as partial execution", () => {
    expect(() =>
      assertVerificationAssessment(
        {
          ...assessment("no_bug_observed", "bug_found"),
          executionStatus: "partial",
          problems: [{ code: "cancelled", message: "Caller cancelled" }],
        },
        input,
      ),
    ).toThrow("Cancellation problems require cancelled");
  });

  it("reports cancellation separately from a failed verification", () => {
    expect(
      failureAssessment(input, "cancelled", "Caller stopped"),
    ).toMatchObject({
      executionStatus: "cancelled",
      targetAssessment: "inconclusive",
      problems: [{ code: "cancelled" }],
    });
    expect(
      failureAssessment(input, "agent_timeout", "Deadline exceeded"),
    ).toMatchObject({
      executionStatus: "failed",
      targetAssessment: "inconclusive",
      problems: [{ code: "agent_timeout" }],
    });
  });
});
