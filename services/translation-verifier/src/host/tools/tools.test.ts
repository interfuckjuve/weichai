import { bindTestRunner } from "../testing/test-runner.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createListFilesTool, createListTargetFilesTool } from "./list-files.js";
import { createReadSourceFileTool } from "./read-source-file.js";
import { createReadTargetFileTool } from "./read-target-file.js";
import { createRunTargetTestsTool } from "./run-target-tests.js";
import { createWriteTargetTestTool } from "./write-target-test.js";
import { revalidateTargetReport } from "../verification/revalidation.js";
import type {
  TargetTest,
  TargetTestResult,
  ToolContext,
} from "./common.js";

const roots: string[] = [];

function toolContext(
  sourceProjectPath: string,
  targetProjectPath: string,
  targetTest: TargetTest = { executable: process.execPath, args: ["-e", ""] },
): ToolContext {
  const context = {
    runtime: {
      sourceLanguage: "Python",
      targetLanguage: "Java",
      sourceProjectPath,
      targetProjectPath,
      sourcePath: "src/source.py",
      targetPath: "src/target.java",
      targetFunction: { path: "src/target.java", name: "target_fn" },
      sourceDirectory: "src",
      targetDirectory: "src",
      testRoots: ["tests/agent"],
      testRunner: "jest" as const,
      targetTest,
    },
  };
  return { ...context, runner: bindTestRunner(context) };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("verification host tools", () => {
  it("discovers target dependencies across sibling directories without listing caches or journals", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-list-dependencies-"));
    roots.push(root);
    for (const [path, content] of Object.entries({
      "src/Application/Service.cs": "class Service {}",
      "src/Application/Product.csproj": "<Project />",
      "src/Domain/Model.cs": "class Model {}",
      "src/Application/obj/generated.cs": "generated",
      ".forexplore/workspace-translations/run.json": "private journal",
      "node_modules/vendor/index.js": "dependency cache",
      "bin/cli.js": "production CLI entry",
      ".translation-verifier-tests/run/tests/ServiceTests.cs": "generated tests",
    })) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const context = toolContext(root, root);
    context.runtime.targetDirectory = "src/Application";
    context.runtime.targetPath = "src/Application/Service.cs";
    const list = createListTargetFilesTool()(context);
    const result = await list.invoke({ directory: "." }) as { files: string[] };
    expect(result.files.sort()).toEqual(["bin/cli.js", "src/Application/Product.csproj", "src/Application/Service.cs", "src/Domain/Model.cs"]);
    expect((await list.invoke({ directory: "src/Domain/" }) as { files: string[] }).files).toEqual(["src/Domain/Model.cs"]);
    expect((await list.invoke({ directory: ".translation-verifier-tests/run/tests" }) as { files: string[] }).files)
      .toEqual([".translation-verifier-tests/run/tests/ServiceTests.cs"]);
    await expect(list.invoke({ directory: "../other" })).rejects.toThrow("safe project-relative path");
  });
  it("executes an injected runner without selecting a language or framework", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-bound-runner-"));
    roots.push(root);
    await mkdir(join(root, "tests/agent"), { recursive: true });
    await writeFile(join(root, "tests/agent/example.custom"), "test");
    await mkdir(join(root, "TestResults"));
    await writeFile(join(root, "TestResults/tests.trx"), "test report");
    const context = toolContext(root, root);
    const calls: string[] = [];
    context.runner = {
      async run(path) {
        calls.push(path);
        return {
          status: "success", timedOut: false, exitCode: 0, stdout: "bound runner", stderr: "", durationMs: 1,
          tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
          reportPaths: ["TestResults/tests.trx"],
          coverage: { status: "available", targetFunction: { name: "target_fn", executed: true, lineCoverage: 100, branchCoverage: null } },
        };
      },
    };
    const result = await createRunTargetTestsTool()(context).invoke({ path: "tests/agent/example.custom" }) as TargetTestResult;
    expect(calls).toEqual(["tests/agent/example.custom"]);
    expect(result).toMatchObject({ status: "success", stdout: "bound runner", tests: { executed: 1 }, coverage: { status: "available" } });
    expect(result.reportPaths).toEqual(["TestResults/tests.trx"]);
    const reader = createReadTargetFileTool()(context);
    expect(await reader.invoke({ path: result.reportPaths![0] }))
      .toEqual({ path: "TestResults/tests.trx", content: "test report" });
  });

  it("lists files only in strategy-authorized directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "src", "source.py"), "return 1\\n");
    await writeFile(join(root, "src", "nested", "helper.py"), "return 2\\n");
    await writeFile(join(root, "other", "hidden.py"), "return 3\\n");

    const list = createListFilesTool("list_source_files", root, ["src"]);

    // The native tool exposes its own schema to the framework.
    expect(list.name).toBe("list_source_files");
    expect(list.description).toContain("src");
    // Zod rejects structural input before the Host authorization runs.
    await expect(list.invoke({ directory: 42 } as never)).rejects.toThrow();
    await expect(list.invoke({ directory: "src", unexpected: true } as never)).rejects.toThrow();
    await expect(list.invoke({ directory: "src", maxResults: 0 })).rejects.toThrow();
    await expect(
      list.invoke({ directory: "src/nested" }),
    ).resolves.toEqual({
      files: ["src/nested/helper.py"],
      truncated: false,
    });
    await expect(list.invoke({ directory: "other" })).rejects.toThrow(
      "not authorized",
    );
    await expect(list.invoke({ directory: "src/../other" })).rejects.toThrow(
      "safe project-relative path",
    );
    await expect(
      list.invoke({ directory: "src", maxResults: 1 }),
    ).resolves.toMatchObject({
      files: ["src/source.py"],
      truncated: true,
    });
  });

  it("does not accept a passing process without test and coverage evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await mkdir(join(targetRoot, "src"), { recursive: true });
    await writeFile(join(sourceRoot, "src/source.py"), "return 1\n");
    await writeFile(join(sourceRoot, "src/other.py"), "return 2\n");
    await writeFile(join(targetRoot, "src/target.java"), "return 1;\n");

    const context = toolContext(sourceRoot, targetRoot, {
      executable: process.execPath,
      args: ["tests/agent/verification.js"],
    });
    const readSource = createReadSourceFileTool()(context);
    const readTarget = createReadTargetFileTool()(context);
    const writeTest = createWriteTargetTestTool()(context);
    const runTests = createRunTargetTestsTool()(context);

    await expect(readSource.invoke({ path: "../target/src/target.java" }))
      .rejects.toThrow("safe project-relative path");
    await expect(
      readSource.invoke({ path: "src/other.py" }),
    ).resolves.toEqual({ path: "src/other.py", content: "return 2\n" });
    await expect(
      readTarget.invoke({ path: "src/target.java" }),
    ).resolves.toEqual({ path: "src/target.java", content: "return 1;\n" });
    await expect(
      readTarget.invoke({ path: "missing.java" }),
    ).rejects.toThrow("File does not exist");

    await writeTest.invoke({
      path: "tests/agent/verification.js",
      content: "process.stdout.write('verified')",
    });
    await expect(
      readTarget.invoke({ path: "tests/agent/verification.js" }),
    ).resolves.toEqual({
      path: "tests/agent/verification.js",
      content: "process.stdout.write('verified')",
    });
    // The schema rejects a fixed-command override and a non-string path.
    await expect(runTests.invoke({ command: "arbitrary" } as never)).rejects.toThrow();
    await expect(runTests.invoke({ path: 42 } as never)).rejects.toThrow();
    await expect(runTests.invoke({ path: "../src/target.java" }))
      .rejects.toThrow("safe project-relative path");

    const testResult = await runTests.invoke({ path: "tests/agent/verification.js" }) as TargetTestResult;
    expect(testResult).toMatchObject({
      status: "success",
      timedOut: false,
      stdout: "verified",
    });

    const revalidation = await revalidateTargetReport(context, {
      verdict: "no-bug",
      summary: "The target function is verified.",
    });
    expect(revalidation.feedback.join("\n")).toContain("complete test folder must compile and execute");
    expect(revalidation.observation.tests?.executed).toBe(0);
  });

  it("accepts Host function coverage without enforcing a percentage threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-")); roots.push(root);
    await mkdir(join(root, "tests/agent"), { recursive: true });
    await writeFile(join(root, "tests/agent/coverage.test.js"), "test");
    const targetFunction = { name: "target_fn", executed: true, lineCoverage: 25, branchCoverage: null };
    const observation: TargetTestResult = {
      status: "success", timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1,
      tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
      coverage: { status: "available", targetFunction },
    };
    const noBug = { verdict: "no-bug" as const, summary: "The target function is verified." };
    const context = toolContext(root, root);
    context.runner = { run: async () => ({ ...observation }) };
    const accepted = await revalidateTargetReport(context, noBug);
    expect(accepted.feedback).toEqual([]);
    expect(accepted.observation.coverage).toEqual({ status: "available", targetFunction });
    context.runner = { run: async () => ({
      ...observation,
      coverage: { status: "available" as const, targetFunction: { ...targetFunction, executed: false } },
    }) };
    expect((await revalidateTargetReport(context, noBug)).feedback.join("\n"))
      .toContain("must execute the requested target function");
    context.runner = { run: async () => ({
      ...observation,
      coverage: { status: "unavailable" as const, reason: "report missing" },
    }) };
    const unavailable = await revalidateTargetReport(context, noBug);
    expect(unavailable.feedback.join("\n")).toContain("must execute the requested target function");
    expect(unavailable.observation.coverage).toEqual({ status: "unavailable", reason: "report missing" });
    context.runner = { run: async () => ({ ...observation, tests: { executed: 0, passed: 0, failed: 0, skipped: 1 } }) };
    expect((await revalidateTargetReport(context, noBug)).feedback.join("\n"))
      .toContain("complete test folder must compile and execute");
    context.runner = { run: async () => ({ ...observation, tests: { executed: 1, passed: 1, failed: 0, skipped: 1 } }) };
    expect((await revalidateTargetReport(context, noBug)).feedback.join("\n"))
      .toContain("without skipped tests");
  });

  it("rejects an unknown test path before the runner starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-")); roots.push(root);
    const context = toolContext(root, root);
    const calls: string[] = [];
    context.runner = {
      run: async path => {
        calls.push(path);
        return { status: "success", timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      },
    };
    const run = createRunTargetTestsTool()(context);
    await expect(run.invoke({ path: "tests/agent/missing.js" })).rejects.toThrow("does not exist");
    expect(calls).toEqual([]);
  });

  it("allows a new test path inside a Host-configured test root", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    const context = toolContext(root, root);
    const writeTest = createWriteTargetTestTool()(context);

    await expect(
      writeTest.invoke({ path: "src/Target.java", content: "bad" }),
    ).rejects.toThrow("outside the authorized test roots");
    await expect(
      writeTest.invoke({
        path: "tests/agent/generated-check.js",
        content: "test",
      }),
    ).resolves.toEqual({ path: "tests/agent/generated-check.js" });
  });

  it("edits and runs pre-existing tests only inside the dedicated folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-test-scope-"));
    roots.push(root);
    await mkdir(join(root, "tests/translation-verifier/nested"), { recursive: true });
    await writeFile(join(root, "tests/translation-verifier/nested/existing.test.js"), "original");
    await writeFile(join(root, "tests/existing.test.js"), "outside");
    const context = toolContext(root, root);
    context.runtime.testRoots = ["tests/translation-verifier"];
    const calls: string[] = [];
    context.runner = { run: async path => {
      calls.push(path);
      return { status: "success", timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
    } };
    const run = createRunTargetTestsTool()(context);
    const write = createWriteTargetTestTool()(context);
    const path = "tests/translation-verifier/nested/existing.test.js";
    await run.invoke({ path });
    await write.invoke({ path, content: "updated" });
    const read = createReadTargetFileTool()(context);
    expect(await read.invoke({ path })).toEqual({ path, content: "updated" });
    await run.invoke({ path });
    expect(calls).toEqual([path, path]);
    for (const outside of ["tests/existing.test.js", "tests/translation-verifier-other/test.js", "src/Target.java"]) {
      await expect(write.invoke({ path: outside, content: "bad" })).rejects.toThrow("outside the authorized test roots");
      await expect(run.invoke({ path: outside })).rejects.toThrow("outside the authorized test roots");
    }
    expect(calls).toEqual([path, path]);
    expect((await read.invoke({ path: "tests/existing.test.js" }) as { content: string }).content).toBe("outside");
  });

  it("allows an empty first baseline before the dedicated folder has been created", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-empty-baseline-"));
    roots.push(root);
    const context = toolContext(root, root);
    context.runner = { run: async () => { throw new Error("No tests should execute."); } };
    await expect(createRunTargetTestsTool()(context).invoke({ path: "tests/agent" }))
      .resolves.toMatchObject({ status: "success", tests: { executed: 0 }, reportPaths: [] });
  });

  it("runs all existing tests in an authorized directory and rejects parent or sibling directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-test-directory-"));
    roots.push(root);
    await mkdir(join(root, "tests/agent/nested"), { recursive: true });
    await mkdir(join(root, "tests/agent-other"), { recursive: true });
    await writeFile(join(root, "tests/agent/first.test.js"), "test");
    await writeFile(join(root, "tests/agent/nested/second.test.js"), "test");
    await writeFile(join(root, "tests/agent/nested/fixture.txt"), "fixture");
    await writeFile(join(root, "tests/agent-other/outside.test.js"), "test");
    const context = toolContext(root, root);
    const calls: string[] = [];
    context.runner = {
      run: async () => { throw new Error("Expected the complete suite runner."); },
      runSuite: async paths => {
        calls.push(...paths);
        return {
          status: "success", timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1,
          tests: { executed: paths.length, passed: paths.length, failed: 0, skipped: 0 },
          coverage: { status: "available", targetFunction: { name: "target_fn", executed: true, lineCoverage: 100, branchCoverage: null } },
        };
      },
    };
    const tool = createRunTargetTestsTool()(context);
    const result = await tool.invoke({ path: "tests/agent" }) as TargetTestResult;
    expect(calls).toEqual(["tests/agent/first.test.js", "tests/agent/nested/second.test.js"]);
    expect(result.tests).toEqual({ executed: 2, passed: 2, failed: 0, skipped: 0 });
    calls.length = 0;
    await tool.invoke({});
    expect(calls).toEqual(["tests/agent/first.test.js", "tests/agent/nested/second.test.js"]);
    calls.length = 0;
    await tool.invoke({ path: "tests/agent/nested" });
    expect(calls).toEqual(["tests/agent/nested/second.test.js"]);
    calls.length = 0;
    for (const path of ["tests", "tests/agent-other"]) {
      await expect(tool.invoke({ path })).rejects.toThrow("outside the authorized test roots");
    }
    expect(calls).toEqual([]);
  });

  it("reruns the complete current suite during revalidation instead of accepting an earlier passing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-finish-suite-"));
    roots.push(root);
    await mkdir(join(root, "tests/agent"), { recursive: true });
    await writeFile(join(root, "tests/agent/passing.test.js"), "test");
    const context = toolContext(root, root);
    const calls: string[] = [];
    const runSuite: NonNullable<ToolContext["runner"]["runSuite"]> = async paths => {
      calls.push(...paths);
      const failed = paths.some(path => path.endsWith("regression.test.js"));
      return {
        status: failed ? "failure" : "success", timedOut: false, exitCode: failed ? 1 : 0,
        stdout: "", stderr: failed ? "assertion failed" : "", durationMs: 1,
        tests: { executed: paths.length, passed: paths.length - (failed ? 1 : 0), failed: failed ? 1 : 0, skipped: 0 },
        coverage: { status: "available", targetFunction: { name: "target_fn", executed: true, lineCoverage: 100, branchCoverage: null } },
      };
    };
    context.runner = { run: path => runSuite([path]), runSuite };
    await createRunTargetTestsTool()(context).invoke({ path: "tests/agent/passing.test.js" });
    await writeFile(join(root, "tests/agent/regression.test.js"), "test");
    calls.length = 0;
    const rejected = await revalidateTargetReport(context, {
      verdict: "no-bug",
      summary: "The target function is verified.",
    });
    expect(rejected.feedback.join("\n")).toContain("requires every test in the dedicated folder to pass");
    expect(rejected.observation).toMatchObject({ status: "failure", tests: { executed: 2, failed: 1 } });
    expect(calls).toEqual(["tests/agent/passing.test.js", "tests/agent/regression.test.js"]);
    const accepted = await revalidateTargetReport(context, {
      verdict: "bug-found",
      summary: "The new test exposes incorrect behavior.",
      issue: { kind: "translation", description: "The new test exposes incorrect behavior." },
      affectedTargets: [{ path: "src/target.java", name: "target_fn" }],
    });
    expect(accepted.feedback).toEqual([]);
    expect(accepted.observation).toMatchObject({ status: "failure", tests: { executed: 2, failed: 1 } });
  });

  it("rejects a defect report while a suite file cannot compile, then accepts the repaired suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-finish-compile-"));
    roots.push(root);
    await mkdir(join(root, "tests/agent"), { recursive: true });
    await writeFile(join(root, "tests/agent/broken.test.js"), "invalid test");
    const context = toolContext(root, root);
    context.runner = { run: async () => ({
      status: "failure", timedOut: false, exitCode: 1, stdout: "", stderr: "SyntaxError", durationMs: 1,
      tests: { executed: 0, passed: 0, failed: 0, skipped: 0 },
    }) };
    const defect = {
      verdict: "bug-found" as const,
      summary: "The function is incorrect.",
      issue: { kind: "translation" as const, description: "The function is incorrect." },
      affectedTargets: [{ path: "src/target.java", name: "target_fn" }],
    };
    const output = await revalidateTargetReport(context, defect);
    expect(output.feedback.join("\n")).toContain("compile and execute");
    expect(output.observation).toMatchObject({ stderr: "SyntaxError", tests: { executed: 0 } });
    await createWriteTargetTestTool()(context).invoke({ path: "tests/agent/broken.test.js", content: "test('repaired', () => {})" });
    context.runner = { run: async () => ({
      status: "success", timedOut: false, exitCode: 0, stdout: "repaired", stderr: "", durationMs: 1,
      tests: { executed: 1, passed: 1, failed: 0, skipped: 0 },
      coverage: { status: "available", targetFunction: { name: "target_fn", executed: true, lineCoverage: 100, branchCoverage: null } },
    }) };
    const repaired = await revalidateTargetReport(context, {
      verdict: "no-bug",
      summary: "The repaired suite executes the target function.",
    });
    expect(repaired.feedback).toEqual([]);
    expect(repaired.observation).toMatchObject({ status: "success", stdout: "repaired", tests: { failed: 0 } });
  });

  it("keeps a failing assertion distinct from a broken execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    await mkdir(join(root, "tests/agent"), { recursive: true });
    await writeFile(join(root, "tests/agent/failure.test.js"), "test");
    const failureObservation: TargetTestResult = {
      status: "failure",
      timedOut: false,
      exitCode: 1,
      stdout: "",
      stderr: "expected 1, received 2",
      durationMs: 4,
      tests: { executed: 1, passed: 0, failed: 1, skipped: 0 },
      coverage: { status: "available", targetFunction: { name: "target_fn", executed: true, lineCoverage: 100, branchCoverage: null } },
    };
    const defect = {
      verdict: "bug-found" as const,
      summary: "The translated method returned the wrong value.",
      issue: { kind: "translation" as const, description: "The translated method returned the wrong value." },
      affectedTargets: [{ path: "src/target.java", name: "target_fn" }],
    };
    const context = toolContext(root, root);
    context.runner = { run: async () => ({ ...failureObservation }) };
    const accepted = await revalidateTargetReport(context, defect);
    expect(accepted.feedback).toEqual([]);
    expect(accepted.observation).toMatchObject({ status: "failure", stderr: "expected 1, received 2" });
    context.runner = { run: async () => ({ ...failureObservation, executionErrors: 1 }) };
    expect((await revalidateTargetReport(context, defect)).feedback.join("\n"))
      .toContain("compile and execute");
  });

  it("rejects a no-bug report without any test in the authorized suite", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    const context = toolContext(root, root);

    const output = await revalidateTargetReport(context, {
      verdict: "no-bug",
      summary: "The target function is verified.",
    });
    expect(output.feedback.join("\n")).toContain("complete test folder must compile and execute");
    expect(output.observation.tests?.executed).toBe(0);
  });

  it("classifies a timed out test execution as failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    await mkdir(join(root, "tests/agent"), { recursive: true });
    await writeFile(join(root, "tests/agent/timeout.js"), "test");
    const context = toolContext(root, root, {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 10,
    });
    const runTests = createRunTargetTestsTool()(context);

    await expect(
      runTests.invoke({ path: "tests/agent/timeout.js" }),
    ).resolves.toMatchObject({ status: "failure", timedOut: true });
  });
});
