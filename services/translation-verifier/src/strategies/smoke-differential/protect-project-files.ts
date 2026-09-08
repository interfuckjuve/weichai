/**
 * 请求级验证工作区文件基线(shared standard-library helpers)。
 *
 * 类型 WorkspaceBaseline 声明在 types.ts;本模块提供其唯一
 * 文件系统实现:创建时哈希 workspace 内全部受保护文件,写入 baseline.json;
 * 断言时复查哈希,并只允许专用 runner 根、登记的产物目录和固定可变文件出现
 * 新内容。构建命令代理与 runner 都以本模块为唯一事实源,
 * adaptation-service 不得重复实现。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { SmokeVerificationError } from "./smoke-errors.js";
import type { WorkspaceBaseline } from "./differential-test-types.js";

/** 固定 runner 根(相对 workspaceRoot;双侧 runner 是唯一可写源码区)。 */
const CANONICAL_RUNNER_ROOTS = [
  "source/.forexplore-tests",
  "target/.forexplore-tests",
] as const;

/** 固定可变文件(相对 workspaceRoot;agent 报告/步骤/命令证据)。 */
const CANONICAL_MUTABLE_FILES = [
  "agent/report.json",
  "agent/claude-steps.jsonl",
  "agent/commands.jsonl",
] as const;

/** 登记的可重建产物/缓存目录名(顶层 source|target 项目内任意深度)。 */
const DEFAULT_ARTIFACT_DIRECTORY_NAMES = [
  "node_modules",
  "target",
  "bin",
  "obj",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
] as const;

const BASELINE_FILE_NAME = "baseline.json";

/** 相对 root 的斜杠路径(manifest 与 JSON 内统一 "/")。 */
function slashRelative(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join("/");
}

/** 递归收集目录内的普通文件(绝对路径),跳过符号链接。 */
function listFiles(dir: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isRunnerRootPath(rel: string): boolean {
  return CANONICAL_RUNNER_ROOTS.some(
    (runnerRoot) => rel === runnerRoot || rel.startsWith(`${runnerRoot}/`),
  );
}

function isMutableFilePath(rel: string): boolean {
  return (CANONICAL_MUTABLE_FILES as readonly string[]).includes(rel);
}

/**
 * 顶层 source|target 项目内是否存在登记产物目录段。构建工具会把新文件写进
 * bin/obj/target 等目录,这些位置不出现在 protectedFiles 且在断言时放行。
 */
function isArtifactPath(
  rel: string,
  artifactDirectoryNames: readonly string[],
): boolean {
  if (!rel.startsWith("source/") && !rel.startsWith("target/")) return false;
  const segments = rel.split("/").slice(1); // 去掉顶层 source|target
  return segments.some((segment) => artifactDirectoryNames.includes(segment));
}

function equalTuple(
  actual: readonly string[],
  canonical: readonly string[],
): boolean {
  return (
    actual.length === canonical.length &&
    actual.every((value, index) => value === canonical[index])
  );
}

/**
 * 快照 workspaceRoot 内所有受保护文件(source/target 项目与根元数据),
 * 返回可序列化的 WorkspaceBaseline。runnerRoots/mutableFiles 必须与 smoke
 * 契约固定值一致;artifactDirectoryNames 只描述可被构建重建的产物目录。
 */
export function createWorkspaceBaseline(
  workspaceRoot: string,
  runnerRoots: readonly [string, string],
  mutableFiles: readonly [string, string, string],
  artifactDirectoryNames?: readonly string[],
): WorkspaceBaseline {
  if (!equalTuple(runnerRoots, CANONICAL_RUNNER_ROOTS)) {
    throw new Error(
      `runnerRoots must be the canonical runner roots (${CANONICAL_RUNNER_ROOTS.join(", ")}), got ${runnerRoots.join(", ")}`,
    );
  }
  if (!equalTuple(mutableFiles, CANONICAL_MUTABLE_FILES)) {
    throw new Error(
      `mutableFiles must be the canonical mutable files (${CANONICAL_MUTABLE_FILES.join(", ")}), got ${mutableFiles.join(", ")}`,
    );
  }
  const root = resolve(workspaceRoot);
  const artifactNames = artifactDirectoryNames?.length
    ? [...artifactDirectoryNames]
    : [...DEFAULT_ARTIFACT_DIRECTORY_NAMES];

  const protectedFiles = listFiles(root)
    .map((file) => slashRelative(root, file))
    .filter((rel) => rel !== BASELINE_FILE_NAME)
    .filter((rel) => !isRunnerRootPath(rel))
    .filter((rel) => !isMutableFilePath(rel))
    .filter((rel) => !isArtifactPath(rel, artifactNames))
    .map((rel) => ({
      relativePath: rel,
      sha256: sha256(readFileSync(join(root, ...rel.split("/")))),
    }))
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));

  return {
    schemaVersion: "1.0",
    workspaceRoot: root,
    protectedFiles,
    runnerRoots: [
      ...CANONICAL_RUNNER_ROOTS,
    ] as WorkspaceBaseline["runnerRoots"],
    mutableFiles: [
      ...CANONICAL_MUTABLE_FILES,
    ] as WorkspaceBaseline["mutableFiles"],
    artifactDirectoryNames: artifactNames,
  };
}

/** 把 baseline 写为 workspaceRoot/baseline.json 同构 JSON(path 由调用方给定)。 */
export function writeWorkspaceBaseline(
  path: string,
  baseline: WorkspaceBaseline,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

/**
 * 复查工作区:受保护文件哈希必须不变;受保护文件被删、既有文件被改或
 * runner/产物/可变文件之外出现新文件都会抛错。baseline.json 自身被忽略。
 */
export function assertWorkspaceBaseline(
  workspaceRoot: string,
  baselinePath: string,
): void {
  try {
    const root = resolve(workspaceRoot);
    const raw: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
    const baseline =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
    const protectedFiles = baseline.protectedFiles;
    if (!Array.isArray(protectedFiles)) {
      throw new Error(
        `invalid baseline ${slashRelative(root, baselinePath)}: missing protectedFiles array`,
      );
    }
    const artifactNames = Array.isArray(baseline.artifactDirectoryNames)
      ? (baseline.artifactDirectoryNames as string[])
      : DEFAULT_ARTIFACT_DIRECTORY_NAMES;

    const snapshot = new Map(
      protectedFiles.map(
        (entry: { relativePath?: string; sha256?: string }) => [
          entry.relativePath ?? "",
          entry.sha256 ?? "",
        ],
      ),
    );

    // 1) 既有受保护文件必须仍存在且内容一致。
    for (const [rel, expectedHash] of snapshot) {
      const file = join(root, ...rel.split("/"));
      if (!existsSync(file)) {
        throw new Error(`baseline mismatch: protected file removed: ${rel}`);
      }
      const actualHash = sha256(readFileSync(file));
      if (actualHash !== expectedHash) {
        throw new Error(
          `baseline mismatch: protected file changed: ${rel} (${actualHash.slice(0, 12)} != ${expectedHash.slice(0, 12)})`,
        );
      }
    }

    // 2) 未登记的新文件只允许出现在 runner 根/产物目录/固定可变文件。
    for (const file of listFiles(root)) {
      const rel = slashRelative(root, file);
      if (rel === BASELINE_FILE_NAME || snapshot.has(rel)) continue;
      if (isRunnerRootPath(rel) || isMutableFilePath(rel)) continue;
      if (isArtifactPath(rel, artifactNames)) continue;
      throw new Error(
        `baseline violation: new file outside runner/artifact zones: ${rel}`,
      );
    }
  } catch (error) {
    throw new SmokeVerificationError(
      "workspace_integrity_violation",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
