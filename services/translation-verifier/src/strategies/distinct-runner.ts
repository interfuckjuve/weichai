/**
 * 方向 2「分支一致性验证(DISTINCT)」runner:claude 自主单次调用,
 * 读 <workspace>/report.json(ConsistencyResult)归一化 status/passRate/summary。
 */
import { runClaude } from "../claude-client.js";
import type { ConsistencyResult } from "../consistency-verifier.js";
import { defaultSandbox, defaultWorkspaceRoot, makeClaudeOptions, type StrategyLlmConfig } from "./helpers.js";
import { buildDistinctTaskPrompt } from "./prompts/distinct-task.js";
import { errorSummary, readReport } from "./report.js";
import type { StrategyRunOptions, StrategyStatus, TestStrategyJob, TestStrategyReport, TestStrategyRunner } from "./types.js";
import { createWorkspace } from "./workspace.js";

export interface DistinctRunnerOptions extends StrategyRunOptions {
  llm: StrategyLlmConfig;
}

export function createDistinctRunner(options: DistinctRunnerOptions): TestStrategyRunner {
  return {
    async run(job: TestStrategyJob, signal?: AbortSignal): Promise<TestStrategyReport> {
      const started = performance.now();
      const ws = createWorkspace(options.workspaceRoot ?? defaultWorkspaceRoot(), "distinct");
      const keep = options.keepGeneratedTests ?? false;
      const finish = (
        partial: Pick<TestStrategyReport, "status" | "summary" | "detail"> & Partial<Pick<TestStrategyReport, "passRate">>,
      ): TestStrategyReport => ({
        strategy: "distinct",
        ...partial,
        durationMs: performance.now() - started,
        generatedTestsKept: keep,
        keptDir: keep ? ws.dir : undefined,
      });
      try {
        if (signal?.aborted) throw new Error("策略运行已中止(aborted)");
        const sandbox = options.claudeSandbox ?? defaultSandbox(job, ws.dir);
        // Ruling 6:直接调 runClaude(不经 countedClaude)。
        const llm = makeClaudeOptions(options.llm, { ...sandbox, writableDir: sandbox.writableDir ?? ws.dir }, ws.stepsLogPath, options.maxTurns ?? 50);
        const prompt = buildDistinctTaskPrompt(job);
        await runClaude(prompt, llm);
        const detail = await readReport<ConsistencyResult>(ws.dir);
        // 归一化(brief §3.3):ConsistencyResult 无 converged 字段(brief 注明按实际字段调整);
        // 收敛判据映射为「差分报告无失败用例」→ pass,否则 fail。passRate 取 report.passRate。
        const status: StrategyStatus = detail.report.failedCases === 0 ? "pass" : "fail";
        const passRate = detail.report.passRate;
        const summary = `差分验证:passRate=${detail.report.passRate.toFixed(3)},pass=${detail.report.passedCases},fail=${detail.report.failedCases},divergent=${detail.report.divergentCases},total=${detail.report.totalCases},augmented=${detail.augmented}`;
        if (!keep) ws.cleanup();
        return finish({ status, passRate, summary, detail });
      } catch (error) {
        const summary = errorSummary(error);
        if (!keep) ws.cleanup();
        return finish({ status: "error", summary, detail: {} as ConsistencyResult });
      }
    },
  };
}
