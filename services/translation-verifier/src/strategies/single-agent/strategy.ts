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
  VerificationInput,
  VerificationResult,
  VerificationStrategy,
} from "../../types.js";

function formatEntity(entity: { path: string; name: string; signature?: string }): string {
  const signature = entity.signature ? ` (${entity.signature})` : "";
  return `${entity.name}${signature} in ${entity.path}`;
}

export type SingleAgentTerminalResult = FinishResult | ReportUncertainResult;

function toVerificationResult(
  result: SingleAgentTerminalResult,
): VerificationResult {
  if ("translationStatus" in result) {
    return {
      status: result.translationStatus,
      ...(result.issue ? { issue: result.issue } : {}),
    };
  }
  return { status: "failure", issue: result.issue };
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
    },
    systemPrompt: [
      "You are a translation verification agent.",
      "Compare the source reference function with the target function and determine whether the target preserves the required behavior.",
      "The target function named in the task is the subject under test.",
      "Use only the provided tools and project-relative paths.",
      "Inspect the relevant source and target files before making a judgment.",
      "Create a focused test for the target function in an authorized target test root, run it with run_target_tests, and use the Host result as the test status.",
      "After the final test run, call finish with matching testExecutionStatus and translationStatus.",
      "If finish is rejected, treat the reported Host test status and output as authoritative; correct the status or continue investigating before trying to finish again.",
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

/** The minimal strategy: compare source and target, test the target, then report. */
export function createSingleAgentStrategy(
  host: AgentHost<SingleAgentTerminalResult>,
): VerificationStrategy<VerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(createSingleAgentTask(input))),
  };
}
