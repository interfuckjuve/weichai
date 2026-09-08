import type {
  CommandEvidence,
  SmokeCaseVerdict,
  SmokeDecision,
  SmokeReport,
} from "./differential-test-types.js";
import { VERIFIER_COMMAND_ENTRY } from "./test-execution-config.js";

import type { VerificationAssessment } from "../../schemas/verification-types.js";
export const acceptedPolicy = {
  referenceDecision: "accepted",
  reason: "Host accepted fixture reference",
  testBasis: "The result must be ok.",
} as const;
export function validAssessment(
  targetAssessment: VerificationAssessment["targetAssessment"] = "no_bug_observed",
): VerificationAssessment {
  return {
    mode: "differential",
    referenceDecision: "accepted",
    referenceReason: acceptedPolicy.reason,
    executionStatus: "completed",
    sourceAssessment: "no_bug_observed",
    targetAssessment,
    problems: [],
  };
}

export function validSmokeCase(
  decision: SmokeDecision = "pass",
): SmokeCaseVerdict {
  const result = {
    caseId: "c1",
    outcome: "return" as const,
    returnValue: { type: "string" as const, value: "ok" },
  };
  return {
    caseId: "c1",
    intent: "正常输入",
    source: result,
    target:
      decision === "translation-bug"
        ? { ...result, returnValue: { type: "string", value: "bad" } }
        : result,
    sourceAssessment: "no_bug_observed",
    targetAssessment:
      decision === "translation-bug"
        ? "bug_found"
        : decision === "unclear"
          ? "inconclusive"
          : "no_bug_observed",
    requirement: { basis: acceptedPolicy.testBasis, expected: result },
    commandIds: { source: "source-run", target: "target-run" },
    mechanical: decision === "pass" ? "pass" : "fail",
    decision,
    reasoning: "实际执行证据完整",
  };
}

export function validSmokeReport(
  overrides: Partial<SmokeReport> = {},
): SmokeReport {
  return {
    converged: true,
    steps: 4,
    rounds: 0,
    cases: [validSmokeCase()],
    targetFiles: [],
    runnerFiles: [
      {
        side: "source",
        language: "Java",
        files: [
          {
            path: "source/.forexplore-tests/SourceRunner.java",
            content: "class SourceRunner {}",
          },
        ],
      },
      {
        side: "target",
        language: "C#",
        files: [
          {
            path: "target/.forexplore-tests/TargetRunner.cs",
            content: "class TargetRunner {}",
          },
        ],
      },
    ],
    executions: [
      {
        side: "source",
        phase: "compile",
        commandId: "source-compile",
        exitCode: 0,
        durationMs: 10,
      },
      {
        side: "source",
        phase: "run",
        commandId: "source-run",
        exitCode: 0,
        durationMs: 10,
      },
      {
        side: "target",
        phase: "compile",
        commandId: "target-compile",
        exitCode: 0,
        durationMs: 10,
      },
      {
        side: "target",
        phase: "run",
        commandId: "target-run",
        exitCode: 0,
        durationMs: 10,
      },
    ],
    sourceIssues: [],
    summary: "1/1 case 通过",
    ...overrides,
  };
}

export function validCommandEvidence(
  report = validSmokeReport(),
): CommandEvidence[] {
  return report.executions!.map((item) => ({
    ...item,
    cwd: `${item.side}/project`,
    command: `npx tsx ${VERIFIER_COMMAND_ENTRY} --side ${item.side} --phase ${item.phase}`,
    baselineValid: true,
    timedOut: false,
    stdout:
      item.phase === "run"
        ? JSON.stringify(report.cases.map((entry) => entry[item.side]))
        : "ok",
    stderr: "",
  }));
}
