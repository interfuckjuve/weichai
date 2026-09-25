import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFinishTool } from "./finish.js";
import { createListFilesTool } from "./list-files.js";
import { createReadSourceFileTool } from "./read-source-file.js";
import { createReadTargetFileTool } from "./read-target-file.js";
import { createReportUncertainTool } from "./report-uncertain.js";
import { createRunTargetTestsTool } from "./run-target-tests.js";
import { createWriteTargetTestTool } from "./write-target-test.js";
import type {
  TargetTest,
  ToolContext,
  ToolState,
} from "./common.js";

const roots: string[] = [];

function toolContext(
  sourceProjectPath: string,
  targetProjectPath: string,
  state: ToolState = {},
  targetTest: TargetTest = { executable: process.execPath, args: ["-e", ""] },
): ToolContext {
  return {
    state,
    runtime: {
      sourceLanguage: "Python",
      targetLanguage: "Java",
      sourceProjectPath,
      targetProjectPath,
      sourcePath: "src/source.py",
      targetPath: "src/target.java",
      sourceDirectory: "src",
      targetDirectory: "src",
      testRoots: ["tests/agent"],
      testRunner: "jest",
      targetTest,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("verification host tools", () => {
  it("lists files only in strategy-authorized directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "src", "source.py"), "return 1\\n");
    await writeFile(join(root, "src", "nested", "helper.py"), "return 2\\n");
    await writeFile(join(root, "other", "hidden.py"), "return 3\\n");

    const list = createListFilesTool("list_source_files", root, ["src"]);

    expect(list.inputSchema.properties).toMatchObject({
      directory: {
        type: "string",
        description: expect.stringContaining("subdirectories"),
      },
    });
    await expect(
      list.execute(list.parse({ directory: "src/nested" })),
    ).resolves.toEqual({
      files: ["src/nested/helper.py"],
      truncated: false,
    });
    expect(() => list.parse({ directory: "other" })).toThrow(
      "not authorized",
    );
    expect(() => list.parse({ directory: "src/../other" })).toThrow(
      "safe project-relative path",
    );
    await expect(
      list.execute(list.parse({ directory: "src", maxResults: 1 })),
    ).resolves.toMatchObject({
      files: ["src/source.py"],
      truncated: true,
    });
  });

  it("reads project files and finish uses the Host test result", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await mkdir(join(targetRoot, "src"), { recursive: true });
    await writeFile(join(sourceRoot, "src/source.py"), "return 1\n");
    await writeFile(join(sourceRoot, "src/other.py"), "return 2\n");
    await writeFile(join(targetRoot, "src/target.java"), "return 1;\n");

    const context = toolContext(sourceRoot, targetRoot, {}, {
      executable: process.execPath,
      args: ["tests/agent/verification.js"],
    });
    const readSource = createReadSourceFileTool()(context);
    const readTarget = createReadTargetFileTool()(context);
    const writeTest = createWriteTargetTestTool()(context);
    const runTests = createRunTargetTestsTool()(context);
    const finish = createFinishTool()(context);

    await expect(() =>
      readSource.parse({ path: "../target/src/target.java" }),
    ).toThrow("safe project-relative path");
    await expect(
      readSource.execute(readSource.parse({ path: "src/other.py" })),
    ).resolves.toEqual({ path: "src/other.py", content: "return 2\n" });
    await expect(
      readTarget.execute(readTarget.parse({ path: "src/target.java" })),
    ).resolves.toEqual({ path: "src/target.java", content: "return 1;\n" });
    await expect(
      readTarget.execute(readTarget.parse({ path: "missing.java" })),
    ).rejects.toThrow("File does not exist");

    await writeTest.execute(
      writeTest.parse({
        path: "tests/agent/verification.js",
        content: "process.stdout.write('verified')",
      }),
    );
    await expect(
      readTarget.execute(readTarget.parse({ path: "tests/agent/verification.js" })),
    ).resolves.toEqual({
      path: "tests/agent/verification.js",
      content: "process.stdout.write('verified')",
    });
    await expect(() =>
      runTests.parse({}),
    ).toThrow("run_target_tests requires only path");
    await expect(() =>
      runTests.parse({ path: "../src/target.java" }),
    ).toThrow("safe project-relative path");

    const testResult = await runTests.execute(
      runTests.parse({ path: "tests/agent/verification.js" }),
    );
    expect(testResult).toMatchObject({
      status: "success",
      timedOut: false,
      stdout: "verified",
    });

    await expect(
      finish.execute(
        finish.parse({
          testExecutionStatus: "success",
          translationStatus: "success",
        }),
      ),
    ).resolves.toMatchObject({
      testExecutionStatus: "success",
      translationStatus: "success",
      targetTest: { status: "success", stdout: "verified" },
    });
  });

  it("allows a new test path inside a Host-configured test root", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    const context = toolContext(root, root);
    const writeTest = createWriteTargetTestTool()(context);

    await expect(
      writeTest.execute(
        writeTest.parse({ path: "src/Target.java", content: "bad" }),
      ),
    ).rejects.toThrow("outside the authorized test roots");
    await expect(
      writeTest.execute(
        writeTest.parse({
          path: "tests/agent/generated-check.js",
          content: "test",
        }),
      ),
    ).resolves.toEqual({ path: "tests/agent/generated-check.js" });
  });

  it("requires all finish statuses to match", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    const context = toolContext(root, root, {
      lastTargetTest: {
        status: "failure",
        timedOut: false,
        exitCode: 1,
        stdout: "",
        stderr: "fixture missing",
        durationMs: 4,
      },
    });
    const finish = createFinishTool()(context);
    const reportUncertain = createReportUncertainTool()(context);

    await expect(
      reportUncertain.execute(
        reportUncertain.parse({
          issue: { kind: "test", description: "The fixture is missing." },
        }),
      ),
    ).resolves.toMatchObject({
      outcome: "uncertain",
      testExecutionStatus: "failure",
      issue: { kind: "test" },
    });

    await expect(
      finish.execute(
        finish.parse({
          testExecutionStatus: "failure",
          translationStatus: "failure",
          issue: {
            kind: "translation",
            description: "The translated method returned the wrong value.",
          },
        }),
      ),
    ).resolves.toMatchObject({
      testExecutionStatus: "failure",
      translationStatus: "failure",
      issue: { kind: "translation" },
      targetTest: { status: "failure" },
    });
    await expect(
      finish.execute(
        finish.parse({
          testExecutionStatus: "failure",
          translationStatus: "success",
        }),
      ),
    ).rejects.toThrow("finish.translationStatus does not match the Host result");
    await expect(
      finish.execute(
        finish.parse({
          testExecutionStatus: "success",
          translationStatus: "success",
        }),
      ),
    ).rejects.toThrow(
      /Host target test result:.*"stderr":"fixture missing"/,
    );
  });


  it("does not allow finish before target tests run", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    const context = toolContext(root, root);
    const finish = createFinishTool()(context);

    await expect(
      finish.execute(
        finish.parse({
          testExecutionStatus: "failure",
          translationStatus: "failure",
          issue: {
            kind: "translation",
            description: "The translated method returned the wrong value.",
          },
        }),
      ),
    ).rejects.toThrow("Run run_target_tests before finish");
  });

  it("classifies a timed out test execution as failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "translation-verifier-tools-"));
    roots.push(root);
    await mkdir(join(root, "tests/agent"), { recursive: true });
    await writeFile(join(root, "tests/agent/timeout.js"), "test");
    const context = toolContext(root, root, {}, {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 10,
    });
    const runTests = createRunTargetTestsTool()(context);

    await expect(
      runTests.execute(runTests.parse({ path: "tests/agent/timeout.js" })),
    ).resolves.toMatchObject({ status: "failure", timedOut: true });
  });
});
