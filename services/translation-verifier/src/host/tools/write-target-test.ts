import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "langchain";
import { z } from "zod";
import {
  assertTestPath,
  relativePath,
  resolveSafePath,
  type HostToolFactory,
  type ToolContext,
  MAX_TEXT_FILE_CHARS,
} from "./common.js";

const writeTargetTestSchema = z.strictObject({
  path: z.string(),
  content: z.string(),
});

export type WriteTargetTestInput = z.infer<typeof writeTargetTestSchema>;

export type WriteTargetTestOutput = {
  path: string;
};

function rootsDescription(testRoots: readonly string[]): string {
  return testRoots.length > 0 ? testRoots.join(", ") : "(none)";
}

export function createWriteTargetTestTool(): HostToolFactory {
  return (context: ToolContext) => {
    const testRoots = context.runtime.testRoots.map((root) =>
      relativePath(root, "test root"),
    );
    if (testRoots.length === 0) {
      throw new Error("write_target_test requires at least one test root.");
    }

    return tool(async ({ path, content }: WriteTargetTestInput): Promise<WriteTargetTestOutput> => {
      context.budget?.assertActive();
      // Write authorization and the text-file size limit stay Host-owned.
      const testPath = relativePath(path, "test path");
      assertTestPath(testPath, testRoots);
      if (
        content.includes("\0") ||
        content.length > MAX_TEXT_FILE_CHARS
      ) {
        throw new Error("Test content is invalid or exceeds the text-file size limit.");
      }
      const target = resolveSafePath(context.runtime.targetProjectPath, testPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8" });
      return { path: testPath };
    }, {
      name: "write_target_test",
      description: `Create or update any ${context.runtime.targetLanguage} test or fixture inside this dedicated project-relative test folder: ${rootsDescription(testRoots)}. Existing files in this folder may be edited; files elsewhere in the test framework's directories are not writable.`,
      schema: writeTargetTestSchema,
    });
  };
}
