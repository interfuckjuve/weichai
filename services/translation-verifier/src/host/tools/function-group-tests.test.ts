import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunFunctionGroupTestsTool } from "./run-function-group-tests.js";
import { createReadTargetFileTool } from "./read-target-file.js";
import { createWriteTargetTestTool } from "./write-target-test.js";
import type { FunctionGroupTestRun, ToolContext } from "./common.js";

const roots: string[] = [];

const testRoot = "tests/translation-verifier";
const firstTest = `${testRoot}/test_one.py`;
const secondTest = `${testRoot}/nested/test_two.py`;
const firstTarget = { path: "src/A.py", name: "a" };
const secondTarget = { path: "src/B.py", name: "b" };

async function fixture(targets = [firstTarget]) {
  const root = await mkdtemp(join(tmpdir(), "translation-verifier-function-group-"));
  roots.push(root);
  await mkdir(join(root, testRoot, "nested"), { recursive: true });
  await writeFile(join(root, firstTest), "def test_one(): pass");
  await writeFile(join(root, secondTest), "def test_two(): pass");
  const result: FunctionGroupTestRun = {
    status: "success", testPaths: [firstTest, secondTest], reportPaths: ["tests.xml"],
    tests: { executed: 2, passed: 2, failed: 0, skipped: 0 },
    functions: targets.map(target => ({ target, status: "passed", executed: true, lineCoverage: 100, branchCoverage: null })),
    failures: [], stdout: "ok", stderr: "", exitCode: 0,
  };
  const calls: string[][] = [];
  const context: ToolContext = {
    runtime: {
      sourceLanguage: "Python", targetLanguage: "Python", sourceProjectPath: root, targetProjectPath: root,
      sourcePath: "src/a.py", targetPath: firstTarget.path, targetFunction: firstTarget,
      sourceDirectory: "src", targetDirectory: "src", testRoots: [testRoot], testRunner: "pytest",
      targetTest: { executable: "python3", args: ["-m", "pytest"] },
      functionGroup: {
        schemaVersion: "3.1", sourceLanguage: "Python", targetLanguage: "Python",
        sourceProjectPath: root, targetProjectPath: root, requirement: "Each function preserves its public behavior.",
        functions: targets.map(target => ({ source: target, target })),
      },
    },
    runner: { run: async () => { throw new Error("unused"); } },
    functionGroupRunner: { run: async paths => {
      calls.push([...paths]);
      return structuredClone({ ...result, testPaths: [...paths] });
    } },
  };
  return { root, result, context, calls };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("function-group test tool", () => {
  it("runs and updates pre-existing files inside the dedicated folder and rejects sibling tests", async () => {
    const { root, context, calls } = await fixture();
    await writeFile(join(root, "tests/outside.test.py"), "outside");
    await writeFile(join(root, "tests.xml"), "test report");
    const tool = createRunFunctionGroupTestsTool()(context);
    const paths = [firstTest, secondTest];
    const actual = await tool.invoke({ paths }) as FunctionGroupTestRun;
    expect(actual.testPaths).toEqual(paths);
    expect(actual.reportPaths).toEqual(["tests.xml"]);
    const reader = createReadTargetFileTool()(context);
    expect(await reader.invoke({ path: actual.reportPaths![0] }))
      .toEqual({ path: "tests.xml", content: "test report" });
    await createWriteTargetTestTool()(context).invoke({ path: firstTest, content: "def test_updated(): pass" });
    expect((await reader.invoke({ path: firstTest }) as { content: string }).content).toBe("def test_updated(): pass");
    await expect(tool.invoke({ paths })).resolves.toMatchObject({ testPaths: paths });
    calls.length = 0;
    await expect(tool.invoke({ paths: ["tests/outside.test.py"] })).rejects.toThrow("outside the authorized test roots");
    await expect(tool.invoke({ paths: [firstTest, "tests/outside.test.py"] })).rejects.toThrow("outside the authorized test roots");
    expect(calls).toEqual([]);
  });

  it("runs all current tests when paths are omitted", async () => {
    const { context, calls } = await fixture([firstTarget, secondTarget]);
    const tool = createRunFunctionGroupTestsTool()(context);
    // The schema rejects a fixed-command override or an empty selection.
    await expect(tool.invoke({ command: "arbitrary" } as never)).rejects.toThrow();
    await expect(tool.invoke({ paths: [] })).rejects.toThrow();
    await expect(tool.invoke({})).resolves.toMatchObject({ testPaths: [secondTest, firstTest] });
    expect(calls).toEqual([[secondTest, firstTest]]);
  });

  it("allows an empty first baseline without invoking the runner", async () => {
    const { root, context, calls } = await fixture();
    await rm(join(root, testRoot), { recursive: true });
    await expect(createRunFunctionGroupTestsTool()(context).invoke({ paths: [testRoot] }))
      .resolves.toMatchObject({ status: "success", tests: { executed: 0 }, testPaths: [], reportPaths: [] });
    expect(calls).toEqual([]);
  });

  it("expands authorized directories, deduplicates overlapping selections, and rejects outside directories before execution", async () => {
    const { root, context, calls } = await fixture();
    await writeFile(join(root, testRoot, "nested/fixture.txt"), "fixture");
    await mkdir(join(root, "tests/translation-verifier-other"));
    const tool = createRunFunctionGroupTestsTool()(context);
    const result = await tool.invoke({ paths: [testRoot, firstTest, `${testRoot}/nested`] }) as FunctionGroupTestRun;
    expect(result.testPaths).toEqual([secondTest, firstTest]);
    expect(calls).toEqual([[secondTest, firstTest]]);
    calls.length = 0;
    await tool.invoke({ paths: [`${testRoot}/nested`] });
    expect(calls).toEqual([[secondTest]]);
    calls.length = 0;
    for (const outside of ["tests", "tests/translation-verifier-other"]) {
      await expect(tool.invoke({ paths: [testRoot, outside] })).rejects.toThrow("outside the authorized test roots");
    }
    expect(calls).toEqual([]);
  });
});
