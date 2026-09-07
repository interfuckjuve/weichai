import { cpSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createWorkspaceBaseline, writeWorkspaceBaseline } from "./protect-project-files.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";
import type { WorkspaceHandle } from "./create-smoke-workspace.js";
import type { SmokeRunOptions } from "./run-smoke-verification.js";
import type { VerificationStrategyContext } from "../../schemas/verification-types.js";

/** 内部暂存复制时排除的目录(与验证工作区一致,避免复制重产物/缓存)。 */
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "bin",
  "obj",
  "dist",
  "build",
  "out",
  "coverage",
  "test-results",
]);

/** 运行期布局:一次会话的全部固定路径。 */
export interface RunLayout {
  executionRoot: string;
  agentDir: string;
  baselinePath: string;
  evidencePath: string;
  runnerRoots: readonly [string, string];
  /** 只读项目根(绝对)。 */
  projectRoots: string[];
  /** 可写 runner 根(绝对)。 */
  runnerDirs: string[];
}

export const smokeRunnerRoots = ["source/.forexplore-tests", "target/.forexplore-tests"] as const;

const MUTABLE_FILES = [
  "agent/report.json",
  "agent/claude-steps.jsonl",
  "agent/commands.jsonl",
] as const;

/** caller-owned 布局:全部路径已由调用方创建,直接解析。 */
function callerOwnedLayout(
  options: SmokeRunOptions,
  job: SmokeTaskInput,
): RunLayout {
  if (
    !options.executionRoot ||
    !options.baselinePath ||
    !options.commandEvidencePath ||
    !options.runnerRoots
  ) {
    throw new Error(
      "runSmoke: workspaceDir 模式必须同时提供 executionRoot/baselinePath/commandEvidencePath/runnerRoots",
    );
  }
  const runnerRoots = options.runnerRoots;
  const executionRoot = resolve(options.executionRoot);
  return {
    executionRoot,
    agentDir: resolve(options.workspaceDir!),
    baselinePath: resolve(options.baselinePath),
    evidencePath: resolve(options.commandEvidencePath),
    runnerRoots,
    projectRoots: projectRootsOf(job),
    runnerDirs: runnerRoots.map((root) => resolve(executionRoot, root)),
  };
}

function projectRootsOf(job: SmokeTaskInput): string[] {
  return [job.source.root, job.target.root]
    .filter(
      (root): root is string => typeof root === "string" && root.length > 0,
    )
    .map((root) => resolve(root));
}

/** 递归复制目录(排除 EXCLUDED_DIRECTORIES)。 */
function copyProject(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    filter: (from) => !EXCLUDED_DIRECTORIES.has(from.split("/").pop() ?? from),
  });
}

/** 把 SideFile 列表写入 projectDir(按相对路径,自动建父目录)。 */
function writeSideFiles(
  projectDir: string,
  files: Array<{ relativePath: string; content: string }>,
): void {
  for (const file of files) {
    const dest = resolve(projectDir, file.relativePath);
    if (
      dest !== projectDir &&
      !dest.startsWith(`${resolve(projectDir)}${"/"}`)
    ) {
      throw new Error(`runSmoke 暂存路径逃逸: ${file.relativePath}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content, "utf8");
  }
}

function isReadableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 兼容暂存:在内部工作区(ws.dir)内布局 source/project、target/project、
 * 双侧 runner 根与 agent 目录,写入/复制双侧输入后创建基线。
 * root 提供且可读 → 复制整棵项目;否则退回 files 输入逐文件写入。
 */
function stagedLayout(job: SmokeTaskInput, ws: WorkspaceHandle): RunLayout {
  const executionRoot = ws.dir;
  const sourceProject = join(executionRoot, "source", "project");
  const targetProject = join(executionRoot, "target", "project");
  const agentDir = join(executionRoot, "agent");
  const runnerRoots = smokeRunnerRoots;
  const runnerDirs = runnerRoots.map((root) => join(executionRoot, root));
  mkdirSync(sourceProject, { recursive: true });
  mkdirSync(targetProject, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  for (const dir of runnerDirs) mkdirSync(dir, { recursive: true });

  if (job.source.files && job.source.files.length > 0) {
    writeSideFiles(sourceProject, job.source.files);
  } else if (isReadableDirectory(job.source.root ?? "")) {
    copyProject(resolve(job.source.root!), sourceProject);
  } else {
    throw new Error(
      "runSmoke 暂存源项目失败:缺少 source.files 或可读的 source.root",
    );
  }
  if (isReadableDirectory(job.target.root ?? "")) {
    copyProject(resolve(job.target.root!), targetProject);
  }
  const baselinePath = join(executionRoot, "baseline.json");
  writeWorkspaceBaseline(
    baselinePath,
    createWorkspaceBaseline(executionRoot, runnerRoots, MUTABLE_FILES),
  );
  return {
    executionRoot,
    agentDir,
    baselinePath,
    evidencePath: join(agentDir, "commands.jsonl"),
    runnerRoots,
    projectRoots: [sourceProject, targetProject],
    runnerDirs,
  };
}

export function prepareCallerOwnedWorkspace(context: VerificationStrategyContext): void {
  mkdirSync(context.workspace.strategyRoot, { recursive: true });
  for (const root of smokeRunnerRoots)
    mkdirSync(join(context.workspace.root, root), { recursive: true });
  writeWorkspaceBaseline(
    join(context.workspace.root, "baseline.json"),
    createWorkspaceBaseline(context.workspace.root, smokeRunnerRoots, MUTABLE_FILES),
  );
}

export function prepareSmokeProjects(job: SmokeTaskInput, options: SmokeRunOptions, workspace: WorkspaceHandle | null): RunLayout {
  return options.workspaceDir !== undefined ? callerOwnedLayout(options, job) : stagedLayout(job, workspace!);
}
