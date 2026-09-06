/**
 * 「冒烟差分验证」runner:单次 claude 自主会话(print 模式黑盒),
 * 读写全部分布在请求级验证工作区内,编译/运行只经受控命令代理
 * (verifier-command)执行,宿主侧按命令证据(commands.jsonl)裁决。
 *
 * 生产(verify-only)工作区由调用方准备并持有:
 * - workspaceDir(claude cwd/agent 目录)/executionRoot/baselinePath/
 *   commandEvidencePath/runnerRoots 必须作为一套完整路径提供;
 * - 项目根只读,Bash 只允许精确的 verifier-command 形态;
 * - 会话结束后宿主:复查基线 → 读 report.json(verify-only 深校验)→ 读有界
 *   命令证据 → evaluateSmokeReport 归一 pass/fail/unverified;
 * - AbortError 原样上抛(取消不是可验证失败),非取消错误归一 status=error 并
 *   分类到 errorReason。
 * 兼容路径(无 workspaceDir):把旧 root/files 双侧输入内部暂存为 source/project +
 * target/project + 双侧 runner 根 + agent 目录并创建基线,同样只经命令代理。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EffortLevel, SpawnClaude } from "./claude-client.js";
import { runClaude } from "./claude-client.js";
import { evaluateSmokeReport, type SmokeEvaluation } from "./evaluation.js";
import type { CommandEvidence, SmokeMode, SmokeReport } from "./types.js";
import { assertWorkspaceBaseline, createWorkspaceBaseline, writeWorkspaceBaseline } from "./workspace-baseline.js";
import { DEFAULT_DISALLOWED_TOOLS, defaultWorkspaceRoot, VERIFIER_COMMAND_ENTRY } from "./helpers.js";
import { buildSmokeTaskPrompt, type SmokeTaskInput } from "./prompts/task.js";
import { errorSummary, readReport } from "./report.js";
import { assertSmokeReport } from "./report-schema.js";
import { createLogger } from "../../logger.js";
import { createWorkspace, type WorkspaceHandle } from "./workspace.js";

export type SmokeStatus = "pass" | "fail" | "error";

/**
 * error 状态的细分原因(供生产 adapter 映射 advisory unverified):
 * 报告读/深校验失败 invalid-report;证据/基线失败 invalid-evidence;
 * 会话 deadline 到期 timeout;claude/进程环境失败 toolchain;其余 internal。
 */
export type SmokeErrorReason = "invalid-report" | "invalid-evidence" | "timeout" | "toolchain" | "internal";

/** 单次自主会话分钟级,默认超时(ms)。 */
const DEFAULT_TIMEOUT_MS = 300_000;
/** 命令证据 JSONL 有界上限(行数与字节,防御 agent/代理超限产出)。 */
const MAX_EVIDENCE_LINES = 400;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
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

export interface SmokeRunOptions {
  /** 会话模式;默认 "verify-only"(生产)。diagnostic-repair 仅显式诊断 E2E。 */
  mode?: SmokeMode;
  /** 调用方持有的 agent 目录(claude cwd)。提供后本模块不创建/清理工作区。 */
  workspaceDir?: string;
  /** source/target/agent 公共执行根(验证工作区根)。 */
  executionRoot?: string;
  /** 基线文件(baseline.json)。 */
  baselinePath?: string;
  /** 命令证据文件(commands.jsonl,agent 目录内)。 */
  commandEvidencePath?: string;
  /** 双侧专用 runner 根(相对 executionRoot)。 */
  runnerRoots?: readonly [string, string];
  /** 兼容:内部暂存路径下保留工作目录(含 report/claude-steps/runner 源码)。 */
  keepGeneratedTests?: boolean;
  /** 兼容:内部暂存工作区的父根;默认 <packageRoot>/test-results。 */
  workspaceRoot?: string;
  /** 自主会话轮次上限;默认 50。 */
  maxTurns?: number;
  /** DeepSeek API Key;默认 process.env.DEEPSEEK_API_KEY。 */
  apiKey?: string;
  /** 模型;默认 process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash"。 */
  model?: string;
  /** 单次 claude 会话超时;默认 300_000(自主会话分钟级)。 */
  timeoutMs?: number;
  /** 会话思考投入;默认 "low"。 */
  effort?: EffortLevel;
  /** 注入的 spawn 实现(测试=捕获参数断言;缺省=child_process.spawn 封装)。 */
  spawnClaude?: SpawnClaude;
}

export interface SmokeResult {
  status: SmokeStatus;
  /** cases 机械 pass 占比;cases 为空时缺省。 */
  passRate?: number;
  summary: string;
  durationMs: number;
  generatedTestsKept: boolean;
  /** keepGeneratedTests=true(且内部暂存)时保留的工作目录路径。 */
  keptDir?: string;
  /** 校验/评估成功后 report.json 解析出的 SmokeReport。 */
  report: SmokeReport;
  /** 证据与决策评估(报告/证据均有效时存在;status 由其归一)。 */
  evaluation?: SmokeEvaluation;
  /** 硬失败分类(无有效 evaluation 时存在)。 */
  errorReason?: SmokeErrorReason;
}

/** 运行期布局:一次会话的全部固定路径。 */
interface RunLayout {
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

const MUTABLE_FILES = ["agent/report.json", "agent/claude-steps.jsonl", "agent/commands.jsonl"] as const;

/** caller-owned 布局:全部路径已由调用方创建,直接解析。 */
function callerOwnedLayout(options: SmokeRunOptions, job: SmokeTaskInput): RunLayout {
  if (!options.executionRoot || !options.baselinePath || !options.commandEvidencePath || !options.runnerRoots) {
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
    .filter((root): root is string => typeof root === "string" && root.length > 0)
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
function writeSideFiles(projectDir: string, files: Array<{ relativePath: string; content: string }>): void {
  for (const file of files) {
    const dest = resolve(projectDir, file.relativePath);
    if (dest !== projectDir && !dest.startsWith(`${resolve(projectDir)}${"/"}`)) {
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
    throw new Error("runSmoke 暂存源项目失败:缺少 source.files 或可读的 source.root");
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

/** 有界读取命令证据 JSONL:缺失=空数组;超限/坏行抛错(调用方归 invalid-evidence)。 */
export function readCommandEvidence(path: string): CommandEvidence[] {
  let text: string;
  try {
    if (statSync(path).size > MAX_EVIDENCE_BYTES) {
      throw new Error(`命令证据超过大小上限(${MAX_EVIDENCE_BYTES} 字节)`);
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) return [];
    throw error;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > MAX_EVIDENCE_LINES) {
    throw new Error(`命令证据行数超过上限(${MAX_EVIDENCE_LINES})`);
  }
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as CommandEvidence;
    } catch {
      throw new Error(`命令证据第 ${index + 1} 行不是合法 JSON`);
    }
  });
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** 硬失败分类(报告/证据类错误在调用点已精确归类,此处兜底运行层失败)。 */
function classifyRunError(error: unknown): SmokeErrorReason {
  const message = errorSummary(error);
  if (/^runSmoke[\s:：]/.test(message)) return "internal"; // 调用契约/暂存失败
  if (/timed out|deadline|超时/i.test(message)) return "timeout";
  if (/claude subprocess|DEEPSEEK_API_KEY|spawn/i.test(message)) return "toolchain";
  if (/报告|report|证据|evidence|baseline|commands\.jsonl/i.test(message)) return "invalid-evidence";
  return "internal";
}

/**
 * 运行一次 smoke 差分验证(verify-only 生产路径)。
 * 任何非取消异常均归一 status=error 并带 errorReason;AbortError 清理后原样上抛。
 */
export async function runSmoke(
  job: SmokeTaskInput,
  options: SmokeRunOptions = {},
  signal?: AbortSignal,
): Promise<SmokeResult> {
  const started = performance.now();
  const mode = options.mode ?? "verify-only";
  const keep = options.keepGeneratedTests ?? false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = createLogger("smoke-runner");
  let ws: WorkspaceHandle | null = null;

  const finish = (
    partial: Pick<SmokeResult, "status" | "summary" | "report"> &
      Partial<Pick<SmokeResult, "passRate" | "evaluation" | "errorReason">>,
  ): SmokeResult => {
    const result: SmokeResult = {
      ...partial,
      durationMs: performance.now() - started,
      generatedTestsKept: keep,
      keptDir: ws !== null && keep ? ws.dir : undefined,
    };
    logger.info(`smoke ${mode} finished: status=${result.status} durationMs=${Math.round(result.durationMs)}ms summary=${truncateForLog(result.summary, 200)}`);
    return result;
  };

  try {
    const layout: RunLayout =
      options.workspaceDir !== undefined
        ? callerOwnedLayout(options, job)
        : (() => {
            ws = createWorkspace(options.workspaceRoot ?? defaultWorkspaceRoot());
            return stagedLayout(job, ws);
          })();
    signal?.throwIfAborted();

    // 兼容暂存把双侧输入搬到请求级项目副本,提示/上下文一律指向暂存根。
    const promptJob: SmokeTaskInput =
      options.workspaceDir !== undefined
        ? job
        : {
            ...job,
            source: { ...job.source, root: layout.projectRoots[0] ?? job.source.root },
            target: { ...job.target, root: layout.projectRoots[1] ?? job.target.root },
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
    const prompt = [
      buildSmokeTaskPrompt(promptJob, mode),
      executionContextSection(promptJob, layout),
    ].join("\n\n");

    await runClaude(prompt, llm);

    let report: SmokeReport;
    try {
      report = await readReport<SmokeReport>(layout.agentDir, (raw) => assertSmokeReport(raw, mode));
    } catch (error) {
      return finish({ status: "error", summary: errorSummary(error), report: {} as SmokeReport, errorReason: "invalid-report" });
    }
    try {
      // 会话结束后复查基线:受保护文件被改/影子源码出现在 runner 区外即不可信。
      assertWorkspaceBaseline(layout.executionRoot, layout.baselinePath);
      const evidence = readCommandEvidence(layout.evidencePath);
      const evaluation = evaluateSmokeReport(report, evidence, mode);
      const status: SmokeStatus =
        evaluation.status === "pass" ? "pass" : evaluation.status === "fail" ? "fail" : "error";
      const passRate =
        report.cases.length === 0
          ? undefined
          : report.cases.filter((item) => item.mechanical === "pass").length / report.cases.length;
      return finish({ status, passRate, summary: evaluation.summary, report, evaluation });
    } catch (error) {
      // 基线/证据失败(含 evaluateSmokeReport 内部不变量)归 invalid-evidence。
      return finish({ status: "error", summary: errorSummary(error), report, errorReason: "invalid-evidence" });
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    return finish({ status: "error", summary: errorSummary(error), report: {} as SmokeReport, errorReason: classifyRunError(error) });
  } finally {
    // 内部暂存工作区按 keep 策略清理;caller-owned(workspaceDir)永不清理。
    if (ws !== null && !keep) ws.cleanup();
  }
}

function truncateForLog(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

/** 运行期执行上下文(注入绝对路径与唯一 Bash 形态),由宿主在 prompt 后附加。 */
function executionContextSection(job: SmokeTaskInput, layout: RunLayout): string {
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
