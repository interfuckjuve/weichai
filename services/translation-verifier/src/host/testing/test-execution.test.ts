import { link, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTestPaths } from "./test-runner.js";
import { runFunctionGroupTests } from "../tools/run-function-group-tests.js";
import { runTargetTests } from "../tools/run-target-tests.js";
import type { FunctionGroupTestRun, TargetTestResult, TestRunner, ToolContext } from "../tools/common.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(runner: TestRunner = "jest"): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), "translation-verifier-suite-"));
  roots.push(root);
  await mkdir(join(root, "tests/translation-verifier"), { recursive: true });
  const target = { path: "src/target.ts", name: "run" };
  const result: TargetTestResult = {
    status: "success", timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1,
    tests: { executed: 2, passed: 2, failed: 0, skipped: 0 },
    coverage: { status: "available", targetFunction: { name: "run", executed: true, lineCoverage: 100, branchCoverage: null } },
  };
  return {
    runtime: {
      sourceLanguage: "TypeScript", targetLanguage: "TypeScript", sourceProjectPath: root, targetProjectPath: root,
      sourcePath: target.path, targetPath: target.path, targetFunction: target,
      sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests/translation-verifier"],
      testRunner: runner, targetTest: { executable: "unused", args: [] },
      functionGroup: {
        schemaVersion: "3.1", mode: "requirement", sourceLanguage: "TypeScript", targetLanguage: "TypeScript",
        targetProjectPath: root, requirement: "Run both functions", functions: [{ target }, { target: { ...target, name: "stop" } }],
      },
    },
    runner: { run: vi.fn(async () => structuredClone(result)), runSuite: vi.fn(async () => structuredClone(result)) },
  };
}

async function file(context: ToolContext, path: string, content = ""): Promise<void> {
  const absolute = join(context.runtime.targetProjectPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function groupResult(context: ToolContext): FunctionGroupTestRun {
  return {
    status: "success", testPaths: [], tests: { executed: 2, passed: 2, failed: 0, skipped: 0 },
    functions: context.runtime.functionGroup!.functions.map(mapping => ({
      target: { ...mapping.target }, status: "passed", executed: true, lineCoverage: 100, branchCoverage: null,
    })),
    testCases: [{ id: "suite#run", status: "passed" }, { id: "suite#stop", status: "passed" }],
    failures: [], stdout: "", stderr: "", exitCode: 0,
  };
}

describe("shared test execution", () => {
  it("discovers retained and nested tests but excludes adjacent tests and fixtures", async () => {
    const context = await fixture();
    await file(context, "tests/translation-verifier/retained.test.ts");
    await file(context, "tests/translation-verifier/nested/new.spec.ts");
    await file(context, "tests/translation-verifier/helper.ts");
    await file(context, "tests/translation-verifier/model.d.ts");
    await file(context, "tests/outside.test.ts");
    expect(await resolveTestPaths(context)).toEqual([
      "tests/translation-verifier/nested/new.spec.ts", "tests/translation-verifier/retained.test.ts",
    ]);
    expect(await resolveTestPaths(context, ["tests/translation-verifier/nested"])).toEqual([
      "tests/translation-verifier/nested/new.spec.ts",
    ]);
    await expect(resolveTestPaths(context, ["tests"])).rejects.toThrow("outside the authorized");
    await expect(resolveTestPaths(context, ["tests/translation-verifier/retained.test.ts"]))
      .resolves.toEqual(["tests/translation-verifier/retained.test.ts"]);
  });

  it.each([
    ["pytest", "test_existing.py", "", "fixture.py", ""],
    ["maven", "Behavior.java", "class Behavior { @org.junit.jupiter.api.Test void check() {} }", "Fixture.java", "interface Fixture {}"],
    ["gradle", "Behavior.kt", "class Behavior { @Test fun check() {} }", "Fixture.kt", "interface Fixture {}"],
    ["dotnet", "Behavior.cs", "class Behavior { [Xunit.Fact] public void Check() {} }", "Fixture.cs", "interface Fixture {}"],
    ["dotnet", "Inherited.cs", "class InheritedTests : BaseTests {}", "Fixture.cs", "class Fixture {}"],
    ["vitest", "existing.spec.mts", "", "fixture.ts", ""],
    ["jest", "__tests__/behavior.ts", "", "fixture.ts", ""],
  ] as const)("recognizes %s tests using framework conventions or annotations", async (runner, name, source, helper, helperSource) => {
    const context = await fixture(runner);
    const path = `tests/translation-verifier/${name}`;
    await file(context, path, source);
    await file(context, `tests/translation-verifier/${helper}`, helperSource);
    expect(await resolveTestPaths(context)).toEqual([path]);
  });

  it.each(["symbolic", "hard"] as const)("rejects %s links even for fixture files", async kind => {
    const context = await fixture();
    const root = context.runtime.targetProjectPath;
    await file(context, "external.ts", "fixture");
    const linked = join(root, "tests/translation-verifier/helper.ts");
    if (kind === "symbolic") await symlink(join(root, "external.ts"), linked);
    else await link(join(root, "external.ts"), linked);
    await expect(resolveTestPaths(context)).rejects.toThrow(/Linked|Hard-linked/);
  });

  it("runs every current file together and replaces stale single-test evidence", async () => {
    const context = await fixture();
    await file(context, "tests/translation-verifier/old.test.ts");
    await file(context, "tests/translation-verifier/new.test.ts");
    const result = await runTargetTests(context);
    expect(context.runner.runSuite).toHaveBeenCalledOnce();
    expect(context.runner.runSuite).toHaveBeenCalledWith([
      "tests/translation-verifier/new.test.ts", "tests/translation-verifier/old.test.ts",
    ]);
    expect(context.runner.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "success", reportPaths: [] });
  });

  it("fails safely when an injected runner cannot run multiple files together", async () => {
    const context = await fixture();
    await file(context, "tests/translation-verifier/one.test.ts");
    await file(context, "tests/translation-verifier/two.test.ts");
    delete context.runner.runSuite;
    await expect(runTargetTests(context)).rejects.toThrow("must support runSuite");
    expect(context.runner.run).not.toHaveBeenCalled();
  });

  it("retains only the latest complete group suite result without writing an archive", async () => {
    const context = await fixture();
    await file(context, "tests/translation-verifier/old.test.ts", "old test");
    await file(context, "tests/translation-verifier/nested/new.test.ts", "new test");
    const observation = {
      ...groupResult(context),
      status: "failure" as const,
      tests: { executed: 2, passed: 1, failed: 1, skipped: 0 },
      testCases: [{ id: "suite#run", status: "failed" as const, message: "Expected rejection" }],
      reportPaths: ["tests.json"],
      failures: [{ message: "Expected rejection", testPath: "tests/translation-verifier/old.test.ts", suspectedFunctions: [{ path: "src/target.ts", name: "run" }] }],
      exitCode: 1,
    };
    context.functionGroupRunner = { run: vi.fn(async () => observation) };
    const result = await runFunctionGroupTests(context);
    expect(context.functionGroupRunner.run).toHaveBeenCalledOnce();
    expect(context.functionGroupRunner.run).toHaveBeenCalledWith([
      "tests/translation-verifier/nested/new.test.ts", "tests/translation-verifier/old.test.ts",
    ]);
    expect(result.functions.map(item => item.target.name)).toEqual(["run", "stop"]);
    expect(result).toMatchObject({ status: "failure", tests: observation.tests, testCases: observation.testCases, reportPaths: ["tests.json"] });
    expect(result.failures).toEqual(observation.failures);
    expect(result).not.toHaveProperty("testEvidence");
    expect(await readdir(context.runtime.targetProjectPath)).toEqual(["tests"]);
  });

  it("leaves no stored observation when suite execution cannot complete", async () => {
    const context = await fixture();
    await file(context, "tests/translation-verifier/existing.test.ts");
    context.functionGroupRunner = { run: vi.fn(async () => { throw new Error("runner unavailable"); }) };
    await expect(runFunctionGroupTests(context)).rejects.toThrow("runner unavailable");
    expect(await readdir(context.runtime.targetProjectPath)).toEqual(["tests"]);
  });

  it("accepts an empty baseline without starting either runner", async () => {
    const context = await fixture();
    context.functionGroupRunner = { run: vi.fn(async () => groupResult(context)) };
    expect(await runTargetTests(context)).toMatchObject({ status: "success", tests: { executed: 0, skipped: 0 }, reportPaths: [] });
    const group = await runFunctionGroupTests(context);
    expect(group).toMatchObject({ status: "success", tests: { executed: 0, skipped: 0 }, reportPaths: [] });
    expect(group.functions.every(item => !item.executed && item.status === "unverified")).toBe(true);
    expect(context.runner.runSuite).not.toHaveBeenCalled();
    expect(context.functionGroupRunner.run).not.toHaveBeenCalled();
  });

  it("does not accept an all-skipped suite as a successful baseline", async () => {
    const context = await fixture();
    await file(context, "tests/translation-verifier/skipped.test.ts");
    context.runner.runSuite = async () => ({
      status: "success", timedOut: false, exitCode: 0, stdout: "", stderr: "", durationMs: 1,
      tests: { executed: 0, passed: 0, failed: 0, skipped: 2 },
    });
    context.functionGroupRunner = { run: async () => ({ ...groupResult(context), tests: { executed: 0, passed: 0, failed: 0, skipped: 2 } }) };
    expect((await runTargetTests(context)).status).toBe("failure");
    expect((await runFunctionGroupTests(context)).status).toBe("failure");
  });
});
