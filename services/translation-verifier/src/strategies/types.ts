/**
 * 统一策略入口的类型契约(spec §5.1)。
 *
 * 报告 detail 的类型来自各方向模块(SmokeReport / ConsistencyResult / AIDVerificationReport
 * / MitGenResult);Task 4 目录迁移后自新位置导入。
 */
import type { VerifierLanguage } from "../description.js";
import type { SideFile } from "../executor.js";
import type { SmokeReport } from "../smoke/smoke-types.js";
import type { ConsistencyResult } from "../distinct/consistency-verifier-types.js";
import type { AIDVerificationReport } from "../aid/aid-verifier.js";
import type { MitGenResult } from "../mitgen/types.js";

export type TestStrategy = "smoke" | "distinct" | "aid" | "mitgen";

export interface StrategySide {
  language: VerifierLanguage;
  files?: SideFile[];
  root?: string; // 仓库/项目根目录(默认注入为只读参考目录)
}

export interface TestStrategyJob {
  requirement: string;
  source: StrategySide;
  target: StrategySide & { className: string; method: string; isStatic: boolean; file?: string };
}

export interface StrategyRunOptions {
  keepGeneratedTests?: boolean; // 默认 false
  workspaceRoot?: string; // 默认 <packageRoot>/test-results
  claudeSandbox?: { readOnlyDirs: string[]; writableDir?: string };
  maxTurns?: number; // 默认 50
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export type StrategyStatus = "pass" | "fail" | "unverified" | "error";

export interface TestStrategyReport {
  strategy: TestStrategy;
  status: StrategyStatus;
  passRate?: number;
  summary: string;
  durationMs: number;
  generatedTestsKept: boolean;
  keptDir?: string;
  detail: SmokeReport | ConsistencyResult | AIDVerificationReport | MitGenResult;
}

export interface TestStrategyRunner {
  run(job: TestStrategyJob, signal?: AbortSignal): Promise<TestStrategyReport>;
}
