/** smoke runner 使用的目录、代理入口与工具约束常量。 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 本包根目录(services/translation-verifier):默认工作区根 = <packageRoot>/test-results,
 * 由仓库根 .gitignore 忽略。
 */
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * 默认禁用的计划/记账工具:自主会话实测会空转 TaskCreate/TaskUpdate 记账
 * (单轮 ~10s LLM 延迟),禁用以把回合花在实质工作上。
 */
export const DEFAULT_DISALLOWED_TOOLS = ["TaskCreate", "TaskUpdate"] as const;

/** 默认工作区根目录(<packageRoot>/test-results)。 */
export function defaultWorkspaceRoot(): string {
  return join(packageRoot, "test-results");
}

/** 受控命令代理入口;Bash 允许的唯一工具形态的绝对路径。 */
export const VERIFIER_COMMAND_ENTRY = join(packageRoot, "src", "strategies", "smoke-differential", "controlled-test-command.ts");
