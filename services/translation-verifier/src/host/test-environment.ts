import { access, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { VerificationInput } from "../types.js";
import {
  relativePath,
  type TargetTest,
  type TestRunner,
} from "./tools/common.js";

export type TestFramework = TestRunner;

export type TestEnvironment = {
  framework: TestFramework;
  testRoots: readonly string[];
  targetTest: TargetTest;
};

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
  const roots = candidate.framework === "maven"
    ? mavenTestRoots(config)
    : gradleTestRoots(config);
  const testRoots = await validateTestRoots(root, roots, candidate.framework);
  return {
    framework: candidate.framework,
    testRoots,
    targetTest: {
      executable: await wrapperOrCommand(root, candidate.framework === "maven" ? "mvnw" : "gradlew"),
      args: ["test"],
    },
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
  if (!config) {
    throw new Error("Could not find pytest configuration for the Python target project.");
  }
  const roots = parsePythonTestPaths(config.entries[0] ?? "");
  const testRoots = await validateTestRoots(root, roots.length > 0 ? roots : ["tests"], "pytest");
  return {
    framework: "pytest",
    testRoots,
    targetTest: {
      executable: process.platform === "win32" ? "python.exe" : "python3",
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
  const roots = await nodeTestRoots(root, framework, packageJson);
  return {
    framework,
    testRoots: await validateTestRoots(root, roots, framework),
    targetTest: {
      executable: process.platform === "win32" ? "npm.cmd" : "npm",
      args: framework === "jest" ? ["test", "--", "--runInBand"] : ["test", "--"],
    },
  };
}

function mavenTestRoots(xml: string): string[] {
  const roots = [
    ...allTagValues(xml, "testSourceDirectory"),
    ...allTagValues(xml, "testResourceDirectory"),
    ...allNestedTagValues(xml, "testResource", "directory"),
  ];
  return unique(roots.length > 0 ? roots : ["src/test/java"]);
}

function gradleTestRoots(script: string): string[] {
  const roots = [
    ...allCallValues(script, "java.srcDirs"),
    ...allCallValues(script, "resources.srcDirs"),
  ];
  return unique(roots.length > 0 ? roots : ["src/test/java"]);
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
      if (root) return [root];
      const include = stringArrayProperty(config, "include");
      const derived = include.map((pattern) => pattern.split("/").slice(0, -1).join("/")).filter(Boolean);
      if (derived.length > 0) return unique(derived);
    }
  }
  throw new Error(`The ${framework} configuration must declare test roots.`);
}

async function validateTestRoots(
  projectRoot: string,
  roots: readonly string[],
  framework: string,
): Promise<string[]> {
  if (roots.length === 0) throw new Error(`No test roots were configured for ${framework}.`);
  const result: string[] = [];
  for (const root of unique(roots)) {
    const safeRoot = normalizeConfiguredRoot(root, framework);
    const absolute = resolve(projectRoot, safeRoot);
    const outside = relative(projectRoot, absolute);
    if (outside === ".." || outside.startsWith(`..${sep}`) || absolute === projectRoot) {
      throw new Error(`Configured ${framework} test root escapes the target project: ${root}`);
    }
    try {
      const info = await stat(absolute);
      if (!info.isDirectory()) throw new Error(`Configured ${framework} test root is not a directory: ${root}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Configured ${framework} test root does not exist: ${root}`);
      }
      throw error;
    }
    result.push(safeRoot);
  }
  return result;
}

function normalizeConfiguredRoot(value: string, framework: string): string {
  let normalized = value.trim().replace(/\\/g, "/");
  normalized = normalized.replace(/^\$\{project\.basedir\}\/?/, "");
  normalized = normalized.replace(/^\$rootDir\/?/, "");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Invalid ${framework} test root: ${value}`);
  }
  return relativePath(normalized, `${framework} test root`);
}

function allTagValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\s*>([^<]+)</${tag}>`, "g"))].map((match) => match[1]?.trim() ?? "").filter(Boolean);
}

function allNestedTagValues(xml: string, parent: string, child: string): string[] {
  return [...xml.matchAll(new RegExp(`<${parent}\\b[^>]*>[\\s\\S]*?<${child}\\s*>([^<]+)</${child}>[\\s\\S]*?</${parent}>`, "g"))].map((match) => match[1]?.trim() ?? "").filter(Boolean);
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

function normalizeLanguage(value: string): "java" | "javascript" | "python" | "unsupported" {
  const language = value.trim().toLowerCase();
  if (language === "java") return "java";
  if (["javascript", "typescript", "node", "node.js", "js", "ts"].includes(language)) return "javascript";
  if (["python", "python3", "py"].includes(language)) return "python";
  return "unsupported";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
