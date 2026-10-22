import type { ProtocolCheck, VerificationFunction, VerificationIssue } from "../types.js";
import type {
  FunctionGroupTestRun,
  TargetTestResult,
  ToolContext,
} from "./tools/common.js";
import { runFunctionGroupTests } from "./tools/run-function-group-tests.js";
import { runTargetTests } from "./tools/run-target-tests.js";

/**
 * A completion check on the file system: the Host reruns the complete
 * dedicated test folder and reports the fresh observation together with every
 * unmet completion condition.
 */
export type Revalidation<Observation> = {
  /** Fresh Host observation from rerunning the complete dedicated test folder. */
  observation: Observation;
  /** Unmet completion conditions to return to the Agent; empty when accepted. */
  feedback: string[];
};

export type TargetClaim = {
  testExecutionStatus: TargetTestResult["status"];
  translationStatus: "success" | "failure";
};

export type FunctionGroupClaim = TargetClaim & {
  protocolChecks?: ProtocolCheck[];
};

/** The Agent's own conclusion in a plain final assistant message. */
export type FinalReportClaim = {
  verdict: "no-bug" | "bug-found" | "uncertain";
  summary: string;
  issue?: VerificationIssue;
  /** Target functions the Agent identifies as affected by a reported bug. */
  affectedTargets?: VerificationFunction[];
};

export type TargetRevalidation = Revalidation<TargetTestResult>;

export type FunctionGroupRevalidation = Revalidation<FunctionGroupTestRun>;

/**
 * Reruns the complete dedicated test folder for the requested target function
 * and checks the Agent's status claims against that fresh Host observation.
 * The observation is the same one the Agent test tool produces.
 */
export async function revalidateTargetFunction(
  context: ToolContext,
  claim: TargetClaim,
): Promise<TargetRevalidation> {
  const targetTest = await runTargetTests(context);
  const feedback: string[] = [];
  if (targetTest.timedOut || targetTest.exitCode === null || (targetTest.executionErrors ?? 0) > 0 || !targetTest.tests || targetTest.tests.executed < 1 ||
      (targetTest.status === "failure" && targetTest.tests.failed < 1)) {
    feedback.push("The complete test folder must compile and execute before finish. Repair compilation/setup errors and rerun, or report_uncertain if blocked.");
  }
  if ((targetTest.tests?.skipped ?? 0) > 0) {
    feedback.push("The complete test folder must execute without skipped tests before finish.");
  }
  if (targetTest.coverage?.status !== "available" || !targetTest.coverage.targetFunction.executed) {
    feedback.push("The complete test folder must execute the requested target function before finish. Inspect the coverage result and reportPaths, then repair the tests or coverage setup.");
  }
  if (claim.testExecutionStatus !== targetTest.status) {
    feedback.push(`finish.testExecutionStatus does not match the Host result: expected ${targetTest.status}. Investigate the current result before resubmitting.`);
  }
  if (claim.translationStatus !== targetTest.status) {
    feedback.push(`finish.translationStatus does not match the Host result: expected ${targetTest.status}. Debug test-authoring errors or report a real production bug with a concrete issue.`);
  }
  if (claim.translationStatus === "success" && (targetTest.tests?.failed ?? 0) > 0) {
    feedback.push("Successful verification requires every test in the dedicated folder to pass. Diagnose the failed tests before claiming success; preserve valid failing requirement assertions.");
  }
  return { observation: targetTest, feedback };
}

/**
 * Reruns the complete dedicated test folder after the Agent ended with a
 * plain final report. The fresh observation decides acceptance; the report is
 * only the Agent's candidate conclusion.
 */
export async function revalidateTargetReport(
  context: ToolContext,
  report?: FinalReportClaim,
): Promise<TargetRevalidation> {
  const targetTest = await runTargetTests(context);
  const feedback: string[] = [];
  const executedFunction = targetTest.coverage?.status === "available"
    ? targetTest.coverage.targetFunction
    : undefined;
  const missingFailedAssertion = (targetTest.tests?.failed ?? 0) < 1;
  if (targetTest.timedOut || targetTest.exitCode === null || (targetTest.executionErrors ?? 0) > 0 || !targetTest.tests || targetTest.tests.executed < 1 || (targetTest.status === "failure" && missingFailedAssertion)) {
    feedback.push("The complete test folder must compile and execute before the final report. Repair compilation/setup errors and rerun; a failing environment or test-authoring error is not a production defect.");
  }
  if ((targetTest.tests?.skipped ?? 0) > 0) {
    feedback.push("The complete test folder must execute without skipped tests before the final report.");
  }
  if (executedFunction === undefined || !executedFunction.executed) {
    feedback.push("The complete test folder must execute the requested target function before the final report. Inspect the coverage result and reportPaths, then repair the tests or coverage setup.");
  }
  if (report === undefined) return { observation: targetTest, feedback };

  const suitePassed = targetTest.status === "success" && (targetTest.tests?.failed ?? 0) === 0;
  const requestedTarget = context.runtime.targetFunction;
  const affectedTargets = report.affectedTargets ?? [];
  const outOfScope = affectedTargets.filter(target =>
    target.path !== requestedTarget.path || target.name !== requestedTarget.name ||
    (target.signature ?? undefined) !== (requestedTarget.signature ?? undefined));

  if (report.verdict === "no-bug" && !suitePassed) {
    feedback.push("A no-bug report requires every test in the dedicated folder to pass. Diagnose the failure or report the evidenced production bug; preserve valid failing requirement assertions.");
  }
  if (report.verdict === "bug-found") {
    if (missingFailedAssertion) {
      feedback.push("A bug-found report requires at least one valid failing assertion that reproduces the reported defect. Add the reproduction or correct the verdict.");
    }
    if (affectedTargets.length === 0) {
      feedback.push("A bug-found report must list the affected target functions in affectedTargets using the requested path, name and signature.");
    }
    if (outOfScope.length > 0) {
      feedback.push(`affectedTargets must stay inside the requested verification scope: ${outOfScope.map(target => `${target.path}#${target.name}`).join(", ")}.`);
    }
  }
  if (report.verdict === "uncertain" && !suitePassed) {
    feedback.push("An uncertain report requires every test in the dedicated folder to pass with execution evidence for the target function. It cannot bypass compile, execution or assertion failures.");
  }
  return { observation: targetTest, feedback };
}

/**
 * Reruns the complete dedicated test folder for the requested function group
 * and checks the Agent's status claim, protocol checks and per-function
 * execution evidence against that fresh Host observation.
 */
export async function revalidateFunctionGroup(
  context: ToolContext,
  claim: FunctionGroupClaim,
): Promise<FunctionGroupRevalidation> {
  const result = await runFunctionGroupTests(context);
  const feedback: string[] = [];
  if (result.timedOut || result.exitCode === null || (result.executionErrors ?? 0) > 0 || result.tests.executed < 1 ||
      (result.status === "failure" && result.tests.failed < 1)) {
    feedback.push("The complete test folder must compile and execute before finish_function_group. Repair compilation/setup errors and rerun, or report_uncertain if blocked.");
  }
  if (result.tests.skipped > 0) {
    feedback.push("The complete test folder must execute without skipped tests before finish_function_group.");
  }
  const requested = context.runtime.functionGroup?.functions ?? [];
  const unverified = requested.filter(({ target }) => !result.functions.some(item =>
    item.target.path === target.path && item.target.name === target.name &&
    item.target.signature === target.signature && item.executed &&
    (result.status === "failure" || item.status === "passed"),
  ));
  if (requested.length === 0 || unverified.length > 0) {
    feedback.push(`The complete test folder must execute every requested target function before finishing. Missing execution evidence: ${unverified.map(item => `${item.target.path}#${item.target.name}${item.target.signature ? ` (${item.target.signature})` : ""}`).join(", ")}. Inspect function coverage and reportPaths, then extend the tests or repair coverage setup.`);
  }
  if (claim.testExecutionStatus !== result.status) {
    feedback.push(`finish_function_group.testExecutionStatus does not match the Host result: expected ${result.status}. Investigate the current result before resubmitting.`);
  }
  if (claim.translationStatus !== result.status) {
    feedback.push(`finish_function_group.translationStatus does not match the Host result: expected ${result.status}. Debug test-authoring errors or report a real production bug with a concrete issue.`);
  }
  if (claim.translationStatus === "success") {
    if (claim.protocolChecks?.some(check => check.status === "failed" || check.status === "ambiguous")) {
      feedback.push("Cannot claim verification success with failed or ambiguous requirement checks. Retain the failing assertion or report_uncertain.");
    }
    if (result.tests.failed > 0) {
      feedback.push("Successful function-group verification requires every test in the dedicated folder to pass. Diagnose the failed tests before claiming success; preserve valid failing requirement assertions.");
    }
  }
  return { observation: result, feedback };
}
