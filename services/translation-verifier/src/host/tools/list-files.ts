import { lstat, readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  relativePath,
  resolveSafePath,
  type HostTool,
  type HostToolFactory,
} from "./common.js";

const DEFAULT_MAX_RESULTS = 100;
const MAX_RESULTS = 500;

type ListFilesInput = {
  directory: string;
  maxResults?: number;
};

type ListFilesOutput = {
  files: string[];
  truncated: boolean;
};

function normalizeDirectory(value: string): string {
  if (value === ".") return "";
  return relativePath(value, "directory");
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

function parseListFilesInput(
  value: unknown,
  directories: readonly string[],
): ListFilesInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.keys(value) as string[]).some(
      (key) => key !== "directory" && key !== "maxResults",
    ) ||
    !("directory" in value)
  ) {
    throw new Error("list_files requires directory and optional maxResults.");
  }

  const input = value as { directory: unknown; maxResults?: unknown };
  if (typeof input.directory !== "string") {
    throw new Error("list_files.directory must be a string.");
  }
  const directory = normalizeDirectory(input.directory);
  if (!isAuthorizedDirectory(directory, directories)) {
    throw new Error(
      `list_files.directory is not authorized: ${displayDirectory(directory)}`,
    );
  }

  if (input.maxResults === undefined) {
    return { directory };
  }
  if (
    typeof input.maxResults !== "number" ||
    !Number.isInteger(input.maxResults) ||
    input.maxResults < 1 ||
    input.maxResults > MAX_RESULTS
  ) {
    throw new Error(
      `list_files.maxResults must be an integer from 1 to ${MAX_RESULTS}.`,
    );
  }
  return { directory, maxResults: input.maxResults };
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
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Linked paths are not allowed: ${entry.name}`);
      }
      if (entry.isDirectory()) {
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
      [context.runtime.targetDirectory],
      `List ${context.runtime.targetLanguage} target files recursively under ${context.runtime.targetDirectory} and its project-relative subdirectories. Start with dependencies of ${context.runtime.targetPath}.`,
    );
}

export function createListFilesTool(
  name: string,
  root: string,
  allowedDirectories: readonly string[],
  description?: string,
): HostTool<ListFilesInput, ListFilesOutput> {
  const directories = [...new Set(allowedDirectories.map(normalizeDirectory))];
  if (directories.length === 0) {
    throw new Error(`${name} requires at least one authorized directory.`);
  }

  return {
    name,
    description:
      description ??
      `List files recursively under these strategy-selected directories and their subdirectories: ${directories.map(displayDirectory).join(", ")}.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["directory"],
      properties: {
        directory: {
          type: "string",
          description: "The authorized directory or one of its project-relative subdirectories.",
        },
        maxResults: { type: "integer", minimum: 1, maximum: MAX_RESULTS },
      },
    },
    parse: (input) => parseListFilesInput(input, directories),
    execute: async (input) =>
      collectFiles(
        root,
        input.directory,
        input.maxResults ?? DEFAULT_MAX_RESULTS,
      ),
  };
}
