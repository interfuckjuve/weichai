/**
 * 方向 4「片段级微观测试生成(MitGen)」runner:
 * 预处理器 = extractFragments(源方法)→ 片段清单传入提示词;
 * 主流程 = claude 自主单次调用,读 <workspace>/report.json(MitGenResult)归一化
 * (status 恒为 "pass",生成成功即视为通过;passRate 无意义为 undefined)。
 */
import { runClaude } from "../claude-client.js";
import { extractFragments } from "../mitgen/fragment-extractor.js";
import type { MitGenResult } from "../mitgen/types.js";
import { defaultSandbox, defaultWorkspaceRoot, makeClaudeOptions, type StrategyLlmConfig } from "./helpers.js";
import { buildMitgenTaskPrompt } from "./prompts/mitgen-task.js";
import { errorSummary, readReport } from "./report.js";
import type { StrategyRunOptions, StrategyStatus, TestStrategyJob, TestStrategyReport, TestStrategyRunner } from "./types.js";
import { createWorkspace } from "./workspace.js";

export interface MitgenRunnerOptions extends StrategyRunOptions {
  llm: StrategyLlmConfig;
}

export function createMitgenRunner(options: MitgenRunnerOptions): TestStrategyRunner {
  return {
    async run(job: TestStrategyJob, signal?: AbortSignal): Promise<TestStrategyReport> {
      const started = performance.now();
      const ws = createWorkspace(options.workspaceRoot ?? defaultWorkspaceRoot(), "mitgen");
      const keep = options.keepGeneratedTests ?? false;
      const finish = (
        partial: Pick<TestStrategyReport, "status" | "summary" | "detail"> & Partial<Pick<TestStrategyReport, "passRate">>,
      ): TestStrategyReport => ({
        strategy: "mitgen",
        ...partial,
        durationMs: performance.now() - started,
        generatedTestsKept: keep,
        keptDir: keep ? ws.dir : undefined,
      });
      try {
        if (signal?.aborted) throw new Error("策略运行已中止(aborted)");
        // 预处理器:片段提取(纯函数)→ 片段清单进入提示词。
        const sourceCode = (job.source.files ?? []).map((f) => f.content).join("\n");
        const fragments = extractFragments(sourceCode);

        const sandbox = options.claudeSandbox ?? defaultSandbox(job, ws.dir);
        // Ruling 6:直接调 runClaude(不经 countedClaude)。
        const llm = makeClaudeOptions(options.llm, { ...sandbox, writableDir: sandbox.writableDir ?? ws.dir }, ws.stepsLogPath, options.maxTurns ?? 50);
        const prompt = buildMitgenTaskPrompt(job, { fragments });
        await runClaude(prompt, llm);
        const detail = await readReport<MitGenResult>(ws.dir);
        // 归一化(brief §3.4):status 恒为 "pass"(生成成功);passRate = undefined。
        const status: StrategyStatus = "pass";
        const summary = `MitGen 片段生成:${detail.fragments.length} 个片段,${detail.description.cases.length} 个用例`;
        if (!keep) ws.cleanup();
        return finish({ status, summary, detail });
      } catch (error) {
        const summary = errorSummary(error);
        if (!keep) ws.cleanup();
        return finish({ status: "error", summary, detail: {} as MitGenResult });
      }
    },
  };
}
