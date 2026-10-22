import { tool } from "langchain";
import { z } from "zod";
import { resolveTestPaths } from "../test-runner.js";
import {
  relativePath,
  type FunctionGroupTestRun,
  type HostToolFactory,
  type ToolContext,
} from "./common.js";

const runFunctionGroupTestsSchema = z.strictObject({
  paths: z.array(z.string()).min(1).optional(),
});

export type RunFunctionGroupTestsInput = z.infer<typeof runFunctionGroupTestsSchema>;

export function createRunFunctionGroupTestsTool(): HostToolFactory {
  return (context: ToolContext) => {
    const testRoots = context.runtime.testRoots.map((root) => relativePath(root, "test root"));
    if (testRoots.length === 0) {
      throw new Error("run_function_group_tests requires at least one test root.");
    }
    if (!context.functionGroupRunner) {
      throw new Error("run_function_group_tests requires a function-group test runner.");
    }

    return tool(async (input: RunFunctionGroupTestsInput): Promise<FunctionGroupTestRun> =>
      runFunctionGroupTests(context, input), {
      name: "run_function_group_tests",
      description: `Run existing ${context.runtime.targetLanguage} target test files or all tests in selected directories for the bound function group inside the dedicated authorized test folder: ${testRoots.join(", ")}. Pass the authorized folder itself or omit paths to check all existing tests before adding tests. Files need not have been created or modified during this Agent run. The Host selects the test command and coverage targets. The result includes reportPaths for fresh test and coverage reports, relative to the target project; inspect them with read_target_file. An empty list means no fresh report was found.`,
      schema: runFunctionGroupTestsSchema,
    });
  };
}

/** Shared execution path for the Agent test tool and Host revalidation. */
export async function runFunctionGroupTests(
  context: ToolContext,
  input: RunFunctionGroupTestsInput = {},
): Promise<FunctionGroupTestRun> {
  context.budget?.assertActive();
  if (!context.functionGroupRunner) throw new Error("Function-group execution requires a function-group test runner.");
  const mappings = context.runtime.functionGroup?.functions;
  if (!mappings?.length) throw new Error("Function-group execution requires at least one target function.");
  const testPaths = await resolveTestPaths(context, input.paths);
  const observation: FunctionGroupTestRun = testPaths.length > 0
    ? await context.functionGroupRunner.run(testPaths)
    : {
      status: "success", testPaths, tests: { executed: 0, passed: 0, failed: 0, skipped: 0 }, testCases: [],
      functions: mappings.map(mapping => ({
        ...("source" in mapping ? { source: { ...mapping.source } } : {}),
        target: { ...mapping.target }, status: "unverified", executed: false,
        lineCoverage: null, branchCoverage: null, reason: "not-executed",
      })),
      failures: [], stdout: "", stderr: "", exitCode: 0, reason: "not-executed",
    };
  const result: FunctionGroupTestRun = {
    ...observation,
    status: testPaths.length > 0 && observation.tests.executed === 0 ? "failure" : observation.status,
    testPaths,
    reportPaths: observation.reportPaths ?? [],
  };
  context.budget?.assertActive();
  return result;
}
