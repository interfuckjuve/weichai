import { MAVEN_COVERAGE_GOALS } from "./test-runner.js";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestEnvironment } from "./test-environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "translation-verifier-environment-"));
  roots.push(root);
  return root;
}

describe("resolveTestEnvironment", () => {
  it("authorizes only the first Maven test source directory's dedicated child", async () => {
    const root = await project();
    await mkdir(join(root, "custom-tests/java"), { recursive: true });
    await mkdir(join(root, "secondary-tests"), { recursive: true });
    await writeFile(
      join(root, "pom.xml"),
      `<project><build><testSourceDirectory>custom-tests/java</testSourceDirectory><testSourceDirectory>secondary-tests</testSourceDirectory><testResources><testResource><directory>custom-tests/resources</directory></testResource></testResources></build></project>`,
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).resolves.toEqual({
      framework: "maven",
      testRoots: ["custom-tests/java/translation-verifier"],
      targetTest: { executable: "mvn", args: [...MAVEN_COVERAGE_GOALS] },
    });
  });

  it("retains and reuses the Maven default test folder when a project has no tests", async () => {
    const root = await project();
    await writeFile(join(root, "pom.xml"), "<project />");
    const input = { targetLanguage: "Java", targetProjectPath: root };
    const environment = await resolveTestEnvironment(input);
    expect(environment).toMatchObject({ framework: "maven", testRoots: ["src/test/java/translation-verifier"] });
    const testPath = join(root, environment.testRoots[0]!, "ExistingTest.java");
    await writeFile(testPath, "retained test");
    await environment.cleanup?.();
    expect((await resolveTestEnvironment(input)).testRoots).toEqual(environment.testRoots);
    await expect(readFile(testPath, "utf8")).resolves.toBe("retained test");
  });

  it("matches an isolated Maven harness to the compiled project's Java release", async () => {
    const root = await project();
    await mkdir(join(root, "target/classes"), { recursive: true });
    await writeFile(join(root, "pom.xml"), "<project><artifactId>demo</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties></project>");
    const environment = await resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root });
    const harnessPom = join(root, environment.targetTest.args[1]!);
    expect(await readFile(harnessPom, "utf8")).toContain("<maven.compiler.release>17</maven.compiler.release>");
    expect(await readFile(harnessPom, "utf8")).toContain("<outputDirectory>\${production.classes}</outputDirectory>");
    expect(await readFile(harnessPom, "utf8")).not.toContain("<classDirectories>");
    expect(await readFile(harnessPom, "utf8")).not.toMatch(/surefire\.reportsDirectory|jacoco\.(?:dataFile|outputDirectory)|<reportsDirectory>|<destFile>|<dataFile>/);
    expect(environment.testRoots).toEqual([".translation-verifier-tests/maven/src/test/java/translation-verifier"]);
    const testPath = join(root, environment.testRoots[0]!, "ExistingTest.java");
    const reportPath = join(root, ".translation-verifier-tests/maven/target/surefire-reports/TEST-ExistingTest.xml");
    await writeFile(testPath, "retained harness test");
    await mkdir(join(reportPath, ".."), { recursive: true });
    await writeFile(reportPath, "retained report");
    await environment.cleanup?.();
    const resumed = await resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root });
    expect(resumed.testRoots).toEqual(environment.testRoots);
    expect(resumed.targetTest).toEqual(environment.targetTest);
    await expect(readFile(testPath, "utf8")).resolves.toBe("retained harness test");
    await expect(readFile(reportPath, "utf8")).resolves.toBe("retained report");
  });

  it("uses only Gradle test sources, excluding main sources and resources", async () => {
    const root = await project();
    await mkdir(join(root, "checks"));
    await mkdir(join(root, "integration-tests"));
    await writeFile(join(root, "build.gradle"), `sourceSets {
      main { java.srcDirs('src/main/java') }
      test { java.srcDirs('checks', 'integration-tests'); resources.srcDirs('test-resources') }
    }`);
    await expect(resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root })).resolves.toMatchObject({
      framework: "gradle", testRoots: ["checks/translation-verifier"], targetTest: { args: ["test"] },
    });
  });

  it("creates the standard Gradle test source folder when missing", async () => {
    const root = await project();
    await writeFile(join(root, "build.gradle.kts"), "plugins {}\n");
    const environment = await resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root });
    expect(environment.testRoots).toEqual(["src/test/java/translation-verifier"]);
    await environment.cleanup?.();
    await expect(access(join(root, environment.testRoots[0]!))).resolves.toBeUndefined();
  });

  it("uses pytest testpaths from project configuration", async () => {
    const root = await project();
    await mkdir(join(root, "checks"), { recursive: true });
    await mkdir(join(root, "integration-tests"), { recursive: true });
    await writeFile(
      join(root, "pytest.ini"),
      "[pytest]\ntestpaths = checks integration-tests\n",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Python", targetProjectPath: root }),
    ).resolves.toMatchObject({
      framework: "pytest",
      testRoots: ["checks/translation-verifier"],
      targetTest: { args: ["-m", "pytest"] },
    });
  });

  it("uses the Vitest root from vitest.config.ts", async () => {
    const root = await project();
    await mkdir(join(root, "checks"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { vitest: "^4.0.0" }, scripts: { test: "vitest run" } }),
    );
    await writeFile(
      join(root, "vitest.config.ts"),
      "export default { test: { root: 'checks' } }\n",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "TypeScript", targetProjectPath: root }),
    ).resolves.toMatchObject({
      framework: "vitest",
      testRoots: ["checks/translation-verifier"],
      targetTest: { args: ["test", "--"] },
    });
  });

  it("retains the standard Node test folder when Jest has no configured root", async () => {
    const root = await project();
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { jest: "^30.0.0" }, scripts: { test: "jest" } }));
    const environment = await resolveTestEnvironment({ targetLanguage: "JavaScript", targetProjectPath: root });
    expect(environment).toMatchObject({ framework: "jest", targetTest: { args: ["test", "--", "--runInBand"] } });
    expect(environment.testRoots).toEqual(["tests/translation-verifier"]);
    const generatedRoot = join(root, environment.testRoots[0]!);
    await expect(access(generatedRoot)).resolves.toBeUndefined();
    await environment.cleanup?.();
    await expect(access(generatedRoot)).resolves.toBeUndefined();
  });

  it("retains a Python tests folder without pytest configuration", async () => {
    const root = await project();
    const environment = await resolveTestEnvironment({ targetLanguage: "Python", targetProjectPath: root });
    expect(environment).toMatchObject({ framework: "pytest", testRoots: ["tests/translation-verifier"], targetTest: { args: ["-m", "pytest"] } });
    await expect(access(join(root, "tests/translation-verifier"))).resolves.toBeUndefined();
    await environment.cleanup?.();
    await expect(access(join(root, "tests/translation-verifier"))).resolves.toBeUndefined();
  });

  it("binds C# to one dedicated standard test project and ignores build artifacts", async () => {
    const root = await project();
    await mkdir(join(root, "tests/obj"), { recursive: true });
    await writeFile(join(root, "tests/PriceTests.csproj"), '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1"/></ItemGroup></Project>');
    await writeFile(join(root, "tests/obj/Noise.csproj"), '<Project><IsTestProject>true</IsTestProject></Project>');
    await expect(resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root })).resolves.toEqual({ framework: "dotnet", testRoots: ["tests/translation-verifier"], targetTest: { executable: "dotnet", args: ["test", "tests/PriceTests.csproj"] } });
    await mkdir(join(root, "other-tests"));
    await writeFile(join(root, "other-tests/Other.csproj"), '<Project><IsTestProject>true</IsTestProject></Project>');
    await expect(resolveTestEnvironment({ targetLanguage: "CSharp", targetProjectPath: root })).rejects.toThrow("exactly one");
  });

  it("requires a dedicated directory for a C# test project", async () => {
    const root = await project();
    await writeFile(join(root, "Tests.csproj"), '<Project><IsTestProject>true</IsTestProject></Project>');
    await expect(resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root })).rejects.toThrow("dedicated test directory");
  });

  it("retains the C# harness and default reports after verification", async () => {
    const root = await project();
    await writeFile(join(root, "Application.csproj"), '<Project><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>');
    const environment = await resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root });
    expect(environment).toMatchObject({ framework: "dotnet", targetTest: { executable: "dotnet" } });
    const harnessProject = join(root, environment.targetTest.args[1]!);
    expect(environment.testRoots).toEqual([".translation-verifier-tests/dotnet/tests/translation-verifier"]);
    expect(environment.targetTest.args[1]).toBe(".translation-verifier-tests/dotnet/AgentTests.csproj");
    await expect(access(harnessProject)).resolves.toBeUndefined();
    await mkdir(join(root, environment.targetTest.args[1]!, "..", "TestResults"), { recursive: true });
    const reportPath = join(root, environment.targetTest.args[1]!, "..", "TestResults", "tests.trx");
    await writeFile(reportPath, "retained report");
    const testPath = join(root, environment.testRoots[0]!, "ExistingTests.cs");
    await writeFile(testPath, "retained test");
    await environment.cleanup?.();
    const resumed = await resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root });
    expect(resumed.testRoots).toEqual(environment.testRoots);
    expect(resumed.targetTest).toEqual(environment.targetTest);
    await expect(readFile(testPath, "utf8")).resolves.toBe("retained test");
    await expect(access(harnessProject)).resolves.toBeUndefined();
    await expect(readFile(reportPath, "utf8")).resolves.toBe("retained report");
  });

  it.each([
    { targetLanguage: "Python", configName: "pytest.ini", config: "[pytest]\ntestpaths = checks\n", testName: "test_existing.py" },
    { targetLanguage: "JavaScript", configName: "package.json", config: JSON.stringify({ devDependencies: { jest: "30" }, jest: { roots: ["checks"] } }), testName: "existing.test.js" },
    { targetLanguage: "C#", configName: "checks/Checks.csproj", config: "<Project><IsTestProject>true</IsTestProject></Project>", testName: "ExistingTests.cs" },
  ])("reuses and preserves pre-existing $targetLanguage tests in the dedicated folder", async ({ targetLanguage, configName, config, testName }) => {
    const root = await project();
    await mkdir(join(root, "checks/translation-verifier"), { recursive: true });
    await writeFile(join(root, configName), config);
    const testPath = join(root, "checks/translation-verifier", testName);
    await writeFile(testPath, "existing test");
    const input = { targetLanguage, targetProjectPath: root };
    const environment = await resolveTestEnvironment(input);
    expect(environment.testRoots).toEqual(["checks/translation-verifier"]);
    await expect(readFile(testPath, "utf8")).resolves.toBe("existing test");
    await writeFile(testPath, "updated existing test");
    await environment.cleanup?.();
    expect((await resolveTestEnvironment(input)).testRoots).toEqual(environment.testRoots);
    await expect(readFile(testPath, "utf8")).resolves.toBe("updated existing test");
  });

  it.each(["tests", "tests/translation-verifier"])("rejects a linked test directory at %s", async (linkedPath) => {
    const root = await project();
    const outside = await project();
    await mkdir(join(root, linkedPath, ".."), { recursive: true });
    await symlink(outside, join(root, linkedPath), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveTestEnvironment({ targetLanguage: "Python", targetProjectPath: root })).rejects.toThrow("symbolic link");
    await expect(access(join(outside, "translation-verifier"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a linked harness parent without writing outside the project", async () => {
    const root = await project();
    const outside = await project();
    await writeFile(join(root, "Application.csproj"), "<Project />");
    await symlink(outside, join(root, ".translation-verifier-tests"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveTestEnvironment({ targetLanguage: "C#", targetProjectPath: root })).rejects.toThrow("symbolic link");
    await expect(access(join(outside, "dotnet"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a configured test root that does not exist", async () => {
    const root = await project();
    await writeFile(
      join(root, "pom.xml"),
      "<project><build><testSourceDirectory>missing-tests</testSourceDirectory></build></project>",
    );

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).rejects.toThrow("test root does not exist: missing-tests");
  });

  it.each(["tests/**/*.test.js", "checks/unit/**/*.test.ts"])("uses the literal source prefix of a Vitest include: %s", async (include) => {
    const root = await project();
    const sourceRoot = include.startsWith("tests/") ? "tests" : "checks/unit";
    await mkdir(join(root, sourceRoot), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "4" } }));
    await writeFile(join(root, "vitest.config.ts"), `export default { test: { root: '.', include: ['${include}'] } }`);
    await expect(resolveTestEnvironment({ targetLanguage: "TypeScript", targetProjectPath: root })).resolves.toMatchObject({
      testRoots: [`${sourceRoot}/translation-verifier`],
    });
  });

  it.each([".", "<rootDir>"])("uses standard tests for a project-wide Jest root: %s", async (configuredRoot) => {
    const root = await project();
    await writeFile(join(root, "package.json"), JSON.stringify({ devDependencies: { jest: "30" }, jest: { roots: [configuredRoot] } }));
    await expect(resolveTestEnvironment({ targetLanguage: "JavaScript", targetProjectPath: root })).resolves.toMatchObject({
      testRoots: ["tests/translation-verifier"],
    });
  });

  it.each([
    { targetLanguage: "Python", configName: "pytest.ini", config: "[pytest]\ntestpaths = missing-tests\n" },
    { targetLanguage: "JavaScript", configName: "package.json", config: JSON.stringify({ devDependencies: { jest: "30" }, jest: { roots: ["missing-tests"] } }) },
  ])("rejects a missing configured $targetLanguage source root", async ({ targetLanguage, configName, config }) => {
    const root = await project();
    await writeFile(join(root, configName), config);
    await expect(resolveTestEnvironment({ targetLanguage, targetProjectPath: root })).rejects.toThrow("test root does not exist: missing-tests");
  });

  it("rejects ambiguous Java build frameworks", async () => {
    const root = await project();
    await writeFile(join(root, "pom.xml"), "<project />");
    await writeFile(join(root, "build.gradle"), "plugins {}\n");

    await expect(
      resolveTestEnvironment({ targetLanguage: "Java", targetProjectPath: root }),
    ).rejects.toThrow("ambiguous Maven and Gradle configurations");
  });
});
