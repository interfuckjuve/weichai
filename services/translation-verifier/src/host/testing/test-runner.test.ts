import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindTestRunner, bindFunctionGroupTestRunner } from "./test-runner.js";
import { MAX_TEST_OUTPUT_CHARS, type ToolRuntimeContext } from "../tools/common.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(script: string, timeoutMs = 5_000) {
  const root = await mkdtemp(join(tmpdir(), "verifier-runner-"));
  roots.push(root);
  await writeFile(join(root, "fake-runner.cjs"), script);
  const runtime: ToolRuntimeContext = {
    sourceLanguage: "Java", targetLanguage: "Java", sourceProjectPath: root, targetProjectPath: root,
    sourcePath: "src/Order.java", targetPath: "src/Order.java",
    targetFunction: { path: "src/Order.java", name: "calculatePrice" },
    sourceDirectory: "src", targetDirectory: "src", testRoots: ["tests"], testRunner: "maven",
    targetTest: { executable: process.execPath, args: ["fake-runner.cjs"], timeoutMs },
  };
  return { root, runtime, runner: bindTestRunner({ runtime }) };
}

async function expectNoTemporaryReports(root: string) {
  const names = await readdir(root);
  expect(names).not.toContain(".translation-verifier-coverage");
  expect(names).not.toContain(".forexpore");
}

describe("bound test runner", () => {
  it("executes all selected suite files together and returns their combined evidence", async () => {
    const { root, runner } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('target/surefire-reports', {recursive: true}); fs.mkdirSync('target/site/jacoco', {recursive: true});
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', '<testsuite tests="2" failures="0" errors="0" skipped="0"/>');
fs.writeFileSync('target/site/jacoco/jacoco.xml', '<report><package name=""><class name="Order" sourcefilename="Order.java"><method name="calculatePrice" desc="()I"><counter type="METHOD" missed="0" covered="1"/></method></class></package></report>');
process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/Order.java"), "public class Order { public int calculatePrice() { return 1; } }");
    const paths = ["tests/FirstTest.java", "tests/nested/SecondTest.java"];
    const result = await runner.runSuite!(paths);
    expect(JSON.parse(result.stdout)).toContain("-Dtest=FirstTest,SecondTest");
    expect(result).toMatchObject({ status: "success", testPaths: paths, tests: { executed: 2, passed: 2 },
      coverage: { status: "available", targetFunction: { executed: true } } });
  });

  it("retains runner errors alongside executed assertion failures when the process exits zero", async () => {
    const { runner } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('target/surefire-reports', {recursive: true});
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', '<testsuite tests="2" failures="1" errors="1" skipped="0"><testcase name="assertion"><failure/></testcase><testcase name="setup"><error message="Cannot initialize fixture"/></testcase></testsuite>');`);
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({
      status: "failure", exitCode: 0, executionErrors: 1, tests: { executed: 2, failed: 2 }, coverage: { status: "unavailable" },
    });
  });
  it("does not mark an executed function passed when its assertions failed", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('target/surefire-reports', {recursive: true}); fs.mkdirSync('target/site/jacoco', {recursive: true});
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', '<testsuite tests="1" failures="1" errors="0" skipped="0"/>');
fs.writeFileSync('target/site/jacoco/jacoco.xml', '<report><package name=""><class name="Order" sourcefilename="Order.java"><method name="calculatePrice" desc="()I"><counter type="METHOD" missed="0" covered="1"/></method></class></package></report>');
process.exitCode = 1;`);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/Order.java"), "public class Order { public int calculatePrice() { return 1; } }");
    runtime.functionGroup = { schemaVersion: "3.1", mode: "requirement", sourceLanguage: "Java", targetLanguage: "Java",
      targetProjectPath: root, requirement: "Calculate correctly", functions: [{ target: runtime.targetFunction }] };
    const result = await bindFunctionGroupTestRunner({ runtime }).run(["tests/OrderTest.java"]);
    expect(result.functions[0]).toMatchObject({ status: "unverified", executed: true, reason: "test-failed" });
    expect(result.status).toBe("failure");
  });

  it("returns default report paths relative to a bound Maven harness", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
const base = '.translation-verifier-tests/maven';
fs.mkdirSync(base + '/target/surefire-reports', {recursive: true});
fs.mkdirSync(base + '/target/site/jacoco', {recursive: true});
fs.writeFileSync(base + '/target/surefire-reports/TEST-Order.xml', '<testsuite tests="1" failures="0" errors="0" skipped="0"/>');
fs.writeFileSync(base + '/target/site/jacoco/jacoco.xml', '<report><package name=""><class name="Order" sourcefilename="Order.java"><method name="calculatePrice" desc="()I"><counter type="METHOD" missed="0" covered="1"/></method></class></package></report>');`);
    await mkdir(join(root, ".translation-verifier-tests/maven"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/Order.java"), "public class Order { public int calculatePrice() { return 1; } }");
    runtime.targetTest.args = [...runtime.targetTest.args, "-f", ".translation-verifier-tests/maven/pom.xml"];
    const result = await bindTestRunner({ runtime }).run(".translation-verifier-tests/maven/src/test/java/translation-verifier/OrderTest.java");
    expect(result).toMatchObject({ status: "success", tests: { executed: 1 }, coverage: { status: "available" } });
    expect(result.reportPaths?.slice().sort()).toEqual([
      ".translation-verifier-tests/maven/target/site/jacoco/jacoco.xml",
      ".translation-verifier-tests/maven/target/surefire-reports/TEST-Order.xml",
    ]);
  });

  it("preserves covered functions when another group member cannot be located", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
const directory = 'tests/TestResults';
fs.mkdirSync(directory + '/00000000-0000-0000-0000-000000000001', {recursive: true});
fs.writeFileSync(directory + '/tests.trx', '<TestRun><ResultSummary><Counters total="1" executed="1" passed="1"/></ResultSummary></TestRun>');
fs.writeFileSync(directory + '/00000000-0000-0000-0000-000000000001/coverage.cobertura.xml', '<coverage><packages><package><classes><class name="Order" filename="src/Order.cs"><methods><method name="Run" signature="()"><lines><line number="1" hits="1"/></lines></method></methods></class></classes></package></packages></coverage>');
process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
    runtime.targetLanguage = "C#";
    runtime.testRunner = "dotnet";
    runtime.targetTest.args = [...runtime.targetTest.args, "tests\\AgentTests.csproj"];
    await mkdir(join(root, "tests"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/Order.cs"), "public class Order { public void Run() {} }");
    await writeFile(join(root, "tests/OrderTest.cs"), "public class OrderTest { private sealed class FakeClock {} }");
    const functions = [{ path: "src/Order.cs", name: "Run" }, { path: "src/Order.cs", name: "Missing" }];
    runtime.functionGroup = { schemaVersion: "3.1", mode: "requirement", sourceLanguage: "C#", targetLanguage: "C#",
      targetProjectPath: root, requirement: "Run the order", functions: functions.map(target => ({ target })) };
    const oldDirectory = join(root, "tests/TestResults/00000000-0000-0000-0000-000000000002");
    await mkdir(oldDirectory, { recursive: true });
    await writeFile(join(oldDirectory, "coverage.cobertura.xml"), "old coverage");
    await writeFile(join(oldDirectory, "old.trx"), "old tests");
    const runner = bindFunctionGroupTestRunner({ runtime });
    const result = await runner.run(["tests/OrderTest.cs"]);
    expect(JSON.parse(result.stdout)).not.toContain("--results-directory");
    expect(result.tests).toEqual({ executed: 1, passed: 1, failed: 0, skipped: 0 });
    expect(result.functions[0]).toMatchObject({ status: "passed", executed: true, lineCoverage: 100 });
    expect(result.functions[1]).toMatchObject({ status: "unverified", reason: "coverage-unavailable" });
    expect(result.reportPaths?.slice().sort()).toEqual([
      "tests/TestResults/00000000-0000-0000-0000-000000000001/coverage.cobertura.xml",
      "tests/TestResults/tests.trx",
    ]);
    expect(await readFile(join(oldDirectory, "coverage.cobertura.xml"), "utf8")).toBe("old coverage");
    expect(await readFile(join(root, "tests/TestResults/tests.trx"), "utf8")).toContain('<Counters total="1"');
    await writeFile(join(root, "fake-runner.cjs"), "");
    const second = await runner.run(["tests/OrderTest.cs"]);
    expect(second.tests.executed).toBe(0);
    expect(second.reportPaths).toEqual([]);
    expect(second.functions.every(item => item.reason === "coverage-unavailable")).toBe(true);
  });
  it("retains structured failed assertions even when no coverage report was produced", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('target/surefire-reports', {recursive: true});
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', '<testsuite name="OrderTest" tests="2" failures="1" errors="0" skipped="0"><testcase classname="OrderTest" name="ok"/><testcase classname="OrderTest" name="boundary"><failure message="expected rejection">assertion trace</failure></testcase></testsuite>');
process.exitCode = 1;`);
    runtime.functionGroup = { schemaVersion: "3.1", mode: "requirement", sourceLanguage: "Java", targetLanguage: "Java",
      targetProjectPath: root, requirement: "Reject invalid input", functions: [{ target: runtime.targetFunction }] };
    const result = await bindFunctionGroupTestRunner({ runtime }).run(["tests/OrderTest.java"]);
    expect(result).toMatchObject({ status: "failure", tests: { executed: 2, failed: 1 }, testCases: [
      { id: "OrderTest#ok", status: "passed" }, { id: "OrderTest#boundary", status: "failed", message: "expected rejection\nassertion trace" },
    ] });
    expect(result.functions[0]?.reason).toBe("test-failed");
    expect(result.reportPaths).toEqual(["target/surefire-reports/TEST-Order.xml"]);
  });
  it("preserves old Maven reports without accepting them as current evidence", async () => {
    const { root, runtime, runner } = await fixture("process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    await mkdir(join(root, "target/site/jacoco"), { recursive: true });
    await mkdir(join(root, "target/surefire-reports"), { recursive: true });
    const oldReport = join(root, "target/site/jacoco/jacoco.xml");
    await writeFile(oldReport, "old coverage");
    await writeFile(join(root, "target/surefire-reports/TEST-old.xml"), '<testsuite tests="1" failures="0" errors="0" skipped="0"/>');
    // Changes to the caller's command cannot replace an already-bound runner.
    runtime.targetTest.executable = "invalid-after-binding";
    runtime.targetTest.args = [];
    const first = await runner.run("tests/OrderTest.java");
    const second = await runner.run("tests/OrderTest.java");
    expect(first).toMatchObject({ status: "success", coverage: { status: "unavailable" } });
    expect(first.tests).toBeUndefined();
    expect(second.tests).toBeUndefined();
    expect(await readFile(oldReport, "utf8")).toBe("old coverage");
    expect(await readFile(join(root, "target/surefire-reports/TEST-old.xml"), "utf8")).toContain('tests="1"');
    const firstArgs: string[] = JSON.parse(first.stdout), secondArgs: string[] = JSON.parse(second.stdout);
    expect(firstArgs).toEqual(["-Djacoco.append=false", "-Dmaven.test.failure.ignore=true", "-DfailIfNoTests=true", "-Dtest=OrderTest"]);
    expect(secondArgs).toEqual(firstArgs);
    await expectNoTemporaryReports(root);
  });

  it("preserves the workspace on failed preparation and an invalid Host command", async () => {
    const { root, runtime, runner } = await fixture("");
    await expect(runner.run("tests/OrderTest.txt")).rejects.toThrow("Java test selector");
    await expectNoTemporaryReports(root);
    runtime.targetTest.executable = "";
    await expect(bindTestRunner({ runtime }).run("tests/OrderTest.java")).rejects.toThrow("Host target test command is invalid");
    await expectNoTemporaryReports(root);
  });

  it("returns process launch errors and nonzero exits as failures", async () => {
    const { root, runtime, runner } = await fixture("process.stderr.write('assertion failed'); process.exitCode = 1");
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({ status: "failure", exitCode: 1, stderr: "assertion failed" });
    await expectNoTemporaryReports(root);
    runtime.targetTest.executable = join(root, "missing-executable");
    expect(await bindTestRunner({ runtime }).run("tests/OrderTest.java")).toMatchObject({ status: "failure", exitCode: null, timedOut: false });
    await expectNoTemporaryReports(root);
  });

  it("retains timeout and output limits inside the runner", async () => {
    const { root, runner } = await fixture("process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000)", 300);
    const result = await runner.run("tests/OrderTest.java");
    expect(result).toMatchObject({ status: "failure", timedOut: true });
    expect(result.stdout).toHaveLength(MAX_TEST_OUTPUT_CHARS);
    await expectNoTemporaryReports(root);
  });

  it("retains failed test counts when fresh coverage is unavailable, even with exit code zero", async () => {
    const { root, runner } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('target/surefire-reports', {recursive: true});
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', '<testsuite tests="2" failures="1" errors="0" skipped="0"/>');`);
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({
      status: "failure", exitCode: 0, tests: { executed: 2, passed: 1, failed: 1, skipped: 0 },
      coverage: { status: "unavailable" },
    });
    await expectNoTemporaryReports(root);
  });

  it("accepts rewritten identical reports and excludes untouched failures", async () => {
    const testXml = '<testsuite tests="1" failures="0" errors="0" skipped="0"/>';
    const coverageXml = '<report><package name=""><class name="Order" sourcefilename="Order.java"><method name="calculatePrice" desc="()I"><counter type="METHOD" missed="0" covered="1"/></method></class></package></report>';
    const { root, runner } = await fixture(`const fs = require('node:fs');
fs.writeFileSync('target/surefire-reports/TEST-Order.xml', ${JSON.stringify(testXml)});
fs.writeFileSync('target/site/jacoco/jacoco.xml', ${JSON.stringify(coverageXml)});`);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/Order.java"), "public class Order { public int calculatePrice() { return 1; } }");
    await mkdir(join(root, "target/surefire-reports"), { recursive: true });
    await mkdir(join(root, "target/site/jacoco"), { recursive: true });
    await writeFile(join(root, "target/surefire-reports/TEST-old.xml"), '<testsuite tests="9" failures="9" errors="0" skipped="0"/>');
    for (const [path, contents] of [["target/surefire-reports/TEST-Order.xml", testXml], ["target/site/jacoco/jacoco.xml", coverageXml]] as const) {
      await writeFile(join(root, path), contents);
      await utimes(join(root, path), new Date("2000-01-01"), new Date("2000-01-01"));
    }
    expect(await runner.run("tests/OrderTest.java")).toMatchObject({
      status: "success", tests: { executed: 1, failed: 0 }, coverage: { status: "available", targetFunction: { executed: true } },
    });
    expect(await readFile(join(root, "target/surefire-reports/TEST-old.xml"), "utf8")).toContain('failures="9"');
    expect(await readFile(join(root, "target/site/jacoco/jacoco.xml"), "utf8")).toBe(coverageXml);
  });

  it.each(["jest", "vitest"] as const)("retains %s default reports and ignores them on the next run", async testRunner => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
fs.mkdirSync('coverage', {recursive: true});
fs.writeFileSync('coverage/coverage-final.json', '{}');
fs.writeFileSync('tests.json', JSON.stringify({numTotalTests: 1, numFailedTests: 1}));
process.stdout.write(JSON.stringify(process.argv.slice(2)));`);
    runtime.testRunner = testRunner;
    const runner = bindTestRunner({ runtime });
    const first = await runner.run("tests/order.test.ts");
    expect(first).toMatchObject({ status: "failure", exitCode: 0, tests: { executed: 1, failed: 1 } });
    const args: string[] = JSON.parse(first.stdout);
    expect(args).toContain("--outputFile=tests.json");
    expect(args.some(arg => /coverageDirectory|reportsDirectory/.test(arg))).toBe(false);
    expect(await readFile(join(root, "coverage/coverage-final.json"), "utf8")).toBe("{}");
    await writeFile(join(root, "fake-runner.cjs"), "");
    const second = await runner.run("tests/order.test.ts");
    expect(second.tests).toBeUndefined();
    expect(second.coverage).toMatchObject({ status: "unavailable", reason: expect.stringContaining("not updated") });
    expect(await readFile(join(root, "tests.json"), "utf8")).toContain('"numFailedTests":1');
  });

  it("keeps Gradle reports in default locations and cleans only its init script", async () => {
    const { root, runtime } = await fixture(`const fs = require('node:fs');
const args = process.argv.slice(2), script = args[args.indexOf('--init-script') + 1];
fs.mkdirSync('build/test-results/test', {recursive: true});
fs.mkdirSync('build/reports/jacoco/test', {recursive: true});
fs.writeFileSync('build/test-results/test/TEST-Order.xml', '<testsuite tests="1" failures="0" errors="0" skipped="0"/>');
fs.writeFileSync('build/reports/jacoco/test/jacocoTestReport.xml', '<report/>');
process.stdout.write(JSON.stringify({script, source: fs.readFileSync(script, 'utf8')}));`);
    runtime.testRunner = "gradle";
    const result = await bindTestRunner({ runtime }).run("tests/OrderTest.java");
    expect(result.tests).toMatchObject({ executed: 1, failed: 0 });
    const script: { script: string; source: string } = JSON.parse(result.stdout);
    expect(script.source).not.toMatch(/destinationFile|outputLocation|executionData/);
    expect(script.source).toContain("ignoreFailures = true");
    await expect(readdir(dirname(script.script))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "build/reports/jacoco/test/jacocoTestReport.xml"), "utf8")).toBe("<report/>");
    expect(await readFile(join(root, "build/test-results/test/TEST-Order.xml"), "utf8")).toContain('tests="1"');
  });
});
