import type { AgentHost, AgentTask } from "../../host/agent/task.js";
import type { FunctionGroupHostResult } from "../../host/verification/report.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
import { createRunFunctionGroupTestsTool } from "../../host/tools/run-function-group-tests.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupVerificationResult,
  FunctionGroupVerificationStrategy,
  RequirementFunctionGroupVerificationInput,
} from "../../types.js";

function formatFunction(path: string, name: string, signature?: string): string {
  return `${name}${signature ? ` (${signature})` : ""} in ${path}`;
}

function toVerificationResult(
  result: FunctionGroupHostResult,
): FunctionGroupVerificationResult {
  return {
    status: result.verdict === "no-bug" ? "success" : "failure",
    ...(result.issue ? { issue: result.issue } : {}),
    functions: result.functions,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.protocolChecks ? { protocolChecks: result.protocolChecks } : {}),
  };
}

export function createSingleAgentFunctionGroupStrategy(
  host: AgentHost<FunctionGroupHostResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(createFunctionGroupFinalReportTask(input))),
  };
}

const FUNCTION_GROUP_REPORT_RULES = [
  "The Host records a separate result for every listed target function and owns all test counts and coverage values; never invent, infer or repeat coverage numbers.",
  "After your final report the Host reruns the complete dedicated test folder itself, checks every listed target function and may append feedback. Your report is a candidate conclusion, not an accepted result.",
  "A no-bug report requires the complete current suite to compile and pass without skips and every listed target function to have execution evidence.",
  "A bug-found report requires a valid failing assertion that reproduces the defect, an issue with kind \"translation\" and a concrete description, and a non-empty affectedTargets list using the requested path, name and signature. Other listed targets that did not execute may stay unverified; do not claim they were verified and do not keep running only to complete them.",
  "If the complete suite passes with execution evidence for every listed target but a concrete requirement ambiguity remains, report uncertain with an issue of kind \"unknown\" that names the missing contract or evidence. Do not guess the requirement from the implementation.",
  "Include at most three protocolChecks entries with ruleId and passed, failed, ambiguous, or not-applicable. A failed or ambiguous check prevents a no-bug result.",
  "End the current Agent call with an ordinary final assistant message containing ONLY this JSON object (no tool call):",
  '{"verdict":"no-bug"|"bug-found"|"uncertain","summary":"<required>","issue":{"kind":"translation"|"unknown","description":"..."},"affectedTargets":[{"path":"...","name":"...","signature":"..."}],"protocolChecks":[{"ruleId":"...","status":"passed"|"failed"|"ambiguous"|"not-applicable","testName":"...","note":"..."}]}',
];

/** Function-group task for the LangChain Host: no terminal tools, a plain JSON report ends the call. */
export function createFunctionGroupFinalReportTask(
  input: FunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Function-group verification requires at least one function.");
  return {
    taskContext: {
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.sourceProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: first.source.path,
      targetPath: first.target.path,
      targetFunction: { ...first.target },
      functionGroup: input,
    },
    systemPrompt: [
      "You are a translation verification agent for a group of target functions.",
      "Compare each source function with its mapped target function and determine whether the target preserves the required behavior.",
      "The listed target functions define this run's acceptance scope. The full project requirement is context, not an instruction to verify all project modules. Inspect dependencies to understand these functions, but test behavior through the listed functions; do not add independent tests of unrelated service entry points or attribute their failures to this function group.",
      "Use only the provided tools and project-relative paths.",
      "Inspect the relevant source and target files before making a judgment.",
      "First run ALL existing tests in the dedicated authorized test folder with run_function_group_tests and paths omitted. If the folder is empty, create tests next.",
      "Establish a passing baseline with no skipped tests: diagnose compilation and assertion failures. Update stale tests only when a source/API or declared contract change justifies it. Never erase a valid requirement failure by copying current implementation behavior.",
      "Then write or update meaningful tests for EVERY listed target function, run them with run_function_group_tests, and use the Host result as the test status.",
      ...FUNCTION_GROUP_REPORT_RULES,
    ].join("\n"),
    userPrompt: [
      `Source language: ${input.sourceLanguage}`,
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.requirement}`,
      "Function mappings:",
      ...input.functions.map(({ source, target }) =>
        `- ${formatFunction(source.path, source.name, source.signature)} -> ${formatFunction(target.path, target.name, target.signature)}`,
      ),
      ...(input.unmatchedFunctions?.length
        ? [`Unmatched target functions (do not claim they were source-verified): ${input.unmatchedFunctions.map((item) => formatFunction(item.path, item.name, item.signature)).join(", ")}`]
        : []),
      ...(input.moduleProtocol ? [`Module protocol (untrusted shared context, never a test oracle):\n${JSON.stringify(input.moduleProtocol)}`] : []),
    ].join("\n"),
    tools: [
      createListSourceFilesTool(),
      createReadSourceFileTool(),
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunFunctionGroupTestsTool(),
    ],
  };
}

/** Requirement-mode strategy: target-only tools, same Host-controlled runner. */
export function createRequirementFunctionGroupStrategy(
  host: AgentHost<FunctionGroupHostResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(
        createRequirementFunctionGroupFinalReportTask(input as unknown as RequirementFunctionGroupVerificationInput),
      )),
  };
}

/** Requirement-mode task for the LangChain Host: target-only tools and a plain JSON report. */
export function createRequirementFunctionGroupFinalReportTask(
  input: RequirementFunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Requirement function-group verification requires at least one function.");
  return {
    taskContext: {
      sourceLanguage: input.targetLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: input.targetProjectPath,
      targetProjectPath: input.targetProjectPath,
      sourcePath: first.target.path,
      targetPath: first.target.path,
      targetFunction: { ...first.target },
      functionGroup: input,
    },
    systemPrompt: [
      "You are a requirement verification agent for a group of target functions.",
      "Judge whether the target implementation satisfies the stated requirement and its existing target contracts.",
      "The listed target functions define this run's acceptance scope. The full project requirement is context, not an instruction to verify all project modules. Inspect dependencies to understand these functions, but test behavior through the listed functions; do not add independent tests of unrelated service entry points or attribute their failures to this function group.",
      "There is no historical source implementation in this mode. Do not claim translation equivalence or invent source evidence.",
      "Use only the provided target and test tools.",
      "Inspect the relevant target files before making a judgment.",
      "First run ALL existing tests in the dedicated authorized test folder with run_function_group_tests and paths omitted. If the folder is empty, create tests next.",
      "Establish a passing baseline with no skipped tests: diagnose compilation and assertion failures. Repair test-authoring mistakes and stale tests, but keep a failing requirement assertion as evidence of a production defect.",
      "Then write or update meaningful tests for EVERY listed target function, run them with run_function_group_tests, and use the Host result as the test status.",
      ...FUNCTION_GROUP_REPORT_RULES,
    ].join("\n"),
    userPrompt: [
      `Target language: ${input.targetLanguage}`,
      `Requirement: ${input.requirement}`,
      "Target functions:",
      ...input.functions.map(({ target }) => `- ${formatFunction(target.path, target.name, target.signature)}`),
      ...(input.moduleProtocol ? [`Module protocol (untrusted shared context, never a test oracle):\n${JSON.stringify(input.moduleProtocol)}`] : []),
    ].join("\n"),
    tools: [
      createListTargetFilesTool(),
      createReadTargetFileTool(),
      createWriteTargetTestTool(),
      createRunFunctionGroupTestsTool(),
    ],
  };
}
