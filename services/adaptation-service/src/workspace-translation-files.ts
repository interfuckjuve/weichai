import { randomUUID } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync, linkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const maxWorkspaceFileChars = 256_000;

export function validateWorkspacePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path || path.length > 1024 ||
    /[\\:\x00-\x1f]/.test(path) || path.split("/").some((part) =>
      !part || part === "." || part === ".." || /[. ]$/.test(part) ||
      [".git", ".forexplore"].includes(part.toLowerCase()))) {
    throw new Error(`Invalid workspace-relative file path: ${String(path)}`);
  }
}

/** No symlink traversal: both evidence reads and writes stay in this workspace. */
export class TranslationWorkspaceFiles {
  readonly root: string;
  readonly recordsRoot: string;

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
    if (!lstatSync(this.root).isDirectory()) throw new Error("Workspace root must be a directory.");
    this.recordsRoot = this.checkedPath(".forexplore/workspace-translations", true);
    mkdirSync(this.recordsRoot, { recursive: true });
  }

  private checkedPath(path: string, internal = false): string {
    if (!internal) validateWorkspacePath(path);
    let current = this.root;
    for (const part of path.split("/")) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
          throw new Error(`Unsupported workspace entry: ${path}`);
        }
        if (stat.isFile() && stat.nlink > 1) throw new Error(`Hard-linked file is not supported: ${path}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return current;
  }

  read(path: string): string | null {
    const target = this.checkedPath(path);
    if (!existsSync(target)) return null;
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.size > maxWorkspaceFileChars * 4) {
      throw new Error(`Not a supported text file: ${path}`);
    }
    const bytes = readFileSync(target);
    const content = bytes.toString("utf8");
    if (content.includes("\0") || content.length > maxWorkspaceFileChars ||
      !Buffer.from(content, "utf8").equals(bytes)) throw new Error(`Not a supported UTF-8 file: ${path}`);
    return content;
  }

  write(path: string, expected: string | null, content: string | null): void {
    if (content !== null && (content.length > maxWorkspaceFileChars || content.includes("\0"))) {
      throw new Error("File content exceeds the text-file limit.");
    }
    const target = this.checkedPath(path);
    if (this.read(path) !== expected) throw new Error(`File changed outside this task: ${path}`);
    if (content === null) {
      if (expected !== null) unlinkSync(target);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    this.checkedPath(path);
    const temporary = join(dirname(target), `.forexplore-write-${randomUUID()}`);
    try {
      writeFileSync(temporary, content, {
        encoding: "utf8", flag: "wx", mode: expected === null ? 0o644 : lstatSync(target).mode,
      });
      if (this.read(path) !== expected) throw new Error(`File changed outside this task: ${path}`);
      if (expected === null) {
        // Exclusive publication cannot overwrite a file created during this write.
        linkSync(temporary, target);
      } else {
        renameSync(temporary, target);
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  save(id: string, value: unknown): void {
    this.recordPath(id);
    const temporary = this.checkedPath(`.forexplore/workspace-translations/${id}.${randomUUID()}.tmp`, true);
    try {
      writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, this.recordPath(id));
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  load(id: string): unknown {
    const path = this.recordPath(id);
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  }

  private recordPath(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid translation run ID.");
    return this.checkedPath(`.forexplore/workspace-translations/${id}.json`, true);
  }
}
