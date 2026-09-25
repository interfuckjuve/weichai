import { createReadFileTool } from "./read-file.js";
import type { HostToolFactory } from "./common.js";

export function createReadTargetFileTool(): HostToolFactory {
  return (context) =>
    createReadFileTool(
      "read_target_file",
      context.runtime.targetProjectPath,
      `Read one project-relative file from the writable ${context.runtime.targetLanguage} target worktree. Target function: ${context.runtime.targetPath}.`,
    );
}
