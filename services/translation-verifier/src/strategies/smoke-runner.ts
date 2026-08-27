/**
 * 方向 1「冒烟验证 + 行为一致性自修复」runner:claude 自主单次调用,
 * 读 <workspace>/report.json 归一化 status/passRate/summary。
 */
import { runClaude } from "../claude-client.js";
import type { SmokeReport } from "../smoke/smoke-types.js";
import { defaultSandbox, defaultWorkspaceRoot, makeClaudeOptions, type StrategyLlmConfig } from "./helpers.js";
import { buildSmokeTaskPrompt } from "./prompts/smoke-task.js";
import { errorSummary, readReport } from "./report.js";
import type { StrategyRunOptions, StrategyStatus, TestStrategyJob, TestStrategyReport, TestStrategyRunner } from "./types.js";
import { createWorkspace } from "./workspace.js";

export interface SmokeRunnerOptions extends StrategyRunOptions {
  llm: StrategyLlmConfig;
}

export function createSmokeRunner(options: SmokeRunnerOptions): TestStrategyRunner {
  return {
    async run(job: TestStrategyJob, signal?: AbortSignal): Promise<TestStrategyReport> {
      const started = performance.now();
      const ws = createWorkspace(options.workspaceRoot ?? defaultWorkspaceRoot(), "smoke");
      const keep = options.keepGeneratedTests ?? false;
      const finish = (
        partial: Pick<TestStrategyReport, "status" | "summary" | "detail"> & Partial<Pick<TestStrategyReport, "passRate">>,
      ): TestStrategyReport => ({
        strategy: "smoke",
        ...partial,
        durationMs: performance.now() - started,
        generatedTestsKept: keep,
        keptDir: keep ? ws.dir : undefined,
      });
      try {
        if (signal?.aborted) throw new Error("策略运行已中止(aborted)");
        const sandbox = options.claudeSandbox ?? defaultSandbox(job, ws.dir);
        // Ruling 6:strategies 层直接调 runClaude(不经 quality 的 countedClaude 包装)。
        const llm = makeClaudeOptions(options.llm, { ...sandbox, writableDir: sandbox.writableDir ?? ws.dir }, ws.stepsLogPath, options.maxTurns ?? 50);
        const prompt = buildSmokeTaskPrompt(job);
        await runClaude(prompt, llm);
        const detail = await readReport<SmokeReport>(ws.dir);
        // 归一化(brief §3.3):converged → pass/fail;passRate = cases 机械 pass 占比(空数组 undefined)。
        const status: StrategyStatus = detail.converged ? "pass" : "fail";
        const passRate = detail.cases.length === 0 ? undefined : detail.cases.filter((c) => c.mechanical === "pass").length / detail.cases.length;
        if (!keep) ws.cleanup();
        return finish({ status, passRate, summary: detail.summary, detail });
      } catch (error) {
        // 报告缺失/非法 → status=error,原因进 summary,不抛未捕获异常(spec §9)。
        const summary = errorSummary(error);
        if (!keep) ws.cleanup();
        return finish({ status: "error", summary, detail: {} as SmokeReport });
      }
    },
  };
}
