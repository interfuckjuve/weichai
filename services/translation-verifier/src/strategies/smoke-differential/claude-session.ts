import { resolve } from "node:path";
import {
  createLogger,
  type Logger,
} from "../../run-output/verification-logger.js";
import { runManagedProcess } from "./manage-test-process.js";
import { isAbortError, SmokeVerificationError } from "./smoke-errors.js";
import { errorSummary } from "./read-test-report.js";

function throwSessionError(error: unknown, signal?: AbortSignal): never {
  signal?.throwIfAborted();
  if (error instanceof SmokeVerificationError || isAbortError(error))
    throw error;
  const timedOut =
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "TimeoutError";
  throw new SmokeVerificationError(
    timedOut ? "agent_timeout" : "agent_error",
    errorSummary(error),
    { cause: error },
  );
}

/** claude 会话思考投入级别(low 快速决策;默认由模型/CLI 决定,历史实测 high)。 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * claude 子进程调度客户端("Claude Code + DeepSeek" agent 架构,与
 * scripts/run-claude-deepseek.sh 一致):通过 ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 系列环境变量,让 claude CLI 直连
 * DeepSeek 的 Anthropic 兼容端点,而非 HTTP 直调 DeepSeek chat/completions。
 *
 * spawnClaude 可注入(测试=预设 stdout/exitCode;生产=spawnClaudeProcess)。
 * 第四参数 options 携带自主会话选项(cwd/沙箱/轮次/hooks settings)。
 */
export interface SpawnClaudeOptions {
  /** Optional live stdout observer; exceptions cannot alter session outcome. */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** 子进程工作目录(默认继承父进程)。 */
  cwd?: string;
  /** --settings 临时 settings 文件路径(hooks 配置)。 */
  settingsFile?: string;
  /** --add-dir <dir> ...(可读写目录)。 */
  addDirs?: string[];
  /** --disallowedTools "Edit(//<resolve(dir)>/**)" ...(只读参考目录)。 */
  readOnlyDirs?: string[];
  /** --allowedTools <pattern> ...(headless 下放行 Bash 编译/运行命令,如 "Bash(javac *)")。 */
  allowedTools?: string[];
  /** --disallowedTools <name> ...(显式禁用的工具,如任务规划 TaskCreate/TaskUpdate)。 */
  disallowedTools?: string[];
  /** --permission-mode(仅 acceptEdits 时附加该参数)。 */
  permissionMode?: "manual" | "acceptEdits";
  /** --max-turns <N>。 */
  maxTurns?: number;
  /** --effort <level> 会话思考投入(默认 CLI/模型决定)。 */
  effort?: EffortLevel;
  /** 注入的 spawn 实现(测试=捕获参数断言;缺省=child_process.spawn)。 */
  spawn?: SpawnClaude;
  /** 取消信号:中止时终止 claude 进程树并以 AbortError 拒绝。 */
  signal?: AbortSignal;
  /** 绝对 deadline(ms 时间戳):有值时会话超时取 deadline 与 timeoutMs 的较早者。 */
  deadlineAt?: number;
}

export type SpawnClaude = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options?: SpawnClaudeOptions,
) => Promise<{ stdout: string; exitCode: number }>;

export interface ClaudeClientOptions {
  /** Selects partial stream-json output only when present. Buffered output is never replayed. */
  onStdoutChunk?: (chunk: Buffer) => void;
  /** DeepSeek API Key;默认 process.env.DEEPSEEK_API_KEY。 */
  apiKey?: string;
  /** 模型;默认 process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash"。 */
  model?: string;
  /** 注入的 spawn 实现;生产=child_process.spawn 封装。 */
  spawnClaude?: SpawnClaude;
  /** 超时(ms);默认 120_000。 */
  timeoutMs?: number;
  /** 注入的 logger;默认 createLogger("claude-client")。 */
  logger?: Logger;
  /** 子进程工作目录(默认继承父进程)。 */
  cwd?: string;
  /** --add-dir <dir> ...(可读写目录)。 */
  addDirs?: string[];
  /** --disallowedTools "Edit(//<resolve(dir)>/**)" ...(只读参考目录)。 */
  readOnlyDirs?: string[];
  /** --allowedTools <pattern> ...(headless 下放行 Bash 编译/运行命令,如 "Bash(javac *)")。 */
  allowedTools?: string[];
  /** --disallowedTools <name> ...(显式禁用的工具,如任务规划 TaskCreate/TaskUpdate)。 */
  disallowedTools?: string[];
  /** --permission-mode(仅 acceptEdits 时附加该参数)。 */
  permissionMode?: "manual" | "acceptEdits";
  /** --max-turns <N>。 */
  maxTurns?: number;
  /** --effort <level> 会话思考投入(默认 CLI/模型决定)。 */
  effort?: EffortLevel;
  /** @deprecated Reserved compatibility option; raw tool hooks are no longer installed. */
  hooksLogPath?: string;
  /** 附加到子进程 env 的自定义变量(置于 ANTHROPIC_* 覆盖之后,如 JAVA_HOME)。 */
  env?: Record<string, string>;
  /** 取消信号:中止时终止 claude 进程树并以 AbortError 拒绝。 */
  signal?: AbortSignal;
  /** 绝对 deadline(ms 时间戳):有值时超时取 deadline 与 timeoutMs 的较早者。 */
  deadlineAt?: number;
}

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 以 claude 子进程方式执行 prompt(print 模式),返回 stdout。
 * 无 apiKey(缺省/空/空白)→ 抛错且不调用 spawnClaude;
 * 非零退出码 → 抛错(含 stderr,见 SpawnClaude 结果上的可选 stderr 字段)。
 */
export async function runClaude(
  prompt: string,
  options: ClaudeClientOptions = {},
): Promise<string> {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new SmokeVerificationError(
      "agent_error",
      "DEEPSEEK_API_KEY is required for claude subprocess requests.",
    );
  }
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnClaude = options.spawnClaude ?? spawnClaudeProcess;
  const logger = options.logger ?? createLogger("claude-client");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    // deepseek 等未知模型名时,新版 claude CLI 会打窗口强制警告并以退出码 1 结束
    // (2026-08-27 实测:自主会话被该警告打断,report.json 未及写入)。置 1 恢复旧行为。
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    // 自定义 env(如 JAVA_HOME)置于 ANTHROPIC_* 覆盖之后合并。
    ...options.env,
  };
  logger.content(`prompt:\n${prompt}`);
  // 自主会话参数:仅显式传入时透传第四参数(无自主选项时维持 3 参数调用)。
  const spawnOptions: SpawnClaudeOptions = {};
  if (options.cwd) spawnOptions.cwd = options.cwd;
  if (options.addDirs) spawnOptions.addDirs = options.addDirs;
  if (options.readOnlyDirs) spawnOptions.readOnlyDirs = options.readOnlyDirs;
  if (options.permissionMode)
    spawnOptions.permissionMode = options.permissionMode;
  if (options.maxTurns !== undefined) spawnOptions.maxTurns = options.maxTurns;
  if (options.effort) spawnOptions.effort = options.effort;
  if (options.allowedTools) spawnOptions.allowedTools = options.allowedTools;
  if (options.disallowedTools)
    spawnOptions.disallowedTools = options.disallowedTools;
  if (options.signal) spawnOptions.signal = options.signal;
  if (options.deadlineAt !== undefined)
    spawnOptions.deadlineAt = options.deadlineAt;
  if (options.onStdoutChunk) {
    spawnOptions.onStdoutChunk = (chunk) => {
      try {
        options.onStdoutChunk!(chunk);
      } catch {
        /* Best-effort metadata only. */
      }
    };
  }
  const hasAutonomous = Object.keys(spawnOptions).length > 0;
  const args = options.onStdoutChunk
    ? [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
      ]
    : ["-p", prompt, "--output-format", "text"];
  let result: Awaited<ReturnType<SpawnClaude>>;
  try {
    result = hasAutonomous
      ? await spawnClaude(args, env, timeoutMs, spawnOptions)
      : await spawnClaude(args, env, timeoutMs);
  } catch (error) {
    throwSessionError(error, options.signal);
  }
  // 完整 stdout 走 content 通道(默认关闭;长度/状态保持 debug 级度量)。
  logger.debug(
    `stdout ${result.stdout.length} chars, exitCode=${result.exitCode}`,
  );
  logger.content(`stdout:\n${result.stdout}`);
  if (result.exitCode !== 0) {
    // Injected clients may also supply stderr; preserve the existing error contract.
    const stderr = (result as { stderr?: string }).stderr ?? "";
    logger.error(
      `claude subprocess exited with code ${result.exitCode}: ${stderr}`,
    );
    throw new SmokeVerificationError(
      "agent_error",
      `claude subprocess exited with code ${result.exitCode}: ${stderr}`,
    );
  }
  return result.stdout;
}

/**
 * 生产 spawnClaude:组装自主会话参数后 spawn("claude", args) 收集 stdout/stderr,
 * 非零退出码抛错(含 stderr),超时终止进程树并抛超时错误;signal 中止时以
 * AbortError(原 signal.reason)拒绝。lifecycle 复用 runManagedProcess(POSIX
 * 独立进程组 + 整树回收 + 有界输出),deadlineAt 有值时与 timeoutMs 取较早者。
 *
 * options.spawn 可注入(测试=捕获参数断言的 fake;缺省=child_process.spawn),
 * cwd 透传到子进程 spawn options。
 */
export async function spawnClaudeProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options: SpawnClaudeOptions = {},
): Promise<{ stdout: string; exitCode: number }> {
  const fullArgs = [...args];
  const addDirs = options.addDirs ?? [];
  // resolve 到绝对路径后去掉首斜杠:权限串为 "Edit(//refA/**)"(claude 约定的项目路径写法)。
  const readOnlyDirs = (options.readOnlyDirs ?? []).map((d) =>
    resolve(d).replace(/^\/+/, ""),
  );
  if (addDirs.length > 0) fullArgs.push("--add-dir", ...addDirs);
  // 合并只读目录派生的 Edit 权限串与显式禁用工具(如任务规划 TaskCreate/TaskUpdate)为同一条规则。
  const disallowed = [
    ...readOnlyDirs.map((d) => `Edit(//${d}/**)`),
    ...(options.disallowedTools ?? []),
  ];
  if (disallowed.length > 0) {
    fullArgs.push("--disallowedTools", ...disallowed);
  }
  if (options.permissionMode === "acceptEdits")
    fullArgs.push("--permission-mode", "acceptEdits");
  if (options.maxTurns !== undefined)
    fullArgs.push("--max-turns", String(options.maxTurns));
  if (options.effort) fullArgs.push("--effort", options.effort);
  // headless 下放行 Bash 编译/运行命令(如 "Bash(javac *)" "Bash(java *)");
  // 未配置时不加任何参数,与现状一致(权限保持默认)。
  if ((options.allowedTools ?? []).length > 0) {
    fullArgs.push("--allowedTools", ...(options.allowedTools as string[]));
  }
  if (options.settingsFile) fullArgs.push("--settings", options.settingsFile);
  // 注入的 spawn 实现(测试断言用):直接委托,透传 cwd。
  try {
    if (options.spawn) {
      return await options.spawn(fullArgs, env, timeoutMs, {
        cwd: options.cwd,
        ...(options.onStdoutChunk
          ? { onStdoutChunk: options.onStdoutChunk }
          : {}),
      });
    }
    const now = Date.now();
    const deadlineAt = Math.min(
      options.deadlineAt ?? Number.POSITIVE_INFINITY,
      now + timeoutMs,
    );
    const effectiveTimeoutMs = Math.max(0, deadlineAt - now);
    const result = await runManagedProcess(
      {
        command: "claude",
        args: fullArgs,
        cwd: options.cwd ?? process.cwd(),
        env,
        deadlineAt,
        onStdoutChunk: options.onStdoutChunk,
      },
      options.signal,
    );
    if (result.timedOut) {
      throw new SmokeVerificationError(
        "agent_timeout",
        `claude subprocess timed out after ${effectiveTimeoutMs}ms`,
      );
    }
    if (result.exitCode !== 0) {
      throw new SmokeVerificationError(
        "agent_error",
        `claude subprocess exited with code ${result.exitCode}: ${result.stderr}`,
      );
    }
    return { stdout: result.stdout, exitCode: result.exitCode ?? 0 };
  } catch (error) {
    throwSessionError(error, options.signal);
  }
}
