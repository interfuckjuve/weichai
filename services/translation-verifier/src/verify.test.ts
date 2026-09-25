import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVerifier } from "./verify.js";
import type { AgentTask } from "./host/agent.js";
import type { VerificationInput } from "./types.js";

const input: VerificationInput = {
  schemaVersion: "2.0",
  sourceLanguage: "Python",
  targetLanguage: "Java",
  sourceProjectPath: "/tmp/source",
  targetProjectPath: "/tmp/target",
  subject: {
    sourceFunction: { path: "src/source.py", name: "source_fn" },
    targetFunction: { path: "src/Target.java", name: "target_fn" },
    requirement: "Preserve the method behavior.",
  },
  analysisReport: {
    schemaVersion: "1.0",
    applicability: { level: "reference", confidence: 1, reasons: [] },
    behaviorMapping: [],
    contractMapping: [],
    dependencyPlan: [],
    implementationPlan: [],
    risks: [],
    assumptions: [],
    unresolved: [],
  },
  migrationPlan: {},
  translation: {
    round: 0,
    files: [],
  },
};

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createFixtureInput(): Promise<VerificationInput> {
  const root = await mkdtemp(join(tmpdir(), "translation-verifier-verify-"));
  fixtureRoots.push(root);
  const sourceProjectPath = join(root, "source");
  const targetProjectPath = join(root, "target");
  await mkdir(join(sourceProjectPath, "src"), { recursive: true });
  await mkdir(join(targetProjectPath, "src"), { recursive: true });
  await mkdir(join(targetProjectPath, "tests"), { recursive: true });
  await writeFile(join(targetProjectPath, "pytest.ini"), "[pytest]\ntestpaths = tests\n");
  return {
    ...input,
    targetLanguage: "Python",
    sourceProjectPath,
    targetProjectPath,
    subject: {
      sourceFunction: { path: "src/source.py", name: "source_fn" },
      targetFunction: { path: "src/target.py", name: "target_fn" },
      requirement: "Preserve the method behavior.",
    },
  };
}
const successfulHostResult = {
  testExecutionStatus: "success" as const,
  translationStatus: "success" as const,
  targetTest: {
    status: "success" as const,
    timedOut: false,
    exitCode: 0,
    stdout: "verified",
    stderr: "",
    durationMs: 1,
  },
};

describe("createVerifier", () => {
  it("starts the selected strategy with the upstream input", async () => {
    const testInput = await createFixtureInput();
    const tasks: AgentTask[] = [];
    const verify = createVerifier({
      run: (task) => {
        tasks.push(task);
        return successfulHostResult;
      },
    });

    await expect(verify(testInput, "single-agent", "verify")).resolves.toEqual({
      status: "success",
    });
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.subject).toEqual(testInput.subject);
    expect(task.systemPrompt).toContain("translation verification agent");
    expect(task.userPrompt).toContain("src/source.py");
    expect(task.userPrompt).toContain("target_fn in src/target.py");
    expect(task.userPrompt).toContain("src/target.py");
    expect(task.terminalTools).toEqual(["finish", "report_uncertain"]);

    const context = {
      state: {},
      runtime: {
        sourceLanguage: testInput.sourceLanguage,
        targetLanguage: testInput.targetLanguage,
        sourceProjectPath: testInput.sourceProjectPath,
        targetProjectPath: testInput.targetProjectPath,
        sourcePath: testInput.subject.sourceFunction.path,
        targetPath: testInput.subject.targetFunction.path,
        sourceDirectory: "src",
        targetDirectory: "src",
        testRoots: ["tests"],
        testRunner: "pytest" as const,
        targetTest: { executable: "python3", args: ["-m", "pytest"] },
      },
    };
    const toolNames = task.tools.map((factory) => factory(context).name);
    expect(toolNames).toEqual([
      "list_source_files",
      "read_source_file",
      "list_target_files",
      "read_target_file",
      "write_target_test",
      "run_target_tests",
      "finish",
      "report_uncertain",
    ]);
    const sourceList = task.tools[0]!(context);
    const targetList = task.tools[2]!(context);
    expect(sourceList.inputSchema.properties).toMatchObject({
      directory: {
        type: "string",
        description: expect.stringContaining("subdirectories"),
      },
    });
    expect(sourceList.description).toContain("Python source files");
    expect(targetList.description).toContain("Python target files");
    expect(task.tools[1]!(context).description).toContain("Python source project");
    expect(task.tools[3]!(context).description).toContain("Python target worktree");
    expect(task.tools[4]!(context).description).toContain("focused Python target test");
    expect(task.tools[5]!(context).description).toContain("fixed Host-selected pytest");
    expect(task.tools[6]!(context).description).toContain("Python to Python verification");
    for (const factory of task.tools) {
      expect(factory(context).description).not.toContain("You");
    }
  });

  it("maps an uncertain Agent result to a failed verification result", async () => {
    const testInput = await createFixtureInput();
    const verify = createVerifier({
      run: () => ({
        outcome: "uncertain" as const,
        testExecutionStatus: "failure" as const,
        issue: {
          kind: "environment" as const,
          description: "The target test environment is unavailable.",
        },
        targetTest: {
          status: "failure" as const,
          timedOut: false,
          exitCode: null,
          stdout: "",
          stderr: "missing dependency",
          durationMs: 2,
        },
      }),
    });

    await expect(verify(testInput, "single-agent", "verify")).resolves.toEqual({
      status: "failure",
      issue: {
        kind: "environment",
        description: "The target test environment is unavailable.",
      },
    });
  });
  it("rejects an unsupported strategy", async () => {
    const verify = createVerifier({ run: () => successfulHostResult });

    await expect(verify(input, "black-box", "verify")).rejects.toThrow(
      "Unknown verification strategy: black-box",
    );
  });

  it("rejects prepare for the single-phase strategy", async () => {
    const verify = createVerifier({ run: () => successfulHostResult });

    await expect(verify(input, "single-agent", "prepare")).rejects.toThrow(
      "Verification strategy single-agent does not implement phase: prepare",
    );
  });
});
