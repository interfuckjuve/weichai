import { lstat, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tool } from "langchain";
import { z } from "zod";
import {
  relativePath,
  resolveSafePath,
  type HostToolFactory,
} from "./common.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;
const NON_SOURCE_DIRECTORIES = new Set([
  ".git", ".forexplore", ".forexpore", ".translation-verifier-tests",
  "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".gradle",
]);

const listFilesSchema = z.strictObject({
  directory: z.string().describe("The authorized directory or one of its project-relative subdirectories."),
  maxResults: z.number().int().min(1).max(MAX_RESULTS).optional(),
});

type ListFilesInput = z.infer<typeof listFilesSchema>;

type ListFilesOutput = {
  files: string[];
  truncated: boolean;
};

function normalizeDirectory(value: string): string {
  if (value === ".") return "";
  return relativePath(value.replace(/\/+$/, ""), "directory");
}

function displayDirectory(directory: string): string {
  return directory === "" ? "." : directory;
}

function isAuthorizedDirectory(
  directory: string,
  authorizedDirectories: readonly string[],
): boolean {
  return authorizedDirectories.some(
    (authorized) =>
      authorized === "" ||
      directory === authorized ||
      directory.startsWith(`${authorized}/`),
  );
}

/** Host-owned authorization: only strategy-selected directories may be listed. */
function authorizeDirectory(
  directory: string,
  authorizedDirectories: readonly string[],
): string {
  if (!isAuthorizedDirectory(directory, authorizedDirectories)) {
    throw new Error(
      `list_files.directory is not authorized: ${displayDirectory(directory)}`,
    );
  }
  return directory;
}

async function collectFiles(
  root: string,
  directory: string,
  maxResults: number,
): Promise<ListFilesOutput> {
  const canonicalRoot = realpathSync(root);
  const start =
    directory === ""
      ? canonicalRoot
      : resolveSafePath(canonicalRoot, directory);
  const startStat = await lstat(start);
  if (!startStat.isDirectory()) {
    throw new Error(
      `list_files.directory is not a directory: ${displayDirectory(directory)}`,
    );
  }

  const files: string[] = [];
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    const hasDotnetProject = entries.some(entry => entry.isFile() && /\.(?:csproj|fsproj|vbproj)$/i.test(entry.name));
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Linked paths are not allowed: ${entry.name}`);
      }
      if (entry.isDirectory()) {
        if (NON_SOURCE_DIRECTORIES.has(entry.name) || (hasDotnetProject && ["bin", "obj"].includes(entry.name))) continue;
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const fileStat = await lstat(absolutePath);
      if (fileStat.nlink > 1) {
        throw new Error(`Hard-linked files are not allowed: ${entry.name}`);
      }
      files.push(relative(canonicalRoot, absolutePath).split(sep).join("/"));
      if (files.length >= maxResults) {
        return { files, truncated: true };
      }
    }
  }
  return { files, truncated: false };
}

export function createListSourceFilesTool(): HostToolFactory {
  return (context) =>
    createListFilesTool(
      "list_source_files",
      context.runtime.sourceProjectPath,
      [context.runtime.sourceDirectory],
      `List ${context.runtime.sourceLanguage} source files recursively under ${context.runtime.sourceDirectory} and its project-relative subdirectories. Start with dependencies of ${context.runtime.sourcePath}.`,
    );
}

export function createListTargetFilesTool(): HostToolFactory {
  return (context) =>
    createListFilesTool(
      "list_target_files",
      context.runtime.targetProjectPath,
      ["."],
      `List ${context.runtime.targetLanguage} target files under the authorized target project, matching read_target_file's project boundary. Use directory '.' to discover sibling contracts, policies and adapters for ${context.runtime.targetPath}; internal journals and build caches are omitted. An exact authorized test root can also be listed.`,
    );
}

export function createListFilesTool(
  name: string,
  root: string,
  allowedDirectories: readonly string[],
  description?: string,
) {
  const directories = [...new Set(allowedDirectories.map(normalizeDirectory))];
  if (directories.length === 0) {
    throw new Error(`${name} requires at least one authorized directory.`);
  }

  return tool(async ({ directory, maxResults }: ListFilesInput): Promise<ListFilesOutput> => {
    const authorized = authorizeDirectory(normalizeDirectory(directory), directories);
    return collectFiles(root, authorized, maxResults ?? DEFAULT_MAX_RESULTS);
  }, {
    name,
    description:
      description ??
      `List files recursively under these strategy-selected directories and their subdirectories: ${directories.map(displayDirectory).join(", ")}.`,
    schema: listFilesSchema,
  });
}
