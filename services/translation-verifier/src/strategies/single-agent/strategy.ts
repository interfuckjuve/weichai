import type { AgentHost, AgentTask } from "../../host/task.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createRunTargetTestsTool } from "../../host/tools/run-target-tests.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
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

/** Agent candidate conclusion accepted by the Host plus its fresh observation. */
export type SingleAgentHostResult = {
  verdict: "no-bug" | "bug-found" | "uncertain";
  summary: string;
  issue?: VerificationIssue;
  targetFunction?: TargetFunctionCoverage;
};

function toVerificationResult(
  result: SingleAgentHostResult,
): VerificationResult {
  return {
    status: result.verdict === "no-bug" ? "success" : "failure",
    ...(result.issue ? { issue: result.issue } : {}),
    ...(result.targetFunction ? { targetFunction: { ...result.targetFunction } } : {}),
  };
}

/** Task for the LangChain Host: the Agent ends with a plain JSON report. */
export function createFinalReportTask(input: VerificationInput): AgentTask {
  return {
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
  };
}

/** The minimal strategy: compare source and target, test the target, then report. */
export function createSingleAgentStrategy(
  host: AgentHost<SingleAgentHostResult>,
): VerificationStrategy<VerificationResult> {
  return {
    verify: async (input) => {
      return toVerificationResult(await host.run(createFinalReportTask(input)));
    },
  };
}
