import { failureAssessment } from "../../schemas/verification-assessment.js";
import type {
  VerificationAssessment,
  VerificationInput,
  VerificationProblem,
} from "../../schemas/verification-types.js";
import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import { currentRunRecorder } from "../../run-output/record-run.js";
import {
  commandEvidenceProblems,
  evaluateSmokeReport,
} from "./decide-test-verdict.js";
import { readCommandEvidence } from "./command-evidence.js";
import { SmokeVerificationError } from "./smoke-errors.js";
import { assertWorkspaceBaseline } from "./protect-project-files.js";
import { readReport, errorSummary } from "./read-test-report.js";
import { assertSmokeReport } from "./validate-test-report.js";
import type { SmokeReport } from "./differential-test-types.js";
import type { SmokeResult } from "./run-smoke-verification.js";
import type { RunLayout } from "./prepare-projects.js";

export type SmokeOutcome = VerificationAssessment &
  Pick<SmokeResult, "summary" | "report"> &
  Partial<Pick<SmokeResult, "passRate" | "bugCases">>;

export async function evaluateEvidence(
  layout: RunLayout,
  input: Pick<VerificationInput, "verificationPolicy">,
): Promise<SmokeOutcome> {
  const recorder = currentRunRecorder();
  const handle = recorder?.startStep("evaluate-evidence", {
    scope: "strategy",
  });
  let report: SmokeReport | null = null;
  const problems: VerificationProblem[] = [];
  const recordError = (error: unknown) =>
    problems.push({
      code:
        error instanceof SmokeVerificationError ? error.code : "internal_error",
      message: errorSummary(error),
    });
  try {
    markVerificationPhase("report-read-and-schema-validation");
    report = await readReport<SmokeReport>(layout.agentDir, (raw) =>
      assertSmokeReport(raw, input),
    );
  } catch (error) {
    recordError(error);
  }
  try {
    markVerificationPhase("final-baseline-validation");
    assertWorkspaceBaseline(layout.executionRoot, layout.baselinePath);
  } catch (error) {
    recordError(error);
  }
  let evidence: unknown[] = [];
  try {
    markVerificationPhase("command-evidence-read");
    evidence = readCommandEvidence(layout.evidencePath);
  } catch (error) {
    recordError(error);
  }
  if (problems.length || report === null) {
    problems.push(...commandEvidenceProblems(evidence));
    const first = problems[0];
    recorder?.endStep(handle, "failed", first.message);
    return {
      ...failureAssessment(input, first.code, first.message),
      summary: first.message,
      report,
      problems,
    };
  }
  try {
    markVerificationPhase("evidence-evaluation-and-smoke-result");
    const evaluation = evaluateSmokeReport(report, evidence, input);
    const passRate =
      report.cases.length === 0
        ? undefined
        : report.cases.filter((item) => item.mechanical === "pass").length /
          report.cases.length;
    recorder?.endStep(handle, "completed");
    return { ...evaluation, passRate, report };
  } catch (error) {
    recorder?.endStep(handle, "failed", error);
    recordError(error);
    problems.push(...commandEvidenceProblems(evidence));
    const first = problems[0];
    return {
      ...failureAssessment(input, first.code, first.message),
      summary: first.message,
      report,
      problems,
    };
  }
}
