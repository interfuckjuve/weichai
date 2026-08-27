/**
 * 统一生成器适配器注册表 + 共享上下文。
 *
 * - GeneratorAdapter 接口在 types.ts(与 quality-spec 2.1 严格对齐);
 * - createAdapter(name, ctx):按名称构造五个适配器(baseline/smoke/distinct/aid/mitgen,
 *   对应 quality-spec 2.4);
 * - countedClaude:把注入的 spawnClaude 包装为「计数版」,统一统计生成过程 LLM 调用次数
 *   (各生成器内部 runClaude 的 apiKey 前置检查要求 llm.apiKey 非空——真实跑传
 *   DEEPSEEK_API_KEY,离线测试传任意占位 key + fake spawnClaude)。
 */
import { spawnClaudeProcess, type ClaudeClientOptions } from "../claude-client.js";
import type { DriverExecutor } from "../executor.js";
import { createLogger, type Logger } from "../logger.js";
import type { GeneratorAdapter, GeneratorName } from "./types.js";
import { BaselineAdapter } from "./adapters/baseline.js";
import { SmokeAdapter } from "./adapters/smoke.js";
import { DistinctAdapter } from "./adapters/distinct.js";
import { AidAdapter } from "./adapters/aid.js";
import { MitGenAdapter } from "./adapters/mitgen.js";

/** 适配器共享上下文:LLM 客户端(可注入 spawnClaude)、执行器(可注入 fake)、logger。 */
export interface AdapterContext {
  /** LLM 客户端配置(apiKey/spawnClaude/timeoutMs 可注入;真实跑缺省 spawnClaudeProcess)。 */
  llm: ClaudeClientOptions;
  /** 执行器(真实=RealDriverExecutor;单测=FakeDriverExecutor)。 */
  executor: DriverExecutor;
  logger?: Logger;
  /** smoke 专属:磁盘文件解析根(默认 process.cwd(),CLI 传仓库根)。 */
  rootDir?: string;
  /** smoke 专属:循环步数上限(默认 40)。 */
  maxSteps?: number;
  /** smoke 专属:修复轮数上限(默认 3)。 */
  maxRounds?: number;
  /** distinct 专属:严格 NLD 裁决(strictNld,默认 false)。 */
  strictNld?: boolean;
  /** aid 专属:生成变体数(默认 2,评估场景成本可控)。 */
  variantCount?: number;
  /** aid 专属:生成器目标输入数(默认 20)。 */
  inputCount?: number;
  /** mitgen 专属:选中片段上限(默认 5)。 */
  maxFragments?: number;
  /** mitgen 专属:每片段候选输入数(默认 3)。 */
  casesPerFragment?: number;
  /** 策略 runner 的自主会话轮数上限(默认各 runner 内部默认值 50)。 */
  maxTurns?: number;
  /** 策略工作区根目录(默认 <repoRoot>/test-results;单测可注入临时目录)。 */
  workspaceRoot?: string;
  /** smoke 专属:策略完成后保留工作目录(keptDir 读取 runner 文件用);默认 false。 */
  keepGeneratedTests?: boolean;
}

/** 全部适配器名(CLI --adapters 合法值)。 */
export const ADAPTER_NAMES: readonly GeneratorName[] = ["baseline", "smoke", "distinct", "aid", "mitgen"];

/** 按名称构造适配器;非法名称抛错。 */
export function createAdapter(name: GeneratorName, ctx: AdapterContext): GeneratorAdapter {
  switch (name) {
    case "baseline":
      return new BaselineAdapter(ctx);
    case "smoke":
      return new SmokeAdapter(ctx);
    case "distinct":
      return new DistinctAdapter(ctx);
    case "aid":
      return new AidAdapter(ctx);
    case "mitgen":
      return new MitGenAdapter(ctx);
    default:
      throw new Error(`未知适配器:${String(name)}(合法值:${ADAPTER_NAMES.join(",")})。`);
  }
}

export function defaultLogger(name: string, ctx: AdapterContext): Logger {
  return ctx.logger ?? createLogger(`quality-${name}`);
}

/**
 * 计数版 spawnClaude 包装:统计 LLM 调用次数(供 meta.llmCalls 成本指标)。
 * reset() 在每次 generateTest 前调用,保证成本 = 单次生成的调用数。
 *
 * Task 4 起适配器把本包装经 createTestStrategy 透传给策略 runner(自主会话
 * 经 makeClaudeOptions 组装 cwd/settingsFile 等第四参数)——包装必须转发全部
 * 四个参数,否则自主会话参数丢失(Task 1 review Important 项同步扩展)。
 */
export interface CountedClaude {
  options: ClaudeClientOptions;
  calls: () => number;
  reset: () => void;
}

export function countedClaude(base: ClaudeClientOptions): CountedClaude {
  let count = 0;
  return {
    options: {
      ...base,
      spawnClaude: async (args, env, timeoutMs, options) => {
        count += 1;
        // base.spawnClaude 缺省时回退真实子进程 spawn(与 runClaude 内部逻辑一致)。
        const spawn = base.spawnClaude ?? spawnClaudeProcess;
        return spawn(args, env, timeoutMs, options);
      },
    },
    calls: () => count,
    reset: () => {
      count = 0;
    },
  };
}
