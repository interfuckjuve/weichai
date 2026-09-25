import type { AgentRunBudget } from "../agent.js";
import { readFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_TEXT_FILE_CHARS = 256_000;
export const MAX_TEST_OUTPUT_CHARS = 64_000;

export type HostTool<Input, Output> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse(input: unknown): Input;
  execute(input: Input): Promise<Output>;
};

export type HostToolFactory = (context: ToolContext) => HostTool<any, any>;

export type TestRunner =
  | "maven"
  | "gradle"
  | "pytest"
  | "jest"
  | "vitest";

export type TargetTest = {
  executable: string;
  args: readonly string[];
  timeoutMs?: number;
};

export type TargetTestResult = {
  status: "success" | "failure";
  timedOut: boolean;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type AgentTaskContext = {
  sourceLanguage: string;
  targetLanguage: string;
  sourceProjectPath: string;
  targetProjectPath: string;
  sourcePath: string;
  targetPath: string;
};

export type ToolRuntimeContext = AgentTaskContext & {
  sourceDirectory: string;
  targetDirectory: string;
  testRoots: readonly string[];
  testRunner: TestRunner;
  targetTest: TargetTest;
};

export type ToolState = {
  lastTargetTest?: TargetTestResult;
};

export type ToolContext = {
  state: ToolState;
  budget?: AgentRunBudget;
  runtime: ToolRuntimeContext;
};

export function relativePath(value: unknown, label = "path"): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new Error(`${label} must be a project-relative path.`);
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        part.toLowerCase() === ".git" ||
        part.toLowerCase() === ".forexplore",
    )
  ) {
    throw new Error(`${label} is not a safe project-relative path.`);
  }
  return value;
}

export function assertTestPath(
  path: string,
  testRoots: readonly string[],
): void {
  const normalizedRoots = testRoots.map((root) => relativePath(root, "test root"));
  if (!normalizedRoots.some((root) => path === root || path.startsWith(`${root}/`))) {
    throw new Error(`Test path is outside the authorized test roots: ${path}`);
  }
}

export function resolveSafePath(root: string, path: string): string {
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, path);
  const outside = relative(canonicalRoot, target);
  if (
    outside === "" ||
    outside === ".." ||
    outside.startsWith(`..${sep}`) ||
    isAbsolute(outside)
  ) {
    throw new Error(`Path escapes the project root: ${path}`);
  }

  let current = canonicalRoot;
  for (const part of path.split("/")) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Linked paths are not allowed: ${path}`);
      }
      if (stat.isFile() && stat.nlink > 1) {
        throw new Error(`Hard-linked files are not allowed: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return target;
}

export async function readProjectFile(
  root: string,
  path: string,
): Promise<string> {
  const target = resolveSafePath(root, path);
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`File does not exist: ${path}`);
    }
    throw error;
  }
  if (bytes.length > MAX_TEXT_FILE_CHARS * 4) {
    throw new Error(`File exceeds the text-file size limit: ${path}`);
  }
  const content = bytes.toString("utf8");
  if (
    content.includes("\0") ||
    content.length > MAX_TEXT_FILE_CHARS ||
    !Buffer.from(content, "utf8").equals(bytes)
  ) {
    throw new Error(`File is not a supported UTF-8 text file: ${path}`);
  }
  return content;
}
