import {
  readProjectFile,
  relativePath,
  type HostTool,
} from "./common.js";

export type ReadFileInput = {
  path: string;
};

export type ReadFileOutput = {
  path: string;
  content: string;
};

function parseReadFileInput(value: unknown): ReadFileInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("path" in value)
  ) {
    throw new Error("read file input must contain only path.");
  }
  return { path: relativePath((value as { path: unknown }).path) };
}

/** Create a file-reading tool bound to one Host-authorized project root. */
export function createReadFileTool(
  name: string,
  root: string,
  description = "Read one project-relative file under the authorized project root.",
): HostTool<ReadFileInput, ReadFileOutput> {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    parse: parseReadFileInput,
    async execute(input) {
      const path = relativePath(input.path);
      const content = await readProjectFile(root, path);
      return { path, content };
    },
  };
}
