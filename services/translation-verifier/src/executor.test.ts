import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TestDescription, VerifierLanguage } from "./description.js";
import { generateDriverSource } from "./driver/driver-codegen.js";
import {
  FakeDriverExecutor,
  isToolchainAvailable,
  RealDriverExecutor,
  type CompileOutcome,
  type RunOutcome,
  type SideSpec,
} from "./executor.js";

const javaDescription: TestDescription = {
  schemaVersion: "1.0",
  target: { language: "Java", className: "Hello", method: "greet", isStatic: true, constructorArgs: [] },
  cases: [
    {
      id: "c1",
      inputs: [{ type: "string", value: "pi" }],
      expected: { kind: "return", value: { type: "string", value: "hi pi" } },
    },
  ],
};

const csharpDescription: TestDescription = {
  schemaVersion: "1.0",
  target: { language: "C#", className: "Util", method: "DoubleIt", isStatic: true, constructorArgs: [] },
  cases: [
    {
      id: "c1",
      inputs: [{ type: "string", value: "ab" }],
      expected: { kind: "return", value: { type: "string", value: "abab" } },
    },
  ],
};

function makeSide(
  language: VerifierLanguage,
  driverSource: string,
  sourceFiles: SideSpec["sourceFiles"],
): SideSpec {
  return { language, driverSource, sourceFiles };
}

function javaSide(): SideSpec {
  return makeSide("Java", generateDriverSource(javaDescription), [
    {
      relativePath: "Hello.java",
      content: 'public class Hello { public static String greet(String name){ return "hi " + name; } }',
    },
  ]);
}

function csharpSide(): SideSpec {
  return makeSide("C#", generateDriverSource(csharpDescription), [
    { relativePath: "Util.cs", content: "public static class Util { public static string DoubleIt(string s) => s + s; }" },
  ]);
}

describe("FakeDriverExecutor", () => {
  const okCompile: CompileOutcome = { success: true, errors: [], output: "" };
  const okRun: RunOutcome = { exitCode: 0, stdout: '{"results":[]}', stderr: "" };

  it("compile 返回注入的 success/errors;run 返回注入的 stdout/exitCode", async () => {
    const compileResults: CompileOutcome = { success: false, errors: ["error: boom"], output: "javac output" };
    const runResults: RunOutcome = { exitCode: 7, stdout: "out", stderr: "err" };
    const fake = new FakeDriverExecutor({ compileResults, runResults });

    const side = javaSide();
    await expect(fake.compile(side)).resolves.toEqual(compileResults);
    await expect(fake.run(side)).resolves.toEqual(runResults);
  });

  it("compileResults/runResults 可注入函数(接收 side 返回结果)", async () => {
    const fake = new FakeDriverExecutor({
      compileResults: (side) => ({ success: true, errors: [], output: side.language }),
      runResults: (side) => ({ exitCode: 0, stdout: side.language, stderr: "" }),
    });

    const side = csharpSide();
    await expect(fake.compile(side)).resolves.toMatchObject({ output: "C#" });
    await expect(fake.run(side)).resolves.toMatchObject({ stdout: "C#" });
  });

  it("未注入 compileResults/runResults 时抛错(含只注入其一)", () => {
    expect(() => new FakeDriverExecutor()).toThrow(/compileResults/);
    expect(() => new FakeDriverExecutor({ compileResults: okCompile })).toThrow(/runResults/);
    expect(() => new FakeDriverExecutor({ runResults: okRun })).toThrow(/compileResults/);
  });

  it("调用参数被记录(compile/run 收到完整 side,含 language/sourceFiles)", async () => {
    const fake = new FakeDriverExecutor({ compileResults: okCompile, runResults: okRun });

    const side = javaSide();
    await fake.compile(side);
    await fake.run(side);

    expect(fake.compileCalls).toHaveLength(1);
    expect(fake.compileCalls[0]).toEqual(side);
    expect(fake.compileCalls[0].language).toBe("Java");
    expect(fake.compileCalls[0].sourceFiles).toHaveLength(1);
    expect(fake.compileCalls[0].sourceFiles[0].relativePath).toBe("Hello.java");

    expect(fake.runCalls).toHaveLength(1);
    expect(fake.runCalls[0]).toEqual(side);
  });
});

describe("isToolchainAvailable", () => {
  it("未知语言抛错", () => {
    expect(() => isToolchainAvailable("Kotlin" as VerifierLanguage)).toThrow(/Unsupported language/);
  });

  it("Java / C# / Python / TypeScript 返回 boolean", () => {
    expect(typeof isToolchainAvailable("Java")).toBe("boolean");
    expect(typeof isToolchainAvailable("C#")).toBe("boolean");
    expect(typeof isToolchainAvailable("Python")).toBe("boolean");
    expect(typeof isToolchainAvailable("TypeScript")).toBe("boolean");
  });
});

describe("RealDriverExecutor side-file boundary", () => {
  const executor = new RealDriverExecutor();
  const traversalSide = makeSide("TypeScript", "console.log('driver');", [
    { relativePath: "../outside.ts", content: "export const escaped = true;" },
  ]);

  it("rejects traversal paths before invoking the compiler", async () => {
    const result = await executor.compile(traversalSide);

    expect(result.success).toBe(false);
    expect(result.output).toContain("escapes the execution directory");
  });

  it("rejects traversal paths before invoking the runtime", async () => {
    const result = await executor.run(traversalSide);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("escapes the execution directory");
  });

  it.each([
    "/tmp/outside.ts",
    "C:\\outside.ts",
    "\\\\server\\share\\outside.ts",
    "safe/../../outside.ts",
    "safe/\u0000outside.ts",
  ])("rejects non-contained source path %j", async (relativePath) => {
    const result = await executor.compile(makeSide("TypeScript", "console.log('driver');", [
      { relativePath, content: "export const escaped = true;" },
    ]));

    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid verifier side specification");
  });
});

describe.skipIf(!isToolchainAvailable("Java"))("RealDriverExecutor Java 集成", () => {
  const executor = new RealDriverExecutor();

  it("生成 driver + Hello.java → compile 成功,run 输出合法 JSON 且含 hi pi", async () => {
    const side = javaSide();

    const compiled = await executor.compile(side);
    expect(compiled.success).toBe(true);
    expect(compiled.errors).toEqual([]);

    const ran = await executor.run(side);
    expect(ran.exitCode).toBe(0);
    expect(ran.stderr).toBe("");
    expect(ran.stdout).toContain("hi pi");

    const parsed = JSON.parse(ran.stdout) as {
      results: Array<{ caseId: string; outcome: string; returnValue: { type: string; value: string } }>;
    };
    expect(parsed.results[0].caseId).toBe("c1");
    expect(parsed.results[0].outcome).toBe("return");
    expect(parsed.results[0].returnValue.value).toBe("hi pi");
  });

  it("编译失败 → success:false 且 errors 非空(解析 javac error: 行)", async () => {
    const side = makeSide("Java", generateDriverSource(javaDescription), [
      { relativePath: "Hello.java", content: "public class Hello {" },
    ]);

    const compiled = await executor.compile(side);
    expect(compiled.success).toBe(false);
    expect(compiled.errors.length).toBeGreaterThan(0);
  });

  it("reuseDir:直接复用已有目录,driver 写入后编译运行,且目录不被删除", async () => {
    const reuseDir = mkdtempSync(join(tmpdir(), "fx-reuse-test-"));
    try {
      writeFileSync(
        join(reuseDir, "Hello.java"),
        'public class Hello { public static String greet(String name){ return "hi " + name; } }',
        "utf8",
      );
      const side: SideSpec = { ...javaSide(), projectRoot: reuseDir, reuseDir };

      const compiled = await executor.compile(side);
      expect(compiled.success).toBe(true);

      const ran = await executor.run(side);
      expect(ran.exitCode).toBe(0);
      expect(ran.stdout).toContain("hi pi");

      // 复用目录:不复制、不删除;driver 与编译产物留在原目录。
      expect(existsSync(reuseDir)).toBe(true);
    } finally {
      rmSync(reuseDir, { recursive: true, force: true });
    }
  });

  it("FQN 类名 + 包私有类:驱动同包声明 → 编译运行成功(包私有成员可访问)", async () => {
    const driver = generateDriverSource({
      schemaVersion: "1.0",
      target: { language: "Java", className: "com.example.Secret", method: "secret", isStatic: true, constructorArgs: [] },
      cases: [
        { id: "c1", inputs: [], expected: { kind: "return", value: { type: "string", value: "open" } } },
      ],
    });
    const side = makeSide("Java", driver, [
      {
        relativePath: "com/example/Secret.java",
        content: "package com.example; final class Secret { static String secret() { return \"open\"; } }",
      },
    ]);

    const compiled = await executor.compile(side);
    expect(compiled.success).toBe(true);
    expect(compiled.errors).toEqual([]);

    const ran = await executor.run(side);
    expect(ran.exitCode).toBe(0);
    expect(ran.stderr).toBe("");
    const parsed = JSON.parse(ran.stdout) as { results: Array<{ outcome: string; returnValue: { type: string; value: string } }> };
    expect(parsed.results[0].outcome).toBe("return");
    expect(parsed.results[0].returnValue.value).toBe("open");
  });
});

describe.skipIf(!isToolchainAvailable("C#"))("RealDriverExecutor C# 集成", () => {
  const executor = new RealDriverExecutor();

  it("生成 driver + Util.cs → compile 成功,run 输出可解析 JSON 且含 abab", async () => {
    const side = csharpSide();

    const compiled = await executor.compile(side);
    expect(compiled.success).toBe(true);
    expect(compiled.errors).toEqual([]);

    const ran = await executor.run(side);
    expect(ran.exitCode).toBe(0);
    expect(ran.stderr).toBe("");

    const parsed = JSON.parse(ran.stdout) as {
      results: Array<{ caseId: string; outcome: string; returnValue: { type: string; value: string } }>;
    };
    expect(parsed.results[0].caseId).toBe("c1");
    expect(parsed.results[0].outcome).toBe("return");
    expect(parsed.results[0].returnValue.value).toBe("abab");
  });

  it("编译失败 → success:false 且 errors 非空(解析 error CS 行)", async () => {
    const side = makeSide("C#", generateDriverSource(csharpDescription), [
      { relativePath: "Util.cs", content: "public static class Util {" },
    ]);

    const compiled = await executor.compile(side);
    expect(compiled.success).toBe(false);
    expect(compiled.errors.length).toBeGreaterThan(0);
  });
});
