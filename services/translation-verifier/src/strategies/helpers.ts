/**
 * 策略 runner 共享辅助:默认沙箱组装 + ClaudeClientOptions 组装。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeClientOptions, SpawnClaude } from "../claude-client.js";
import type { TestStrategyJob } from "./types.js";

/**
 * 本包根目录(services/translation-verifier):默认 workspaceRoot = <packageRoot>/test-results。
 * spec §7 新增 .gitignore 忽略 test-results/。
 */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 兼容别名(历史导出名 repoRoot 指向包根,保持公共签名;新代码请用 packageRoot)。
 */
export const repoRoot = packageRoot;

/**
 * runner 的 LLM 配置(比 brief 的三字段多一个可选 spawnClaude,用于测试注入 fake;
 * 生产缺省时 makeClaudeOptions 不设该字段,runClaude 回落 child_process.spawn 封装)。
 */
export interface StrategyLlmConfig {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** 注入的 spawn 实现(测试=捕获参数断言;缺省=child_process.spawn)。 */
  spawnClaude?: SpawnClaude;
}

export interface SandboxSpec {
  readOnlyDirs: string[];
  writableDir: string;
}

/**
 * 默认沙箱:readOnlyDirs = [job.source.root, job.target.root] 过滤空值去重后 resolve;
 * writableDir = 工作目录(绝对值)。调用方可通过 options.claudeSandbox 整体覆盖。
 */
export function defaultSandbox(job: TestStrategyJob, writableDir: string): SandboxSpec {
  const readOnlyDirs = [...new Set([job.source.root, job.target.root].filter((d): d is string => Boolean(d)))].map((d) => resolve(d));
  return { readOnlyDirs, writableDir: resolve(writableDir) };
}

/**
 * 组装 claude 自主会话参数(brief Interfaces;Ruling 1 env):
 * - cwd = writableDir;addDirs = 只读参考目录 + 工作目录;readOnlyDirs = 参考目录;
 * - permissionMode acceptEdits;maxTurns;hooksLogPath = stepsLogPath;
 * - allowedTools 放行 Bash 编译/运行命令(spec §2 实测:headless 下需 --allowedTools
 *   "Bash(javac *)" 等,否则 claude 的 javac/java/dotnet 调用被权限层拦截);
 * - env 注入 JAVA_HOME(claude 子进程定位 JDK 的坑,已实测);未设置时省略该键
 *   (空串会破坏 $JAVA_HOME/bin/javac 全路径约定;省略后子进程回落 PATH 查找 javac)。
 */
export const DEFAULT_ALLOWED_TOOLS = [
  "Bash(javac *)",
  "Bash(java *)",
  "Bash(dotnet *)",
  "Bash(python3 *)",
  "Bash(tsx *)",
] as const;

export function makeClaudeOptions(
  llm: StrategyLlmConfig,
  sandbox: SandboxSpec,
  stepsLogPath: string,
  maxTurns: number,
): ClaudeClientOptions {
  return {
    apiKey: llm.apiKey,
    model: llm.model,
    timeoutMs: llm.timeoutMs,
    ...(llm.spawnClaude ? { spawnClaude: llm.spawnClaude } : {}),
    cwd: sandbox.writableDir,
    addDirs: [...sandbox.readOnlyDirs, sandbox.writableDir],
    readOnlyDirs: sandbox.readOnlyDirs,
    permissionMode: "acceptEdits",
    maxTurns,
    hooksLogPath: stepsLogPath,
    allowedTools: [...DEFAULT_ALLOWED_TOOLS],
    env: process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {},
  };
}

/** 默认工作区根目录。 */
export function defaultWorkspaceRoot(): string {
  return join(packageRoot, "test-results");
}
