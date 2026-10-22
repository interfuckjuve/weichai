import type { AgentHost, AgentTask } from "../../host/agent.js";
import {
  createListSourceFilesTool,
  createListTargetFilesTool,
} from "../../host/tools/list-files.js";
import { createReadSourceFileTool } from "../../host/tools/read-source-file.js";
import { createReadTargetFileTool } from "../../host/tools/read-target-file.js";
import { createReportUncertainTool } from "../../host/tools/report-uncertain.js";
import { createWriteTargetTestTool } from "../../host/tools/write-target-test.js";
import { createRunFunctionGroupTestsTool } from "../../host/tools/run-function-group-tests.js";
import { createFinishFunctionGroupTool } from "../../host/tools/finish-function-group.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupVerificationResult,
  FunctionGroupVerificationStrategy,
  FunctionGroupFunctionResult,
  ProtocolCheck,
  RequirementFunctionGroupVerificationInput,
  VerificationFunction,
  VerificationIssue,
  VerificationReason,
} from "../../types.js";
import type { ReportUncertainResult } from "../../host/tools/report-uncertain.js";
import type { FinishFunctionGroupResult } from "../../host/tools/finish-function-group.js";

function formatFunction(path: string, name: string, signature?: string): string {
  return `${name}${signature ? ` (${signature})` : ""} in ${path}`;
}

export type SingleAgentFunctionGroupTerminalResult =
  | FinishFunctionGroupResult
  | Extract<ReportUncertainResult, { functionGroupTest: unknown }>;

/** Agent candidate conclusion accepted by the LangChain Host plus its fresh per-function observation. */
export type FunctionGroupFinalReport = {
  verdict: "no-bug" | "bug-found" | "uncertain";
  summary: string;
  issue?: VerificationIssue;
  functions: FunctionGroupFunctionResult[];
  reason?: VerificationReason;
  protocolChecks?: ProtocolCheck[];
};

export type SingleAgentFunctionGroupHostResult =
  | SingleAgentFunctionGroupTerminalResult
  | FunctionGroupFinalReport;

function toVerificationResult(
  result: SingleAgentFunctionGroupHostResult,
): FunctionGroupVerificationResult {
  if ("verdict" in result) {
    return {
      status: result.verdict === "no-bug" ? "success" : "failure",
      ...(result.issue ? { issue: result.issue } : {}),
      functions: result.functions,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.protocolChecks ? { protocolChecks: result.protocolChecks } : {}),
    };
  }
  const test = result.functionGroupTest;
  const reason = "translationStatus" in result || test.reason !== "verified" ? test.reason : undefined;
  return {
    status: "translationStatus" in result ? result.translationStatus : "failure",
    ...(reason ? { reason } : {}),
    ...(result.issue ? { issue: result.issue } : {}),
    functions: test.functions,
    ...("protocolChecks" in result && result.protocolChecks ? { protocolChecks: result.protocolChecks } : {}),

  };
}

export function createSingleAgentFunctionGroupTask(
  input: FunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Function-group verification requires at least one function.");
  return {
    subject: {
      sourceFunction: first.source,
      targetFunction: first.target,
      requirement: input.requirement,
    },
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
    functionGroup: input,
    systemPrompt: [
      "You are a translation verification agent for a group of target functions.",
      "Compare each source function with its mapped target function and determine whether the target preserves the required behavior.",
      "The listed target functions define this run's acceptance scope. The full project requirement is context, not an instruction to verify all project modules. Inspect dependencies to understand these functions, but test behavior through the listed functions; do not add independent tests of unrelated service entry points or attribute their failures to this function group.",
      "Use only the provided tools and project-relative paths.",
      "Inspect the relevant source and target files before making a judgment.",
      "First inspect the dedicated authorized test folder and run ALL existing tests in it with run_function_group_tests with paths omitted before writing new tests. If the folder is empty, proceed to creating tests.",
      "Establish a passing baseline: diagnose compilation and assertion failures. Update stale fixtures, imports, signatures or expectations only when source/API or declared contract changes justify the change. Source code is evidence of API shape, not permission to replace valid requirement expectations with current implementation behavior. Keep valid requirement failures and report a production defect if the baseline cannot pass for that reason.",
      "Then write or update meaningful tests for EVERY listed upstream target function, not just a representative subset, and run them using run_function_group_tests. All test writes stay inside the dedicated authorized folder.",
      "The Host records a separate result for every target function; do not infer or invent coverage values.",
      "If a module protocol is supplied, select the most important one to three related rules and exercise them through the public API. Report ambiguous when the public API cannot test a rule; ambiguous is not proof of success.",
      "When finishing, include protocolChecks with ruleId and passed, failed, ambiguous, or not-applicable. Failed or ambiguous requirement checks prevent overall verification success; use report_uncertain when passing tests leave a requirement unresolved.",
      "When ready, call finish_function_group. The Host runs ALL tests in the dedicated folder together once and collects coverage for EVERY listed target function. Every test must compile and execute without skips; keep failing assertions that demonstrate a real requirement defect and report failure with a concrete issue. Success requires the complete current suite to pass and every listed target to execute.",
      "Submit statuses matching the Host result. If finish_function_group returns outcome='continue', read feedback, functionGroupTest and reportPaths, debug or extend the tests, then call it again. Unmet checks keep you running; a confirmed production bug may finish with failure and an issue.",
      "If the task cannot be verified reliably, call report_uncertain instead of guessing.",
      "A terminal tool call must be the only call in its turn.",
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
      createFinishFunctionGroupTool(),
      createReportUncertainTool(),
    ],
    terminalTools: ["finish_function_group", "report_uncertain"],
  };
}

export function createSingleAgentFunctionGroupStrategy(
  host: AgentHost<SingleAgentFunctionGroupHostResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(
        host.taskProtocol === "final-report"
          ? createFunctionGroupFinalReportTask(input)
          : createSingleAgentFunctionGroupTask(input),
      )),
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
    subject: {
      sourceFunction: first.source,
      targetFunction: first.target,
      requirement: input.requirement,
    },
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
    functionGroup: input,
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
    terminalTools: [],
  };
}

/**
 * Requirement-only verification used when retrieval cannot establish a
 * trustworthy source/target mapping. It keeps the same Host-controlled test
 * runner, but the Agent judges the target against the requirement and target
 * contracts instead of pretending a historical source exists.
 */
export function createRequirementFunctionGroupTask(
  input: RequirementFunctionGroupVerificationInput,
): AgentTask {
  const first = input.functions[0];
  if (!first) throw new Error("Requirement function-group verification requires at least one function.");
  return {
    subject: {
      // AgentTask keeps a subject for shared host bookkeeping. This synthetic
      // value is never exposed as historical evidence or offered to a source
      // reading tool.
      sourceFunction: first.target,
      targetFunction: first.target,
      requirement: input.requirement,
    },
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
    functionGroup: input,
    systemPrompt: [
      "You are a requirement verification agent for a group of target functions.",
      "Judge whether the target implementation satisfies the stated requirement and its existing target contracts.",
      "The listed target functions define this run's acceptance scope. The full project requirement is context, not an instruction to verify all project modules. Inspect dependencies to understand these functions, but test behavior through the listed functions; do not add independent tests of unrelated service entry points or attribute their failures to this function group. Cross-module application acceptance is performed separately after assembly.",
      "There is no historical source implementation in this mode. Do not claim translation equivalence or invent source evidence.",
      "Use only the provided target and test tools.",
      "Inspect the relevant target files before making a judgment.",
      "Before writing new tests, inspect the dedicated authorized test folder and run ALL existing tests with run_function_group_tests with paths omitted. If the folder is empty, proceed to creating tests.",
      "Establish a passing baseline: diagnose compilation and assertion failures. If source/API or declared contract changes made tests stale, rewrite the affected fixtures, imports, signatures or expectations to match the requirement and current declared contract. A valid requirement failure is a production defect: retain its assertion and report it even when that prevents a passing baseline.",
      "Use one test file for this run when possible; update existing tests instead of creating duplicate test classes. Write meaningful tests for EVERY listed upstream target function, not just a representative subset.",
      "Do not guess a test path such as tests/ or Test/. The Host will state the exact authorized test root in the task message; copy that prefix exactly.",
      "Write the smallest useful test that exercises the listed public functions. Run it immediately after writing it. If compilation fails, use the complete Host stderr to repair the same file; do not create a second test class.",
      "Use meaningful assertions for the public requirement, including its boundary conditions, invalid inputs, repeated calls and dependency failures when applicable. Assert resulting state and side effects; invoking a method alone does not establish correct behavior.",
      "Derive expected observable outcomes from the requirement and declared contracts. Use implementation details to construct fixtures, never to replace a requirement's expected outcome with the implementation's current behavior. Repair test-authoring mistakes, but retain a failing requirement assertion as evidence of a production defect.",
      "Do not impose allocation, object-identity, timing, or side-effect ordering guarantees unless the public requirement or declared contract specifies them. If an assertion is stricter than that contract or its fixture contradicts the expected scenario, correct and rerun it before classifying a production defect. Keep uncertain and test-authoring issues distinct from confirmed implementation failures.",
      "For failure paths, assert the observable result and side effects that must be blocked, preserved or compensated, including subsequent retries when the requirement permits them. If the public contract leaves an outcome undefined, report the ambiguity instead of treating an implementation-derived assertion as proof of requirement compliance.",
      "A passing test run establishes execution. If a selected requirement is contradicted or remains ambiguous, retain its failing assertion or use report_uncertain; never replace it with a normal-path test or label an ambiguous rule passed.",
      "Create tests for the target function group in authorized target test roots, run run_function_group_tests, and use the Host result as the test status.",
      "The Host records a separate result for every target function; do not infer or invent coverage values.",
      "If a module protocol is supplied, select the most important one to three related rules and exercise them through the public API. Report ambiguous when the public API cannot test a rule; ambiguous is not proof of success.",
      "When finishing, include protocolChecks with ruleId and passed, failed, ambiguous, or not-applicable. Failed or ambiguous requirement checks prevent overall verification success; use report_uncertain when passing tests leave a requirement unresolved.",
      "When ready, call finish_function_group. The Host runs ALL tests in the dedicated folder together once and collects coverage for EVERY listed target function. Every test must compile and execute without skips; preserve failing requirement assertions that demonstrate a production bug and report failure with a concrete issue. Success requires the complete current suite to pass and every listed target to execute.",
      "Submit statuses matching the Host result. If finish_function_group returns outcome='continue', read feedback, functionGroupTest and reportPaths, debug or extend the tests, then call it again. Unmet checks keep you running; a confirmed production bug may finish with failure and an issue.",
      "If the requirement cannot be verified reliably, call report_uncertain instead of guessing.",
      "A terminal tool call must be the only call in its turn.",
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
      createFinishFunctionGroupTool(),
      createReportUncertainTool(),
    ],
    terminalTools: ["finish_function_group", "report_uncertain"],
  };
}

export function createRequirementFunctionGroupStrategy(
  host: AgentHost<SingleAgentFunctionGroupHostResult>,
): FunctionGroupVerificationStrategy<FunctionGroupVerificationResult> {
  return {
    verify: async (input) =>
      toVerificationResult(await host.run(
        host.taskProtocol === "final-report"
          ? createRequirementFunctionGroupFinalReportTask(input as unknown as RequirementFunctionGroupVerificationInput)
          : createRequirementFunctionGroupTask(input as unknown as RequirementFunctionGroupVerificationInput),
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
    subject: {
      // AgentTask keeps a subject for shared host bookkeeping. This synthetic
      // value is never exposed as historical evidence or offered to a source
      // reading tool.
      sourceFunction: first.target,
      targetFunction: first.target,
      requirement: input.requirement,
    },
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
    functionGroup: input,
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
    terminalTools: [],
  };
}
