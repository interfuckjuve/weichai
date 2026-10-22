import { MAVEN_COVERAGE_GOALS } from "./test-runner.js";
import { access, lstat, mkdir, readFile, realpath, stat, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { VerificationInput } from "../../types.js";
import {
  relativePath,
  type TargetTest,
  type TestRunner,
} from "../tools/common.js";

export type TestFramework = TestRunner;

export type TestEnvironment = {
  framework: TestFramework;
  testRoots: readonly string[];
  targetTest: TargetTest;
  cleanup?: () => Promise<void>;
};

/** Reuse one stable Agent directory without exposing the surrounding test suite. */
async function agentTestRoots(
  projectRoot: string,
  sourceRoots: readonly string[],
  framework: string,
  createSourceRoot = false,
): Promise<string[]> {
  const roots = createSourceRoot
    ? [await testDirectory(projectRoot, sourceRoots[0]!, framework, true)]
    : await validateTestRoots(projectRoot, sourceRoots, framework);
  return [await testDirectory(projectRoot, `${roots[0]}/translation-verifier`, framework, true)];
}

/** Reject links before traversing or creating any test directory component. */
async function testDirectory(projectRoot: string, directory: string, framework: string, create = false): Promise<string> {
  const safeRoot = normalizeConfiguredRoot(directory, framework);
  const absolute = resolve(projectRoot, safeRoot);
  const outside = relative(projectRoot, absolute);
  if (outside === ".." || outside.startsWith(`..${sep}`) || absolute === projectRoot) {
    throw new Error(`Configured ${framework} test root escapes the target project: ${directory}`);
  }
  let cursor = projectRoot;
  for (const part of safeRoot.split("/")) {
    cursor = join(cursor, part);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new Error(`Configured ${framework} test root does not exist: ${directory}`);
      await mkdir(cursor);
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink()) throw new Error(`Configured ${framework} test root contains a symbolic link: ${directory}`);
    if (!info.isDirectory()) throw new Error(`Configured ${framework} test root is not a directory: ${directory}`);
  }
  return safeRoot;
}

async function writeHarnessConfig(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new Error(`Harness configuration must be a regular file without symbolic or hard links: ${path}`);
    }
    // Preserve the existing Host harness and all tests/reports on resumed runs.
  }
}

type ProjectConfig = {
  root: string;
  entries: readonly string[];
};

/**
 * Resolve the target project's framework-owned test directories and runner.
 * The returned paths are project-relative and have already been checked on disk.
 */
export async function resolveTestEnvironment(
  input: Pick<VerificationInput, "targetLanguage" | "targetProjectPath">,
): Promise<TestEnvironment> {
  const root = await existingDirectory(input.targetProjectPath, "target project");
  const language = normalizeLanguage(input.targetLanguage);

  switch (language) {
    case "java":
      return resolveJavaEnvironment(root);
    case "javascript":
      return resolveNodeEnvironment(root);
    case "csharp":
      return resolveDotnetEnvironment(root);
    case "python":
      return resolvePythonEnvironment(root);
    default:
      throw new Error(
        `Unsupported target language for test environment resolution: ${input.targetLanguage}`,
      );
  }
}

async function resolveJavaEnvironment(root: string): Promise<TestEnvironment> {
  const pom = join(root, "pom.xml");
  const gradle = join(root, "build.gradle");
  const gradleKotlin = join(root, "build.gradle.kts");
  const candidates = [
    ...(await fileExists(pom) ? [{ framework: "maven" as const, config: pom }] : []),
    ...(await fileExists(gradle)
      ? [{ framework: "gradle" as const, config: gradle }]
      : []),
    ...(await fileExists(gradleKotlin)
      ? [{ framework: "gradle" as const, config: gradleKotlin }]
      : []),
  ];
  if (candidates.length === 0) {
    throw new Error("Could not find a Maven or Gradle configuration for the Java target project.");
  }
  if (candidates.length > 1 && candidates.some((candidate) => candidate.framework !== candidates[0]?.framework)) {
    throw new Error("Java target project has ambiguous Maven and Gradle configurations.");
  }

  const candidate = candidates[0];
  const config = await readText(candidate.config);
  const configuredRoots = candidate.framework === "maven"
    ? mavenTestSourceRoots(config)
    : gradleTestSourceRoots(config);
  const defaultRoot = "src/test/java";
  if (candidate.framework === "maven" && configuredRoots.length === 0 && !(await directoryExists(join(root, defaultRoot)))) {
    // Compiled production skeletons can use a stable Host-owned JUnit harness
    // without adding test dependencies to the production project.
    const compiledOutput = await mavenCompiledOutput(root, config);
    if (compiledOutput) {
      const harness = await createMavenHarness(root, config, compiledOutput);
      return {
        framework: "maven",
        testRoots: await agentTestRoots(root, [harness.testsRelative], "maven", true),
        targetTest: harness.targetTest,
      };
    }
  }
  return {
    framework: candidate.framework,
    testRoots: await agentTestRoots(root, configuredRoots.length ? configuredRoots : [defaultRoot], candidate.framework, configuredRoots.length === 0),
    targetTest: {
      executable: await wrapperOrCommand(root, candidate.framework === "maven" ? "mvnw" : "gradlew"),
      args: candidate.framework === "maven" ? [...MAVEN_COVERAGE_GOALS] : ["test"],
    },
  };
}

async function mavenCompiledOutput(root: string, pom: string): Promise<{ jar?: string; classes?: string } | undefined> {
  const target = join(root, "target");
  const classes = await directoryExists(join(target, "classes"));
  const artifactId = (pom.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/i)?.[1] ?? "").trim();
  const jars = (await readdir(target).catch(() => [] as string[]))
    .filter(name => name.endsWith(".jar") && !name.endsWith("-sources.jar") && !name.endsWith("-javadoc.jar"));
  const jarName = jars.find(name => artifactId && name.startsWith(`${artifactId}-`)) ?? jars[0];
  if (!jarName && !classes) return undefined;
  return { ...(jarName ? { jar: join(target, jarName) } : {}), ...(classes ? { classes: join(target, "classes") } : {}) };
}

async function createMavenHarness(root: string, productionPom: string, compiled: { jar?: string; classes?: string }): Promise<{
  testsRelative: string;
  targetTest: TargetTest;
}> {
  const artifactId = (productionPom.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/i)?.[1] ?? "target-project").trim();
  const version = (productionPom.match(/<version>\s*([^<]+)\s*<\/version>/i)?.[1] ?? "0.0.0").trim();
  const release = (productionPom.match(/<maven\.compiler\.release>\s*([^<]+)\s*<\/maven\.compiler\.release>/i)?.[1] ??
    productionPom.match(/<release>\s*([^<]+)\s*<\/release>/i)?.[1] ?? "21").trim();
  const harnessRelative = ".translation-verifier-tests/maven";
  const harnessRoot = join(root, harnessRelative);
  const testsRelative = `${harnessRelative}/src/test/java`;
  const pomRelative = `${harnessRelative}/pom.xml`;
  const productionJar = compiled.jar?.replaceAll("\\", "/");
  const productionClasses = (compiled.classes ?? join(root, "target", "classes")).replaceAll("\\", "/");
  const productionSources = join(root, "src", "main", "java").replaceAll("\\", "/");
  await testDirectory(root, testsRelative, "maven", true);
  await writeHarnessConfig(join(harnessRoot, "pom.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>forexplore.verifier</groupId><artifactId>translation-verifier-harness</artifactId><version>1.0.0</version>
  <properties><maven.compiler.release>${release}</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <production.classes>${productionClasses}</production.classes><production.sources>${productionSources}</production.sources>
  </properties>
  <dependencies>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.11.4</version></dependency>
    ${productionJar ? `<dependency><groupId>target.production</groupId><artifactId>${artifactId}</artifactId><version>${version}</version><scope>system</scope><systemPath>${productionJar}</systemPath></dependency>` : ""}
  </dependencies>
  <build>
    <!-- JaCoCo report reads the Maven project's outputDirectory, not classDirectories. -->
    <outputDirectory>\${production.classes}</outputDirectory>
    <testSourceDirectory>\${project.basedir}/src/test/java</testSourceDirectory>
    <plugins>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.5.0</version><configuration><useModulePath>false</useModulePath></configuration></plugin>
      <plugin><groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId><version>0.8.13</version></plugin>
      <plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version><configuration><release>\${maven.compiler.release}</release>${productionJar ? "" : "<additionalClasspathElements><additionalClasspathElement>\${production.classes}</additionalClasspathElement></additionalClasspathElements>"}</configuration></plugin>
    </plugins>
  </build>
</project>
`);
  return {
    testsRelative,
    targetTest: {
      executable: await wrapperOrCommand(root, "mvnw"),
      args: ["-f", pomRelative, ...MAVEN_COVERAGE_GOALS],
    },
  };
}

async function resolveDotnetEnvironment(root: string): Promise<TestEnvironment> {
  const entries = await readdir(root, { recursive: true });
  const projects: string[] = [];
  for (const name of entries) {
    const path = name.replaceAll("\\", "/");
    // Host harnesses are resolved explicitly below so resumed runs keep the
    // same project and test root without treating them as user test projects.
    if (!path.endsWith(".csproj") || path.split("/").some(part => ["obj", "bin", ".git", ".translation-verifier-tests"].includes(part))) continue;
    const text = await readText(join(root, path));
    if (/<IsTestProject>\s*true\s*<\/IsTestProject>/i.test(text) || /Include=["']Microsoft\.NET\.Test\.Sdk["']/i.test(text)) projects.push(path);
  }
  if (projects.length > 1) throw new Error("C# target project must contain exactly one standard dotnet test project.");
  if (projects.length === 1) {
    const project = projects[0]!;
    const directory = project.includes("/") ? project.slice(0, project.lastIndexOf("/")) : "";
    if (!directory) throw new Error("C# test project must be in a dedicated test directory.");
    return { framework: "dotnet", testRoots: await agentTestRoots(root, [directory], "dotnet"), targetTest: { executable: "dotnet", args: ["test", project] } };
  }

  // Keep a stable Host-owned xUnit harness when the production skeleton has
  // no standard test project, without adding test dependencies to production.
  const productionProjects = entries
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".csproj") && !name.split("/").some((part) => ["obj", "bin", ".git", ".translation-verifier-tests"].includes(part)));
  if (productionProjects.length !== 1) throw new Error("C# target project must contain one production project when no test project is present.");
  const productionProject = productionProjects[0]!;
  const productionAbsolute = join(root, productionProject);
  const productionText = await readText(productionAbsolute);
  const targetFramework = productionText.match(/<TargetFramework(?:s)?[^>]*>\s*([^<]+)\s*<\/TargetFramework(?:s)?>/i)?.[1]?.trim() ?? "net8.0";
  const harnessRelative = ".translation-verifier-tests/dotnet";
  const harnessRoot = join(root, harnessRelative);
  // Keep the harness: dotnet's default TestResults directory lives beside
  // this project, and generated tests must remain available for inspection.
  const testsRelative = `${harnessRelative}/tests`;
  const projectRelative = `${harnessRelative}/AgentTests.csproj`;
  const reference = relative(harnessRoot, productionAbsolute).replaceAll(sep, "/");
  const testRoots = await agentTestRoots(root, [testsRelative], "dotnet", true);
  await writeHarnessConfig(join(harnessRoot, "AgentTests.csproj"), `<Project Sdk="Microsoft.NET.Sdk">\n` +
    `  <PropertyGroup>\n` +
    `    <TargetFramework>${targetFramework}</TargetFramework>\n` +
    `    <IsTestProject>true</IsTestProject>\n` +
    `    <IsPackable>false</IsPackable>\n` +
    `    <Nullable>enable</Nullable>\n` +
    `    <ImplicitUsings>enable</ImplicitUsings>\n` +
    `  </PropertyGroup>\n` +
    `  <ItemGroup>\n` +
    `    <ProjectReference Include="${reference}" />\n` +
    `    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1" />\n` +
    `    <PackageReference Include="xunit" Version="2.9.2" />\n` +
    `    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2"><PrivateAssets>all</PrivateAssets><IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets></PackageReference>\n` +
    `    <PackageReference Include="coverlet.collector" Version="6.0.2"><PrivateAssets>all</PrivateAssets><IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets></PackageReference>\n` +
    `  </ItemGroup>\n` +
    `</Project>\n`);
  return {
    framework: "dotnet",
    testRoots,
    targetTest: { executable: "dotnet", args: ["test", projectRelative] },
  };
}

async function resolvePythonEnvironment(root: string): Promise<TestEnvironment> {
  const configFiles = ["pytest.ini", "pyproject.toml", "setup.cfg"];
  const configs: ProjectConfig[] = [];
  for (const name of configFiles) {
    const path = join(root, name);
    if (await fileExists(path)) configs.push({ root: path, entries: [await readText(path)] });
  }
  const config = configs.find(({ root: path, entries }) =>
    path.endsWith("pytest.ini")
      ? /^\s*\[pytest\]/m.test(entries[0] ?? "")
      : path.endsWith("setup.cfg")
        ? /^\s*\[tool:pytest\]/m.test(entries[0] ?? "")
        : /\[tool\.pytest\.ini_options\]/.test(entries[0] ?? ""),
  );
  const configuredRoots = config ? parsePythonTestPaths(config.entries[0] ?? "") : [];
  const testRoots = await agentTestRoots(root, configuredRoots.length > 0 ? configuredRoots : ["tests"], "pytest", configuredRoots.length === 0);
  return {
    framework: "pytest",
    testRoots,
    targetTest: {
      executable: await fileExists(join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"))
        ? join(root, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python")
      : process.platform === "win32" ? "python.exe" : "python3",
      args: ["-m", "pytest"],
    },
  };
}

async function resolveNodeEnvironment(root: string): Promise<TestEnvironment> {
  const packagePath = join(root, "package.json");
  if (!(await fileExists(packagePath))) {
    throw new Error("Could not find package.json for the JavaScript or TypeScript target project.");
  }
  const packageJson = parseJson(await readText(packagePath), "package.json") as Record<string, unknown>;
  const dependencies = {
    ...asStringRecord(packageJson.dependencies),
    ...asStringRecord(packageJson.devDependencies),
    ...asStringRecord(packageJson.peerDependencies),
  };
  const script = asStringRecord(packageJson.scripts).test ?? "";
  const hasJest = "jest" in dependencies || /\bjest\b/.test(script) || await anyFileExists(root, ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.json"]);
  const hasVitest = "vitest" in dependencies || /\bvitest\b/.test(script) || await anyFileExists(root, ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.cjs"]);
  if (hasJest === hasVitest) {
    throw new Error("Could not uniquely identify Jest or Vitest for the Node target project.");
  }

  const framework: TestFramework = hasJest ? "jest" : "vitest";
  const roots = (await nodeTestRoots(root, framework, packageJson))
    .filter((directory) => !isNodeProjectRoot(directory));
  return {
    framework,
    testRoots: await agentTestRoots(root, roots.length ? roots : ["tests"], framework, roots.length === 0),
    targetTest: {
      executable: process.platform === "win32" ? "npm.cmd" : "npm",
      args: framework === "jest" ? ["test", "--", "--runInBand"] : ["test", "--"],
    },
  };
}

function mavenTestSourceRoots(xml: string): string[] {
  return allTagValues(xml, "testSourceDirectory");
}

function gradleTestSourceRoots(script: string): string[] {
  // Do not interpret main.java.srcDirs as test source authorization.
  const testBlocks = [...script.matchAll(/\btest\s*\{([\s\S]*?)\}/g)];
  return unique([
    ...allCallValues(script, "test.java.srcDirs"),
    ...testBlocks.flatMap((match) => allCallValues(match[1] ?? "", "java.srcDirs")),
  ]);
}

function parsePythonTestPaths(config: string): string[] {
  const match = config.match(/^\s*testpaths\s*=\s*(.+)$/m);
  if (!match?.[1]) return [];
  const value = match[1].trim();
  const array = value.match(/^\[(.*)\]$/s);
  if (array) return [...array[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1] as string);
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

async function nodeTestRoots(
  root: string,
  framework: "jest" | "vitest",
  packageJson: Record<string, unknown>,
): Promise<string[]> {
  if (framework === "jest") {
    const jest = packageJson.jest;
    if (typeof jest === "object" && jest !== null && !Array.isArray(jest)) {
      const roots = (jest as Record<string, unknown>).roots;
      if (Array.isArray(roots) && roots.every((value) => typeof value === "string")) return roots as string[];
    }
    const configPath = await firstExistingFile(root, ["jest.config.json", "jest.config.js", "jest.config.cjs", "jest.config.mjs"]);
    if (configPath) {
      const config = await readText(configPath);
      const roots = stringArrayProperty(config, "roots");
      if (roots.length > 0) return roots;
    }
  } else {
    const configPath = await firstExistingFile(root, ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs", "vitest.config.cjs"]);
    if (configPath) {
      const config = await readText(configPath);
      const root = stringProperty(config, "root");
      if (root && !isNodeProjectRoot(root)) return [root];
      const include = stringArrayProperty(config, "include");
      const derived = include.map((pattern) => {
        const parts = pattern.replaceAll("\\", "/").split("/");
        const glob = parts.findIndex((part) => /[*?\[\]{}()!]/.test(part));
        return parts.slice(0, glob < 0 ? -1 : glob).join("/");
      }).filter(Boolean);
      if (derived.length > 0) return unique(derived);
    }
  }
  return [];
}

function isNodeProjectRoot(value: string): boolean {
  return /^(?:\.|<rootDir>)(?:[\\/]\.?[\\/]?)?$/.test(value.trim());
}

async function validateTestRoots(
  projectRoot: string,
  roots: readonly string[],
  framework: string,
): Promise<string[]> {
  if (roots.length === 0) throw new Error(`No test roots were configured for ${framework}.`);
  const result: string[] = [];
  for (const root of unique(roots)) {
    result.push(await testDirectory(projectRoot, root, framework));
  }
  return result;
}

function normalizeConfiguredRoot(value: string, framework: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  normalized = normalized.replace(/^\$\{project\.basedir\}\/?/, "");
  normalized = normalized.replace(/^\$rootDir\/?/, "");
  normalized = normalized.replace(/^<rootDir>\/?/, "");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid ${framework} test root: ${value}`);
  }
  return relativePath(normalized, `${framework} test root`);
}

function allTagValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\s*>([^<]+)</${tag}>`, "g"))].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

function allCallValues(script: string, call: string): string[] {
  const escaped = call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...script.matchAll(new RegExp(`${escaped}\\s*(?:\\(|\\s+)([^)\\n]+)\\)?`, "g"))]
    .flatMap((match) => [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((item) => item[1] as string));
}

function stringArrayProperty(value: string, property: string): string[] {
  const match = value.match(new RegExp(`\\b${property}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  return match ? [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1] as string) : [];
}

function stringProperty(value: string, property: string): string | undefined {
  return value.match(new RegExp(`\\b${property}\\s*:\\s*["']([^"']+)["']`))?.[1];
}

async function existingDirectory(path: string, label: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  return canonical;
}

async function wrapperOrCommand(root: string, wrapper: string): Promise<string> {
  const wrapperPath = join(root, wrapper);
  if (await fileExists(wrapperPath)) return `./${wrapper}`;
  return wrapper === "mvnw" ? "mvn" : "gradle";
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

async function anyFileExists(root: string, names: readonly string[]): Promise<boolean> {
  for (const name of names) if (await fileExists(join(root, name))) return true;
  return false;
}

async function firstExistingFile(root: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    const path = join(root, name);
    if (await fileExists(path)) return path;
  }
  return undefined;
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in ${name}.`);
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function normalizeLanguage(value: string): "java" | "javascript" | "python" | "csharp" | "unsupported" {
  const language = value.trim().toLowerCase();
  if (["c#", "csharp", "cs", "c-sharp"].includes(language)) return "csharp";
  if (language === "java") return "java";
  if (["javascript", "typescript", "node", "node.js", "js", "ts"].includes(language)) return "javascript";
  if (["python", "python3", "py"].includes(language)) return "python";
  return "unsupported";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
