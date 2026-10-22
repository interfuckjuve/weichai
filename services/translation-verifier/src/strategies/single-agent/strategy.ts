import type { AgentHost, AgentTask } from "../../host/agent.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createReportUncertainTool } from "../../host/tools/report-uncertain.js";
import { createRunTargetTestsTool } from "../../host/tools/run-target-tests.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
import { createFinishTool, type FinishResult } from "../../host/tools/finish.js";
import type { ReportUncertainResult } from "../../host/tools/report-uncertain.js";
import type {
  TargetFunctionCoverage,
  VerificationInput,
  VerificationIssue,
  VerificationResult,
  VerificationStrategy,
} from "../../types.js";

function formatEntity(entity: { path: string; name: string; signature?: string }): string {
  const signature = entity.signature ? ` (${entity.signature})` : "";
  return `${entity.name}${signature} in ${entity.path}`;
}

export type SingleAgentTerminalResult =
  | FinishResult
  | Extract<ReportUncertainResult, { targetTest: unknown }>;

/** Agent candidate conclusion accepted by the LangChain Host plus its fresh observation. */
export type SingleAgentFinalReport = {
  verdict: "no-bug" | "bug-found" | "uncertain";
  summary: string;
  issue?: VerificationIssue;
  targetFunction?: TargetFunctionCoverage;
};

export type SingleAgentHostResult = SingleAgentTerminalResult | SingleAgentFinalReport;

function toVerificationResult(
  result: SingleAgentHostResult,
): VerificationResult {
  if ("verdict" in result) {
    return {
      status: result.verdict === "no-bug" ? "success" : "failure",
      ...(result.issue ? { issue: result.issue } : {}),
      ...(result.targetFunction ? { targetFunction: { ...result.targetFunction } } : {}),
    };
  }
  const targetFunction = result.targetTest.coverage?.status === "available"
    ? result.targetTest.coverage.targetFunction
    : undefined;
  return {
    status: "translationStatus" in result ? result.translationStatus : "failure",
    ...(result.issue ? { issue: result.issue } : {}),
    ...(targetFunction ? { targetFunction: { ...targetFunction } } : {}),
  };
}

export function createSingleAgentTask(
  input: VerificationInput,
): AgentTask {
  return {
    subject: input.subject,
    taskContext: {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.sourceProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: input.subject.sourceFunction.path,
      targetPath: input.subject.targetFunction.path,
      targetFunction: { ...input.subject.targetFunction },
    },
    systemPrompt: [
      "You are a translation verification agent.",
      "Compare the source reference function with the target function and determine whether the target preserves the required behavior.",
      "The target function named in the task is the subject under test.",
      "Use only the provided tools and project-relative paths.",
      "Inspect the relevant source and target files before making a judgment.",
      "First inspect the dedicated authorized test folder and run ALL existing tests in it with run_target_tests with path omitted before writing new tests. If the folder is empty, proceed to creating tests.",
      "Establish a passing baseline with no skipped tests: diagnose compilation and assertion failures. Rewrite stale tests when source/API or declared contract changes justify it, including fixtures, imports and signatures. Use requirements and declared contracts for expected outcomes; never erase a valid requirement failure by copying current implementation behavior. Retain and report an actual production regression even if it prevents the baseline passing.",
      "Then write or update meaningful tests for the upstream target function inside that dedicated folder, run them with run_target_tests, and use the Host result as the test status.",
      "When ready, call finish. The Host runs ALL tests in the dedicated folder together once and collects target-function coverage. Every test must compile and execute without skips; assertions demonstrating a real requirement bug may fail and must be preserved with a failure report.",
      "Successful verification requires the complete current suite to pass with no skipped tests, at least one executed test, and Host coverage showing the target function was executed. Coverage percentages are evidence, not minimum thresholds.",
      "If coverage is unavailable, investigate the reported reason or call report_uncertain; never invent coverage values.",
      "Call finish with matching testExecutionStatus and translationStatus. The current full-suite Host result is authoritative.",
      "If finish returns outcome='continue', read feedback, targetTest and reportPaths, debug or extend the tests, then call finish again. Unmet checks keep you running; a confirmed production bug may finish with failure and an issue.",
      "If the task cannot be verified reliably, call report_uncertain instead of guessing.",
      "A terminal tool call must be the only call in its turn.",
    ].join("\n"),
    userPrompt: [
      `Source reference function: ${formatEntity(input.subject.sourceFunction)}`,
      `Target function to verify: ${formatEntity(input.subject.targetFunction)}`,
      `Source language: ${input.sourceLanguage}`,
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.subject.requirement}`,
      "Use the analysis report and migration plan as supporting evidence, but validate behavior with the target test.",
      `Analysis report: ${JSON.stringify(input.analysisReport)}`,
      `Migration plan: ${JSON.stringify(input.migrationPlan)}`,
      `Translation round: ${input.translation.round}`,
    ].join("\n"),
    tools: [
      createListSourceFilesTool(),
      createReadSourceFileTool(),
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunTargetTestsTool(),
      createFinishTool(),
      createReportUncertainTool(),
    ],
    terminalTools: ["finish", "report_uncertain"],
  };
}

/** Task for the LangChain Host: no terminal tools, the Agent ends with a JSON report. */
export function createFinalReportTask(input: VerificationInput): AgentTask {
  return {
    subject: input.subject,
    taskContext: {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.sourceProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: input.subject.sourceFunction.path,
      targetPath: input.subject.targetFunction.path,
      targetFunction: { ...input.subject.targetFunction },
    },
    systemPrompt: [
      "You are a translation verification agent.",
      "Compare the source reference function with the target function and decide whether the target preserves the required behavior.",
      "Use only the provided tools and project-relative paths.",
      "Inspect the relevant source and target files before making a judgment.",
      "First run ALL existing tests in the dedicated authorized test folder with run_target_tests and path omitted. If the folder is empty, create tests next.",
      "Establish a passing baseline with no skipped tests: diagnose compilation and assertion failures. Rewrite stale tests only when the source/API or declared contract changed, including fixtures, imports and signatures. Never erase a valid requirement failure by copying current implementation behavior.",
      "Then write or update meaningful tests for the target function inside that dedicated folder, run them with run_target_tests, and use the Host result as the test status.",
      "Successful no-bug verification requires the complete current suite to compile and execute, every test to pass without skips, the target function to have execution evidence, and the requirement to have no unresolved ambiguity.",
      "A bug-found conclusion requires a valid failing assertion that reproduces the defect, a concrete translation issue description, and affectedTargets listing the requested target function.",
      "If all tests pass and the requirement still has a concrete ambiguity, report uncertain with an unknown issue that explains the missing evidence. Do not guess the requirement from the implementation.",
      "When you are done, end the current Agent call with an ordinary final assistant message containing ONLY this JSON object (no tool call):",
      '{"verdict":"no-bug"|"bug-found"|"uncertain","summary":"<required>","issue":{"kind":"translation","description":"..."},"affectedTargets":[{"path":"...","name":"...","signature":"..."}]}',
      "A no-bug report omits issue. A bug-found report uses issue kind translation and lists affectedTargets. An uncertain report uses issue kind unknown with the concrete ambiguity.",
      "The Host reruns the complete dedicated test folder after every natural ending and may append feedback. Read that feedback, repair the same tests, and end again with a corrected report. Do not invent coverage or test counts; the Host owns them.",
    ].join("\n"),
    userPrompt: [
      `Source reference function: ${formatEntity(input.subject.sourceFunction)}`,
      `Target function to verify: ${formatEntity(input.subject.targetFunction)}`,
      `Source language: ${input.sourceLanguage}`,
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.subject.requirement}`,
      "Use the analysis report and migration plan as supporting evidence, but validate behavior with the target test.",
      `Analysis report: ${JSON.stringify(input.analysisReport)}`,
      `Migration plan: ${JSON.stringify(input.migrationPlan)}`,
      `Translation round: ${input.translation.round}`,
    ].join("\n"),
    tools: [
      createListSourceFilesTool(),
      createReadSourceFileTool(),
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunTargetTestsTool(),
    ],
    terminalTools: [],
  };
}

/** The minimal strategy: compare source and target, test the target, then report. */
export function createSingleAgentStrategy(
  host: AgentHost<SingleAgentHostResult>,
): VerificationStrategy<VerificationResult> {
  return {
    verify: async (input) => {
      const task = host.taskProtocol === "final-report"
        ? createFinalReportTask(input)
        : createSingleAgentTask(input);
      return toVerificationResult(await host.run(task));
    },
  };
}
