import { tool } from "langchain";
import { z } from "zod";
import { resolveTestPaths } from "../testing/test-runner.js";
import {
  relativePath,
  type HostToolFactory,
  type ToolContext,
  type TargetTestResult,
} from "./common.js";

const runTargetTestsSchema = z.strictObject({
  path: z.string().optional(),
});

export type RunTargetTestsInput = z.infer<typeof runTargetTestsSchema>;

function rootsDescription(testRoots: readonly string[]): string {
  return testRoots.length > 0 ? testRoots.join(", ") : "(none)";
}

export function createRunTargetTestsTool(): HostToolFactory {
  return (context: ToolContext) => {
    const testRoots = context.runtime.testRoots.map((root) =>
      relativePath(root, "test root"),
    );
    if (testRoots.length === 0) {
      throw new Error("run_target_tests requires at least one test root.");
    }

    return tool(async (input: RunTargetTestsInput): Promise<TargetTestResult> =>
      runTargetTests(context, input), {
      name: "run_target_tests",
      description: `Run an existing ${context.runtime.targetLanguage} target test file or every test in a directory inside this dedicated project-relative test folder: ${rootsDescription(testRoots)}. Pass the authorized folder itself or omit path to check all existing tests before adding tests. Files need not have been created or modified during this Agent run. Use the fixed Host-selected ${context.runtime.testRunner} command and its output as verification evidence. The result includes reportPaths for fresh test and coverage reports, relative to the target project; inspect them with read_target_file. An empty list means no fresh report was found.`,
      schema: runTargetTestsSchema,
    });
  };
}

/** Shared execution path for the Agent test tool and Host revalidation. */
export async function runTargetTests(
  context: ToolContext,
  input: RunTargetTestsInput = {},
): Promise<TargetTestResult> {
  context.budget?.assertActive();
  const testPaths = await resolveTestPaths(context, input.path === undefined ? undefined : [input.path]);
  const singleFile = input.path !== undefined && testPaths.length === 1 && testPaths[0] === input.path;
  let observation: TargetTestResult;
  if (testPaths.length === 0) {
    observation = {
      status: "success", timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 0,
      tests: { executed: 0, passed: 0, failed: 0, skipped: 0 }, testCases: [],
      coverage: { status: "unavailable", reason: "The dedicated test folder contains no executable test files." },
    };
  } else if (singleFile) {
    observation = await context.runner.run(testPaths[0]!);
  } else if (context.runner.runSuite) {
    observation = await context.runner.runSuite(testPaths);
  } else if (testPaths.length === 1) {
    observation = await context.runner.run(testPaths[0]!);
  } else {
    throw new Error("The bound test runner must support runSuite to execute every test in the dedicated folder together.");
  }
  const result: TargetTestResult = {
    ...observation,
    status: !singleFile && testPaths.length > 0 && (observation.tests?.executed ?? 0) === 0 ? "failure" : observation.status,
    testPaths,
    reportPaths: observation.reportPaths ?? [],
  };
  context.budget?.assertActive();
  return result;
}
