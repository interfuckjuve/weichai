/**
 * 方向 3「变体差分验证(AID)」runner:
 * 预处理器 = VariantGeneratorAgent 生成源语言变体 → 写入工作目录 variants/;
 * 主流程 = claude 自主单次调用,读 <workspace>/report.json(AIDVerificationReport)归一化。
 *
 * 注意(Ruling 3):aid 模块当前仍在 src/variant/,Task 4 目录改名 aid/ 后
 * import 路径 ../variant/aid-verifier.js / ../variant/variant-generator.js 需更新。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaude } from "../claude-client.js";
import type { VerifierLanguage } from "../description.js";
import { VariantGeneratorAgent } from "../variant/variant-generator.js";
import type { AIDVerificationReport } from "../variant/aid-verifier.js";
import { defaultSandbox, defaultWorkspaceRoot, makeClaudeOptions, type StrategyLlmConfig } from "./helpers.js";
import { buildAidTaskPrompt } from "./prompts/aid-task.js";
import { errorSummary, readReport } from "./report.js";
import type { StrategyRunOptions, StrategyStatus, TestStrategyJob, TestStrategyReport, TestStrategyRunner } from "./types.js";
import { createWorkspace } from "./workspace.js";

export interface AidRunnerOptions extends StrategyRunOptions {
  llm: StrategyLlmConfig;
}

/** 预生成变体数(与 AIDJobOptions.variantCount 默认一致)。 */
const DEFAULT_VARIANT_COUNT = 3;

const LANGUAGE_EXT: Record<VerifierLanguage, string> = {
  Java: ".java",
  "C#": ".cs",
  Python: ".py",
  TypeScript: ".ts",
};

export function createAidRunner(options: AidRunnerOptions): TestStrategyRunner {
  return {
    async run(job: TestStrategyJob, signal?: AbortSignal): Promise<TestStrategyReport> {
      const started = performance.now();
      const ws = createWorkspace(options.workspaceRoot ?? defaultWorkspaceRoot(), "aid");
      const keep = options.keepGeneratedTests ?? false;
      const finish = (
        partial: Pick<TestStrategyReport, "status" | "summary" | "detail"> & Partial<Pick<TestStrategyReport, "passRate">>,
      ): TestStrategyReport => ({
        strategy: "aid",
        ...partial,
        durationMs: performance.now() - started,
        generatedTestsKept: keep,
        keptDir: keep ? ws.dir : undefined,
      });
      try {
        if (signal?.aborted) throw new Error("策略运行已中止(aborted)");
        // 预处理器:变体生成(LLM 基础选项,不含沙箱)→ 写入 ws.dir/variants/。
        const sourceCode = (job.source.files ?? []).map((f) => f.content).join("\n");
        const generator = new VariantGeneratorAgent({
          apiKey: options.llm.apiKey,
          model: options.llm.model,
          timeoutMs: options.llm.timeoutMs,
          ...(options.llm.spawnClaude ? { spawnClaude: options.llm.spawnClaude } : {}),
        });
        const variants = await generator.generateVariants(
          {
            requirement: job.requirement,
            sourceLanguage: job.source.language,
            sourceCode,
            target: { className: job.target.className, method: job.target.method, isStatic: job.target.isStatic },
            variantCount: DEFAULT_VARIANT_COUNT,
          },
          signal,
        );
        const variantsDir = join(ws.dir, "variants");
        mkdirSync(variantsDir, { recursive: true });
        const ext = LANGUAGE_EXT[job.source.language];
        variants.forEach((code, i) => {
          writeFileSync(join(variantsDir, `Variant_${i + 1}${ext}`), code, "utf-8");
        });

        const sandbox = options.claudeSandbox ?? defaultSandbox(job, ws.dir);
        // Ruling 6:直接调 runClaude(不经 countedClaude)。
        const llm = makeClaudeOptions(options.llm, { ...sandbox, writableDir: sandbox.writableDir ?? ws.dir }, ws.stepsLogPath, options.maxTurns ?? 50);
        const prompt = buildAidTaskPrompt(job, { variantsDir });
        await runClaude(prompt, llm);
        const detail = await readReport<AIDVerificationReport>(ws.dir);
        // 归一化(brief §3.3):AIDVerificationReport 顶层无 cleanTarget 字段,
        // 实际位于 baseline.cleanTarget.usable(字段映射见报告);usable=false → unverified,
        // 否则 failedCases===0 → pass,其余 → fail。passRate 取 detail.passRate。
        const cleanTargetUsable = detail.baseline?.cleanTarget?.usable;
        const status: StrategyStatus = cleanTargetUsable === false ? "unverified" : detail.failedCases === 0 ? "pass" : "fail";
        const passRate = detail.passRate;
        const summary = `AID 变体差分:passRate=${detail.passRate.toFixed(3)}(pass=${detail.passedCases},fail=${detail.failedCases},disputed=${detail.disputedCases},total=${detail.totalCases}),oracle 共识=${detail.oracleSummary.consensusCount},争议=${detail.oracleSummary.disputedCount}`;
        if (!keep) ws.cleanup();
        return finish({ status, passRate, summary, detail });
      } catch (error) {
        const summary = errorSummary(error);
        if (!keep) ws.cleanup();
        return finish({ status: "error", summary, detail: {} as AIDVerificationReport });
      }
    },
  };
}
