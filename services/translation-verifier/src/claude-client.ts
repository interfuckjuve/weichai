import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger, type Logger } from "./logger.js";

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
  /** 子进程工作目录(默认继承父进程)。 */
  cwd?: string;
  /** --settings 临时 settings 文件路径(hooks 配置)。 */
  settingsFile?: string;
  /** --add-dir <dir> ...(可读写目录)。 */
  addDirs?: string[];
  /** --disallowedTools "Edit(//<resolve(dir)>/**)" ...(只读参考目录)。 */
  readOnlyDirs?: string[];
  /** --permission-mode(仅 acceptEdits 时附加该参数)。 */
  permissionMode?: "manual" | "acceptEdits";
  /** --max-turns <N>。 */
  maxTurns?: number;
  /** 注入的 spawn 实现(测试=捕获参数断言;缺省=child_process.spawn)。 */
  spawn?: SpawnClaude;
}

export type SpawnClaude = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  options?: SpawnClaudeOptions,
) => Promise<{ stdout: string; exitCode: number }>;

export interface ClaudeClientOptions {
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
  /** --permission-mode(仅 acceptEdits 时附加该参数)。 */
  permissionMode?: "manual" | "acceptEdits";
  /** --max-turns <N>。 */
  maxTurns?: number;
  /** 生成临时 settings 文件,PostToolUse hook 把每次工具调用 JSON 行追加到该路径。 */
  hooksLogPath?: string;
  /** 附加到子进程 env 的自定义变量(置于 ANTHROPIC_* 覆盖之后,如 JAVA_HOME)。 */
  env?: Record<string, string>;
}

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 以 claude 子进程方式执行 prompt(print 模式),返回 stdout。
 * 无 apiKey(缺省/空/空白)→ 抛错且不调用 spawnClaude;
 * 非零退出码 → 抛错(含 stderr,见 SpawnClaude 结果上的可选 stderr 字段)。
 */
export async function runClaude(prompt: string, options: ClaudeClientOptions = {}): Promise<string> {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("DEEPSEEK_API_KEY is required for claude subprocess requests.");
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
    // 自定义 env(如 JAVA_HOME)置于 ANTHROPIC_* 覆盖之后合并。
    ...options.env,
  };
  logger.debug(`prompt:\n${prompt}`);
  // 自主会话参数:仅显式传入时透传第四参数(无自主选项时维持 3 参数调用)。
  const spawnOptions: SpawnClaudeOptions = {};
  if (options.cwd) spawnOptions.cwd = options.cwd;
  if (options.addDirs) spawnOptions.addDirs = options.addDirs;
  if (options.readOnlyDirs) spawnOptions.readOnlyDirs = options.readOnlyDirs;
  if (options.permissionMode) spawnOptions.permissionMode = options.permissionMode;
  if (options.maxTurns !== undefined) spawnOptions.maxTurns = options.maxTurns;
  let settingsFile: string | undefined;
  if (options.hooksLogPath) {
    // 临时 settings 文件:PostToolUse hook 把每次工具调用 JSON 行追加到 hooksLogPath。
    settingsFile = join(tmpdir(), `fx-hooks-${process.pid}-${Date.now()}.json`);
    buildHooksSettings(settingsFile, options.hooksLogPath);
    spawnOptions.settingsFile = settingsFile;
  }
  const hasAutonomous = Object.keys(spawnOptions).length > 0;
  const args = ["-p", prompt, "--output-format", "text"];
  try {
    const result = hasAutonomous
      ? await spawnClaude(args, env, timeoutMs, spawnOptions)
      : await spawnClaude(args, env, timeoutMs);
    // 返回 stdout 前 500 字符(避免刷屏,截断标记),完整内容以 DEBUG 级可回放。
    logger.debug(`stdout (first 500 chars):\n${truncate(result.stdout, 500)}`);
    if (result.exitCode !== 0) {
      // SpawnClaude 契约仅要求 { stdout, exitCode };注入的 fake 可额外携带
      // stderr 字段,使错误信息包含子进程诊断输出(生产实现同样在内部抛错含 stderr)。
      const stderr = (result as { stderr?: string }).stderr ?? "";
      logger.error(`claude subprocess exited with code ${result.exitCode}: ${stderr}`);
      throw new Error(`claude subprocess exited with code ${result.exitCode}: ${stderr}`);
    }
    return result.stdout;
  } finally {
    // 临时 settings 用完即删(无论成败)。
    if (settingsFile) rmSync(settingsFile, { force: true });
  }
}

/** 截断长文本(如 LLM stdout),附带截断标记。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...[truncated ${text.length - max} chars]`;
}

/**
 * 生产 spawnClaude:组装自主会话参数后 spawn("claude", args) 收集 stdout/stderr,
 * 非零退出码抛错(含 stderr),超时 kill(SIGKILL) 并抛超时错误。
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
  const readOnlyDirs = (options.readOnlyDirs ?? []).map((d) => resolve(d).replace(/^\/+/, ""));
  if (addDirs.length > 0) fullArgs.push("--add-dir", ...addDirs);
  if (readOnlyDirs.length > 0) {
    fullArgs.push("--disallowedTools", ...readOnlyDirs.map((d) => `Edit(//${d}/**)`));
  }
  if (options.permissionMode === "acceptEdits") fullArgs.push("--permission-mode", "acceptEdits");
  if (options.maxTurns !== undefined) fullArgs.push("--max-turns", String(options.maxTurns));
  if (options.settingsFile) fullArgs.push("--settings", options.settingsFile);
  // 注入的 spawn 实现(测试断言用):直接委托,透传 cwd。
  if (options.spawn) {
    return options.spawn(fullArgs, env, timeoutMs, { cwd: options.cwd });
  }
  return new Promise((resolve, reject) => {
    const child = spawn("claude", fullArgs, { env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`claude subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude subprocess exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, exitCode: code ?? 0 });
    });
  });
}

/**
 * 写临时 hooks settings 文件:PostToolUse hook(matcher "*")用 command
 * `cat >> <logPath>` 把每次工具调用的 JSON 行追加到 logPath,返回 settings 文件路径。
 * logPath 用 JSON.stringify 包裹,防路径含空格时被 shell 拆词。
 */
export function buildHooksSettings(settingsPath: string, logPath: string): string {
  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `cat >> ${JSON.stringify(logPath)}`,
            },
          ],
        },
      ],
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
  return settingsPath;
}
