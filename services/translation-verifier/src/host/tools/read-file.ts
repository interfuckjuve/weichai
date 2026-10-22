import { tool } from "langchain";
import { z } from "zod";
import { readProjectFile, relativePath } from "./common.js";

const readFileSchema = z.strictObject({ path: z.string() });

export type ReadFileInput = z.infer<typeof readFileSchema>;

export type ReadFileOutput = {
  path: string;
  content: string;
};

/** Create a file-reading tool bound to one Host-authorized project root. */
export function createReadFileTool(
  name: string,
  root: string,
  description = "Read one project-relative file under the authorized project root.",
) {
  return tool(async ({ path }: ReadFileInput): Promise<ReadFileOutput> => {
    // The authorization boundary and the text-file limits stay Host-owned.
    const projectPath = relativePath(path);
    return { path: projectPath, content: await readProjectFile(root, projectPath) };
  }, {
    name,
    description,
    schema: readFileSchema,
  });
}
