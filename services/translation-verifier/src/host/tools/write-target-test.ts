import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assertTestPath,
  relativePath,
  resolveSafePath,
  type HostTool,
  type HostToolFactory,
  type ToolContext,
  MAX_TEXT_FILE_CHARS,
} from "./common.js";

export type WriteTargetTestInput = {
  path: string;
  content: string;
};

export type WriteTargetTestOutput = {
  path: string;
};

function parseWriteTargetTestInput(value: unknown): WriteTargetTestInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !("path" in value) ||
    !("content" in value)
  ) {
    throw new Error("write_target_test requires only path and content.");
  }
  const input = value as { path: unknown; content: unknown };
  const path = relativePath(input.path, "test path");
  if (typeof input.content !== "string") {
    throw new Error("write_target_test.content must be a string.");
  }
  if (
    input.content.includes("\0") ||
    input.content.length > MAX_TEXT_FILE_CHARS
  ) {
    throw new Error("Test content is invalid or exceeds the text-file size limit.");
  }
  return { path, content: input.content };
}

function rootsDescription(testRoots: readonly string[]): string {
  return testRoots.length > 0 ? testRoots.join(", ") : "(none)";
}

export function createWriteTargetTestTool(): HostToolFactory {
  return (context: ToolContext): HostTool<WriteTargetTestInput, WriteTargetTestOutput> => {
    const testRoots = context.runtime.testRoots.map((root) =>
      relativePath(root, "test root"),
    );
    if (testRoots.length === 0) {
      throw new Error("write_target_test requires at least one test root.");
    }

    return {
      name: "write_target_test",
      description: `Create or update a focused ${context.runtime.targetLanguage} target test under these project-relative test roots: ${rootsDescription(testRoots)}.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
      parse: parseWriteTargetTestInput,
      async execute(input) {
        context.budget?.assertActive();
        const path = relativePath(input.path, "test path");
        assertTestPath(path, testRoots);
        const target = resolveSafePath(context.runtime.targetProjectPath, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, input.content, { encoding: "utf8" });
        context.state.lastTargetTest = undefined;
        return { path };
      },
    };
  };
}
