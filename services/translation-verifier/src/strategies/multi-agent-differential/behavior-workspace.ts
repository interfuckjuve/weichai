import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import type { VerificationInput } from "../../schemas/verification-types.js";
import type {
  VerificationArtifact,
  VerificationStrategyContext,
} from "../../schemas/verification-types.js";

export const TEST_DIRECTORY = ".forexplore-tests";
export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}
export function assertProjectRoots(context: VerificationStrategyContext): void {
  const { sourceRoot, targetRoot, strategyRoot } = context.workspace;
  const roots = [sourceRoot, targetRoot, strategyRoot].map((root) => {
    if (
      !isAbsolute(root) ||
      !lstatSync(root).isDirectory() ||
      lstatSync(root).isSymbolicLink()
    )
      throw new Error("Expected existing absolute project directories.");
    return realpathSync(root);
  });
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++)
      if (inside(roots[i], roots[j]) || inside(roots[j], roots[i]))
        throw new Error("Project and artifact directories must not overlap.");
}
export interface BehaviorProjectBaseline {
  root: string;
  files: Record<string, string>;
  hash: string;
}

const ROOT_BUILD_DIRECTORIES = new Set([
  TEST_DIRECTORY,
  "target",
  "build",
  "dist",
  "out",
  "coverage",
  "test-results",
  ".git",
]);
const CACHE_DIRECTORIES = new Set([
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".venv",
]);

function projectFiles(root: string): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  const walk = (directory: string): void => {
    const names = readdirSync(directory).sort();
    const dotnetProject = names.some((name) => /\.(cs|fs|vb)proj$/i.test(name));
    const projectRoot =
      directory === root ||
      dotnetProject ||
      names.some((name) =>
        [
          "pom.xml",
          "package.json",
          "build.gradle",
          "build.gradle.kts",
          "Cargo.toml",
        ].includes(name),
      );
    for (const name of names) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (
        stat.isDirectory() &&
        ((projectRoot && ROOT_BUILD_DIRECTORIES.has(name)) ||
          CACHE_DIRECTORIES.has(name) ||
          name.endsWith(".egg-info") ||
          (dotnetProject && ["bin", "obj"].includes(name)))
      )
        continue;
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(`Unsupported project entry: ${relative(root, path)}`);
      if (stat.isDirectory()) walk(path);
      else {
        if (stat.nlink > 1)
          throw new Error("Hard-linked project files are not isolated copies.");
        files[relative(root, path).split(sep).join("/")] = hashContent(
          JSON.stringify([stat.mode, hashContent(readFileSync(path))]),
        );
      }
    }
  };
  walk(root);
  return files;
}

export function captureProjectBaseline(root: string): BehaviorProjectBaseline {
  const files = projectFiles(root);
  return { root, files, hash: hashContent(JSON.stringify(files)) };
}

export function isProjectTestPath(path: string): boolean {
  const parts = path.split("/");
  return (
    path.startsWith(`${TEST_DIRECTORY}/`) ||
    /(?:^|\/)src\/test\//.test(path) ||
    /(?:^|\/)(?:tests|test)\//.test(path) ||
    parts.slice(0, -1).some((part) => /\.Tests?$/i.test(part)) ||
    /(?:[._](?:test|spec)\.[^/]+|_test\.[^/]+)$/.test(path) ||
    /^test_[^/]+$/.test(parts.at(-1)!)
  );
}

/** Existing code and tests stay immutable; only new test files and build outputs are allowed. */
export function assertProjectBaseline(baseline: BehaviorProjectBaseline): void {
  const current = projectFiles(baseline.root);
  for (const [path, hash] of Object.entries(baseline.files)) {
    if (current[path] !== hash)
      throw new Error(`Project baseline changed: ${path}`);
  }
  for (const path of Object.keys(current)) {
    if (!Object.hasOwn(baseline.files, path) && !isProjectTestPath(path))
      throw new Error(`New file outside project test directories: ${path}`);
  }
}

export function projectHash(root: string): string {
  return captureProjectBaseline(root).hash;
}
export function prepareTestDirectory(root: string): string {
  const path = join(root, TEST_DIRECTORY);
  // Do not reuse possibly attacker-controlled stale runners or artifacts.
  mkdirSync(path);
  return path;
}
export function readTestFile(root: string, name: string): string {
  if (
    isAbsolute(name) ||
    name.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)
  )
    throw new Error("Unsafe test file path.");
  const file = resolve(root, name);
  const realRoot = realpathSync(root);
  let current = realRoot;
  for (const part of name.split(/[\\/]/)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Invalid linked test path.");
  }
  const stat = lstatSync(file);
  if (
    !inside(realRoot, realpathSync(file)) ||
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > 1024 * 1024
  )
    throw new Error("Invalid or oversized test file.");
  return readFileSync(file, "utf8");
}
/** Bind caller-owned directories to the exact submitted source and translation. */
export function assertDeclaredSnapshot(
  input: VerificationInput,
  root: string,
  side: "source" | "target",
): void {
  const expected = new Map<string, string>();
  if (side === "source") {
    for (const file of input.request.sourceBundle.files)
      expected.set(file.path, file.content);
  } else {
    for (const file of input.request.targetContext.sourceFiles) {
      if (typeof file.path === "string" && typeof file.content === "string")
        expected.set(file.path, file.content);
    }
    for (const patch of input.translation.files) {
      if (patch.status === "created") {
        if (expected.has(patch.path))
          throw new Error("Created patch overlaps target context.");
        expected.set(patch.path, newFileContent(patch.hunks));
      } else {
        const original = expected.get(patch.path);
        if (
          original === undefined ||
          hashContent(original) !== patch.expectedOriginalSha256
        )
          throw new Error("Patch original does not match target context.");
        expected.set(patch.path, applyHunksStrict(original, patch.hunks));
      }
    }
  }
  for (const [path, content] of expected) {
    if (path.split(/[\\/]/)[0] === TEST_DIRECTORY)
      throw new Error("Declared implementation overlaps the test directory.");
    if (readTestFile(root, path) !== content)
      throw new Error(
        `${side} copy differs from the submitted snapshot: ${path}`,
      );
  }
}
export async function persistBehaviorArtifact(
  context: VerificationStrategyContext,
  id: string,
  content: unknown,
): Promise<VerificationArtifact> {
  const path = `${id}.json`;
  writeFileSync(
    join(context.workspace.strategyRoot, path),
    `${JSON.stringify(content, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return context.writeArtifact({
    id,
    kind: id,
    path,
    contentHash: "0".repeat(64),
    mediaType: "application/json",
  });
}
