/**
 * 统一策略入口工厂:按 TestStrategy 分发到四个 runner。
 * Task 4/5 的 quality 适配器经此入口调用(自主模式),产出契约不变。
 */
import { createAidRunner } from "./aid-runner.js";
import { createDistinctRunner } from "./distinct-runner.js";
import { createMitgenRunner } from "./mitgen-runner.js";
import { createSmokeRunner } from "./smoke-runner.js";
import type { StrategyLlmConfig } from "./helpers.js";
import type { StrategyRunOptions, TestStrategy, TestStrategyRunner } from "./types.js";

export type { StrategyLlmConfig } from "./helpers.js";
export { defaultSandbox, makeClaudeOptions, repoRoot } from "./helpers.js";
export { createSmokeRunner } from "./smoke-runner.js";
export { createDistinctRunner } from "./distinct-runner.js";
export { createAidRunner } from "./aid-runner.js";
export { createMitgenRunner } from "./mitgen-runner.js";
export type {
  StrategyRunOptions,
  StrategyStatus,
  TestStrategy,
  TestStrategyJob,
  TestStrategyReport,
  TestStrategyRunner,
} from "./types.js";

export type StrategyFactoryOptions = StrategyRunOptions & { llm: StrategyLlmConfig };

/** 工厂:非法策略 throw。 */
export function createTestStrategy(strategy: TestStrategy, options: StrategyFactoryOptions): TestStrategyRunner {
  switch (strategy) {
    case "smoke":
      return createSmokeRunner(options);
    case "distinct":
      return createDistinctRunner(options);
    case "aid":
      return createAidRunner(options);
    case "mitgen":
      return createMitgenRunner(options);
    default: {
      const never: never = strategy;
      throw new Error(`未知策略:${String(never)}`);
    }
  }
}
