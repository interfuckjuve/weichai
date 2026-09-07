import { cpSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { markVerificationPhase } from "../../verification-timing.js";
import {
  createWorkspaceBaseline,
  writeWorkspaceBaseline,
} from "./workspace-baseline.js";
import { DEFAULT_DISALLOWED_TOOLS, VERIFIER_COMMAND_ENTRY } from "./helpers.js";
import { buildSmokeTaskPrompt, type SmokeTaskInput } from "./prompts/task.js";
import type { WorkspaceHandle } from "./workspace.js";
import type { SmokeRunOptions } from "./runner.js";

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

function canonicalRunnerRoots(): readonly [string, string] {
  return ["source/.forexplore-tests", "target/.forexplore-tests"] as const;
}

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
  const runnerRoots = canonicalRunnerRoots();
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

export function prepareAgentTask(
  job: SmokeTaskInput,
  options: SmokeRunOptions,
  ws: WorkspaceHandle | null,
  signal?: AbortSignal,
) {
  const mode = options.mode ?? "verify-only";
  const timeoutMs = options.timeoutMs ?? 300_000;
  const layout: RunLayout =
    options.workspaceDir !== undefined
      ? callerOwnedLayout(options, job)
      : stagedLayout(job, ws!);
  signal?.throwIfAborted();

  // 兼容暂存把双侧输入搬到请求级项目副本,提示/上下文一律指向暂存根。
  const promptJob: SmokeTaskInput =
    options.workspaceDir !== undefined
      ? job
      : {
          ...job,
          source: {
            ...job.source,
            root: layout.projectRoots[0] ?? job.source.root,
          },
          target: {
            ...job.target,
            root: layout.projectRoots[1] ?? job.target.root,
          },
        };

  const deadlineAt = Date.now() + timeoutMs;
  const allowedTools = [`Bash(npx tsx ${VERIFIER_COMMAND_ENTRY} *)`];
  const env: Record<string, string> = {
    VERIFIER_WORKSPACE_ROOT: layout.executionRoot,
    VERIFIER_BASELINE_PATH: layout.baselinePath,
    VERIFIER_COMMAND_EVIDENCE_PATH: layout.evidencePath,
    VERIFIER_DEADLINE_AT: String(deadlineAt),
  };
  if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
  const llm = {
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs,
    ...(options.spawnClaude ? { spawnClaude: options.spawnClaude } : {}),
    cwd: layout.agentDir,
    addDirs: [...layout.projectRoots, ...layout.runnerDirs, layout.agentDir],
    readOnlyDirs: layout.projectRoots,
    permissionMode: "acceptEdits" as const,
    maxTurns: options.maxTurns ?? 50,
    ...(options.effort ? { effort: options.effort } : {}),
    hooksLogPath: join(layout.agentDir, "claude-steps.jsonl"),
    allowedTools,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    env,
    ...(signal ? { signal } : {}),
    deadlineAt,
  };
  markVerificationPhase("prompt-construction");
  const prompt = [
    buildSmokeTaskPrompt(promptJob, mode),
    executionContextSection(promptJob, layout),
  ].join("\n\n");

  return { layout, prompt, llm };
}

/** 运行期执行上下文(注入绝对路径与唯一 Bash 形态),由宿主在 prompt 后附加。 */
function executionContextSection(
  job: SmokeTaskInput,
  layout: RunLayout,
): string {
  return `EXECUTION CONTEXT (host-injected, authoritative)
- Execution/workspace root: ${layout.executionRoot}
- Source project (READ-ONLY): ${layout.projectRoots[0] ?? "(not resolved)"}
  candidate file: ${job.source.candidatePath ?? "(browse)"}
- Target project (READ-ONLY): ${layout.projectRoots[1] ?? "(not resolved)"}
  target file under test: ${job.target.file ?? "(browse)"}
- Source runner directory (the ONLY writable source area): ${layout.runnerDirs[0]}
- Target runner directory (the ONLY writable target area): ${layout.runnerDirs[1]}
- Agent working directory (write report.json here): ${layout.agentDir}

VERIFIER-COMMAND PROXY (the ONLY allowed Bash form)
Run every compile/run through the proxy; never invoke javac/java/dotnet/python3/tsx directly.
  npx tsx ${VERIFIER_COMMAND_ENTRY} --side source|target --phase compile|run --cwd <rel> -- <command...>
where <rel> is relative to the execution root above (for example "source/project" or
"target/project"). After each proxied command, read the last line of commands.jsonl in
your working directory and copy its commandId plus side/phase/exitCode/durationMs into the
report executions entry. Never invent commandIds or exit codes.`;
}
