/**
 * 策略 runner 共享辅助:默认沙箱组装 + ClaudeClientOptions 组装。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeClientOptions, SpawnClaude } from "../claude-client.js";
import type { TestStrategyJob } from "./types.js";

/**
 * 本包根目录(services/translation-verifier):默认 workspaceRoot = <repoRoot>/test-results。
 * spec §7 新增 .gitignore 忽略 test-results/。
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
 * - env 注入 JAVA_HOME(claude 子进程定位 JDK 的坑,已实测);未设置时注入空串(无害,
 *   子进程仅当实际使用 Java 工具时才需要;生产上通常由调用方 export 后生效)。
 */
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
    env: { JAVA_HOME: process.env.JAVA_HOME ?? "" },
  };
}

/** 默认工作区根目录。 */
export function defaultWorkspaceRoot(): string {
  return join(repoRoot, "test-results");
}
