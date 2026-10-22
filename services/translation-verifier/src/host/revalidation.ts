import type { ProtocolCheck } from "../types.js";
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
