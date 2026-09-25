import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  assertTestPath,
  MAX_TEST_OUTPUT_CHARS,
  relativePath,
  resolveSafePath,
  type HostTool,
  type HostToolFactory,
  type TestRunner,
  type ToolContext,
  type TargetTestResult,
} from "./common.js";

export type RunTargetTestsInput = {
  path: string;
};

function parseRunTargetTestsInput(value: unknown): RunTargetTestsInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("path" in value)
  ) {
    throw new Error("run_target_tests requires only path.");
  }
  return {
    path: relativePath((value as { path: unknown }).path, "test path"),
  };
}

function rootsDescription(testRoots: readonly string[]): string {
  return testRoots.length > 0 ? testRoots.join(", ") : "(none)";
}

export function createRunTargetTestsTool(): HostToolFactory {
  return (context: ToolContext): HostTool<RunTargetTestsInput, TargetTestResult> => {
    const testRoots = context.runtime.testRoots.map((root) =>
      relativePath(root, "test root"),
    );
    if (testRoots.length === 0) {
      throw new Error("run_target_tests requires at least one test root.");
    }

    return {
      name: "run_target_tests",
      description: `Run one ${context.runtime.targetLanguage} target test under these project-relative test roots: ${rootsDescription(testRoots)}. Use the fixed Host-selected ${context.runtime.testRunner} command and its output as verification evidence.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      parse: parseRunTargetTestsInput,
      async execute(input) {
        context.budget?.assertActive();
        const result = await runTargetTests(context, testRoots, input.path);
        context.budget?.assertActive();
        context.state.lastTargetTest = result;
        return result;
      },
    };
  };
}

async function runTargetTests(
  context: ToolContext,
  testRoots: readonly string[],
  testPath: string,
): Promise<TargetTestResult> {
  assertTestPath(testPath, testRoots);
  const absoluteTestPath = resolveSafePath(
    context.runtime.targetProjectPath,
    testPath,
  );
  let testStat: Awaited<ReturnType<typeof stat>>;
  try {
    testStat = await stat(absoluteTestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Test file does not exist: ${testPath}`);
    }
    throw error;
  }
  if (!testStat.isFile()) {
    throw new Error(`Test path is not a file: ${testPath}`);
  }

  const testArgs = testFileArgs(testPath, context.runtime.testRunner);
  const args = [...context.runtime.targetTest.args, ...testArgs];
  const timeoutMs = Math.min(
    context.runtime.targetTest.timeoutMs ?? 300_000,
    context.budget?.remainingMs() ?? Number.POSITIVE_INFINITY,
  );
  if (
    !context.runtime.targetTest.executable ||
    context.runtime.targetTest.executable.includes("\0") ||
    args.some((arg) => arg.includes("\0")) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("Host target test command is invalid.");
  }

  const startedAt = Date.now();
  const result = await new Promise<{
    exitCode: number | null;
    signal?: string;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve) => {
    const child = spawn(context.runtime.targetTest.executable, args, {
      cwd: context.runtime.targetProjectPath,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      return next.length <= MAX_TEST_OUTPUT_CHARS
        ? next
        : next.slice(0, MAX_TEST_OUTPUT_CHARS);
    };
    const finish = (value: { exitCode: number | null; signal?: string }) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ ...value, stdout, stderr, timedOut });
    };

    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      stderr = append(stderr, error.message);
      finish({ exitCode: null });
    });
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal: signal ?? undefined });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
  });

  return {
    status: result.timedOut || result.exitCode !== 0 ? "failure" : "success",
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt,
  };
}

function testFileArgs(path: string, runner: TestRunner): string[] {
  if (runner === "pytest" || runner === "jest" || runner === "vitest") {
    return [path];
  }
  if (!/\.(?:java|kt)$/i.test(path)) {
    throw new Error(`Java test selector requires a .java or .kt file: ${path}`);
  }
  const className = path
    .slice(path.lastIndexOf("/") + 1)
    .replace(/\.(?:java|kt)$/i, "");
  return runner === "maven"
    ? [`-Dtest=${className}`]
    : ["--tests", `*.${className}`];
}
