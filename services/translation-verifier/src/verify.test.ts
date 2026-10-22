import { bindTestRunner } from "./host/test-runner.js";
import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVerifier } from "./verify.js";
import type { AgentTask } from "./host/task.js";
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
const noBugResult = {
  verdict: "no-bug" as const,
  summary: "The target function passed the complete dedicated test folder.",
};

describe("createVerifier", () => {
  it("starts the selected strategy with the upstream input", async () => {
    const testInput = await createFixtureInput();
    const tasks: AgentTask[] = [];
    const verify = createVerifier({
      run: (task) => {
        tasks.push(task);
        return noBugResult;
      },
    });

    await expect(verify(testInput, "single-agent", "verify")).resolves.toEqual({
      status: "success",
    });
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.taskContext.targetFunction).toEqual(testInput.subject.targetFunction);
    expect(task.systemPrompt).toContain("translation verification agent");
    expect(task.userPrompt).toContain("src/source.py");
    expect(task.userPrompt).toContain("target_fn in src/target.py");
    expect(task.userPrompt).toContain("src/target.py");
    expect(task).not.toHaveProperty("terminalTools");
    expect(task).not.toHaveProperty("subject");
    expect(task).not.toHaveProperty("functionGroup");

    const resolvedContext = {
      runtime: {
        sourceLanguage: testInput.sourceLanguage,
        targetLanguage: testInput.targetLanguage,
        sourceProjectPath: testInput.sourceProjectPath,
        targetProjectPath: testInput.targetProjectPath,
        sourcePath: testInput.subject.sourceFunction.path,
        targetPath: testInput.subject.targetFunction.path,
        targetFunction: testInput.subject.targetFunction,
        sourceDirectory: "src",
        targetDirectory: "src",
        testRoots: ["tests"],
        testRunner: "pytest" as const,
        targetTest: { executable: "python3", args: ["-m", "pytest"] },
      },
    };
    const context = { ...resolvedContext, runner: bindTestRunner(resolvedContext) };
    const toolNames = task.tools.map((factory) => factory(context).name);
    expect(toolNames).toEqual([
      "list_source_files",
      "read_source_file",
      "list_target_files",
      "read_target_file",
      "write_target_test",
      "run_target_tests",
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
    const writeTest = task.tools[4]!(context).description;
    expect(writeTest).toContain("Python test or fixture");
    expect(writeTest).toContain("dedicated project-relative test folder: tests");
    expect(writeTest).toContain("not writable");
    expect(task.tools[5]!(context).description).toContain("fixed Host-selected pytest");
    for (const factory of task.tools) {
      expect(factory(context).description).not.toContain("You");
    }
  });

  it("maps an uncertain Agent result to a failed verification result", async () => {
    const testInput = await createFixtureInput();
    const verify = createVerifier({
      run: () => ({
        verdict: "uncertain" as const,
        summary: "A requirement remains unresolved.",
        issue: {
          kind: "environment" as const,
          description: "The target test environment is unavailable.",
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
  it("preserves the Host observation and issue of a reported defect", async () => {
    const targetFunction = {
      name: "target_fn", executed: true, lineCoverage: 100, branchCoverage: null,
    };
    const issue = { kind: "translation" as const, description: "The target returns a wrong value." };
    const verify = createVerifier({
      run: () => ({ verdict: "bug-found" as const, summary: "The requirement is violated.", issue, targetFunction }),
    });
    await expect(verify(input, "single-agent", "verify")).resolves.toEqual({
      status: "failure",
      issue,
      targetFunction,
    });
  });

  it("rejects an unsupported strategy", async () => {
    const verify = createVerifier({ run: () => noBugResult });

    await expect(verify(input, "black-box", "verify")).rejects.toThrow(
      "Unknown verification strategy: black-box",
    );
  });

  it("rejects prepare for the single-phase strategy", async () => {
    const verify = createVerifier({ run: () => noBugResult });

    await expect(verify(input, "single-agent", "prepare")).rejects.toThrow(
      "Verification strategy single-agent does not implement phase: prepare",
    );
  });
});
