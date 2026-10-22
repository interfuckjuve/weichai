import { bindTestRunner } from "../src/host/test-runner.js";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveTestEnvironment } from "../src/host/test-environment.js";
import { createRunTargetTestsTool } from "../src/host/tools/run-target-tests.js";
import { revalidateTargetReport } from "../src/host/revalidation.js";
import type { ToolContext, TestRunner } from "../src/host/tools/common.js";

// Runtime dependencies live outside the repository; this suite never installs them.
const enabled = process.env.TRANSLATION_VERIFIER_RUNNER_E2E === "1";
const dependencies = process.env.TRANSLATION_VERIFIER_RUNNER_DEPS ?? "/private/tmp/verifier-runners";
const suite = enabled ? describe : describe.skip;
suite("real target runner coverage", () => {
  it.each(["gradle", "pytest", "jest", "vitest", "dotnet"] as TestRunner[])("collects fresh %s tests and function coverage", async runner => {
    const root = await mkdtemp(join(tmpdir(), `verifier-${runner}-`));
    const put = async (path: string, text: string) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), text);
    };
    try {
      let language: string, sourcePath: string, testPath: string, functionName: string;
      let good: string, unrelated: string, failing: string, skipped: string;
      if (runner === "pytest") {
        language = "Python"; sourcePath = "price.py"; testPath = "tests/translation-verifier/test_price.py"; functionName = "calculate";
        await put("pytest.ini", "[pytest]\ntestpaths=tests\npythonpath=.\n");
        await symlink(join(dependencies, "python"), join(root, ".venv"));
        await put(sourcePath, "def calculate(value):\n    if value > 0:\n        return value * 2\n    return 0\n");
        good = "from price import calculate\ndef test_price():\n    assert calculate(3) == 6\n";
        unrelated = "def test_other():\n    assert True\n";
        failing = good.replace("== 6", "== 7");
        skipped = "import pytest\n@pytest.mark.skip\ndef test_price():\n    assert False\n";
      } else if (runner === "jest" || runner === "vitest") {
        language = "JavaScript"; sourcePath = "price.js"; testPath = "tests/translation-verifier/price.test.js"; functionName = "calculate";
        await symlink(join(dependencies, "node/node_modules"), join(root, "node_modules"));
        await put("package.json", JSON.stringify({ ...(runner === "vitest" ? { type: "module" } : {}), scripts: { test: runner === "jest" ? "jest" : "vitest run" }, devDependencies: { [runner]: "*" }, ...(runner === "jest" ? { jest: { roots: ["<rootDir>/tests"], coverageProvider: "babel" } } : {}) }));
        if (runner === "vitest") await put("vitest.config.js", "export default {test: {include: ['tests/**/*.test.js']}};");
        await put(sourcePath, `${runner === "vitest" ? "export " : ""}function calculate(value) {\n if (value > 0) return value * 2;\n return 0;\n}\n${runner === "jest" ? "module.exports = { calculate };" : ""}\n`);
        const imports = runner === "jest" ? "const {calculate} = require('../../price.js');\n" : "import {test, expect} from 'vitest';\nimport {calculate} from '../../price.js';\n";
        good = imports + "test('price', () => expect(calculate(3)).toBe(6));\n";
        unrelated = (runner === "vitest" ? "import {test, expect} from 'vitest';\n" : "") + "test('other', () => expect(true).toBe(true));\n";
        failing = good.replace("toBe(6)", "toBe(7)");
        skipped = good.replace("test(", "test.skip(");
      } else if (runner === "gradle") {
        language = "Java"; sourcePath = "src/main/java/demo/Price.java"; testPath = "src/test/java/translation-verifier/demo/PriceTest.java"; functionName = "calculate";
        await put("settings.gradle", "rootProject.name = 'coverage-fixture'\n");
        await put("build.gradle", "plugins { id 'java' }\nrepositories { mavenCentral() }\ndependencies { testImplementation 'junit:junit:4.13.2' }\n");
        await put("gradlew", `#!/bin/sh\nexec '${dependencies}/gradle-8.14.3/bin/gradle' "$@"\n`);
        const { chmod } = await import("node:fs/promises");
        await chmod(join(root, "gradlew"), 0o755);
        await put(sourcePath, "package demo; public class Price { public static int calculate(int value) { if (value > 0) return value * 2; return 0; } }\n");
        good = "package demo; import org.junit.Test; import static org.junit.Assert.*; public class PriceTest { @Test public void price() { assertEquals(6, Price.calculate(3)); } }\n";
        unrelated = good.replace("assertEquals(6, Price.calculate(3))", "assertTrue(true)");
        failing = good.replace("assertEquals(6,", "assertEquals(7,");
        skipped = good.replace("@Test", "@org.junit.Ignore @Test");
      } else {
        language = "C#"; sourcePath = "src/Price.cs"; testPath = "tests/translation-verifier/PriceTest.cs"; functionName = "Calculate";
        await put("src/Price.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>');
        await put(sourcePath, "namespace Demo; public static class Price { public static int Calculate(int value) { if (value > 0) return value * 2; return 0; } }\n");
        await put("tests/PriceTests.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup><ProjectReference Include="../src/Price.csproj"/><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1"/><PackageReference Include="xunit" Version="2.9.3"/><PackageReference Include="xunit.runner.visualstudio" Version="3.1.4"/><PackageReference Include="coverlet.collector" Version="6.0.4"/></ItemGroup></Project>');
        good = "namespace Demo.Tests; public class PriceTest { [Xunit.Fact] public void PriceWorks() { Xunit.Assert.Equal(6, Demo.Price.Calculate(3)); } }\n";
        unrelated = good.replace("Xunit.Assert.Equal(6, Demo.Price.Calculate(3))", "Xunit.Assert.True(true)");
        failing = good.replace("Equal(6,", "Equal(7,");
        skipped = good.replace("[Xunit.Fact]", '[Xunit.Fact(Skip="skip")]');
      }
      await put(testPath, good);
      const environment = await resolveTestEnvironment({ targetLanguage: language, targetProjectPath: root });
      const resolvedContext: Omit<ToolContext, "runner"> = { runtime: { sourceLanguage: language, targetLanguage: language,
        sourceProjectPath: root, targetProjectPath: root, sourcePath, targetPath: sourcePath,
        targetFunction: { path: sourcePath, name: functionName }, sourceDirectory: "src", targetDirectory: "src",
        testRoots: environment.testRoots, testRunner: environment.framework, targetTest: environment.targetTest } };
      const context: ToolContext = { ...resolvedContext, runner: bindTestRunner(resolvedContext) };
      const tool = createRunTargetTestsTool()(context);
      const noBug = { verdict: "no-bug" as const, summary: "The target function is verified." };
      const positive = await tool.execute({ path: testPath });
      expect(positive, JSON.stringify(positive) + positive.stderr + positive.stdout).toMatchObject({ status: "success", tests: { executed: 1, passed: 1, failed: 0 }, coverage: { status: "available", targetFunction: { name: functionName, executed: true } } });
      if (positive.coverage?.status === "available") {
        expect(positive.coverage.targetFunction.lineCoverage).toBeGreaterThan(0);
        expect(positive.coverage.targetFunction.branchCoverage).toBe(50);
      }
      const accepted = await revalidateTargetReport(context, noBug);
      expect(accepted.feedback).toEqual([]);
      expect(accepted.observation).toMatchObject({ status: "success", tests: { executed: 1, passed: 1 } });
      await put(testPath, unrelated);
      const negative = await tool.execute({ path: testPath });
      expect(negative, JSON.stringify(negative) + negative.stderr + negative.stdout).toMatchObject({ status: "success", tests: { executed: 1 }, coverage: { status: "available", targetFunction: { executed: false, lineCoverage: 0 } } });
      const uncovered = await revalidateTargetReport(context, noBug);
      expect(uncovered.feedback.join("\n")).toContain("must execute the requested target function");
      expect(uncovered.observation).toMatchObject({ coverage: { status: "available", targetFunction: { executed: false } } });
      await put(testPath, failing);
      expect(await tool.execute({ path: testPath })).toMatchObject({ status: "failure", tests: { failed: 1 } });
      await put(testPath, skipped);
      expect(await tool.execute({ path: testPath })).toMatchObject({ tests: { executed: 0, skipped: 1 } });
      const skippedRun = await revalidateTargetReport(context, noBug);
      expect(skippedRun.feedback.join("\n")).toContain("without skipped tests");
      expect(skippedRun.observation).toMatchObject({ tests: { executed: 0, skipped: 1 } });
    } finally { if (process.env.TRANSLATION_VERIFIER_RUNNER_KEEP === "1") console.log("Fixture:", root); else await rm(root, { recursive: true, force: true }); }
  }, 300_000);
});
