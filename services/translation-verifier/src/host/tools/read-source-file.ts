import { createReadFileTool } from "./read-file.js";
import type { HostToolFactory } from "./common.js";

export function createReadSourceFileTool(): HostToolFactory {
  return (context) =>
    createReadFileTool(
      "read_source_file",
      context.runtime.sourceProjectPath,
      `Read one project-relative file from the read-only ${context.runtime.sourceLanguage} source project. Reference function: ${context.runtime.sourcePath}.`,
    );
}
