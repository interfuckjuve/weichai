/**
 * aid 适配器:方向 3「变体差分验证(AID)」,经统一策略入口自主执行。
 *
 * 接入方式:
 * 1. createTestStrategy("aid") 自主会话:变体预生成(variants/ 目录)→ 主会话完成参考组
 *    批量执行 → 共识 oracle → 目标执行 → 共识差分 → report.json(AIDVerificationReport);
 * 2. GeneratedTest.description 取自 report.detail.baseline.description(自主会话实际使用的
 *    需求第一描述,契约完整);
 * 3. GeneratedTest.meta.signal = 共识差分结果(consensus 差分 fail 即检出信号);
 * 4. detectOnTarget(扩展方法,非 GeneratorAdapter 接口成员):对注入 bug 的目标
 *    复用 clean 轨道的冻结 oracle(meta.aidBaseline),仅重放目标侧;新增 fail case 才算检出,
 *    从而把数据集「需求≠检索代码」导致的合法共识差异(两侧都出现)排除在检出之外。
 *
 * 成本:aid 自主会话 = 变体生成(variantCount×尝试)+ 主会话 1 次(全部经计数包装统计)。
 */
import {
  verifyTargetAgainstAIDBaseline,
  type AIDVerificationReport,
} from "../../aid/aid-verifier.js";
import { createTestStrategy } from "../../strategies/index.js";
import type { DriverExecutor } from "../../executor.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";
import { buildSourceSide, buildTargetSide } from "./distinct.js";
import { buildStrategyJob } from "./strategy-job.js";

export interface AidDetectionResult {
  detected: boolean;
  failedCasesClean: number;
  failedCasesBuggy: number;
  newFailedCaseIds: string[];
  note?: string;
}

export class AidAdapter implements GeneratorAdapter {
  readonly name = "aid" as const;
  readonly #ctx: AdapterContext;
  readonly #counted: ReturnType<typeof countedClaude>;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
    this.#counted = countedClaude(ctx.llm);
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();
    const logger = defaultLogger("aid", this.#ctx);

    // 1. 策略 runner:自主会话完成变体轨道(变体生成 → 过滤 → 输入 → oracle → 目标差分)。
    const runner = createTestStrategy("aid", {
      llm: this.#counted.options,
      maxTurns: this.#ctx.maxTurns,
      workspaceRoot: this.#ctx.workspaceRoot,
    });
    const report = await runner.run(buildStrategyJob(task, this.#ctx.rootDir), signal);
    if (report.status === "error") {
      throw new Error(`aid 策略失败(entry=${task.entry.id}): ${report.summary}`);
    }
    const detail = report.detail as AIDVerificationReport;
    const description = detail.baseline?.description;
    if (!description) {
      throw new Error(`aid 报告缺少 baseline.description(entry=${task.entry.id}),契约不完整`);
    }
    const failCases = detail.comparisons.filter((c) => c.verdict === "fail").map((c) => c.caseId);
    if (report.status === "unverified") {
      logger.warn(`aid clean 目标不可用(entry=${task.entry.id}):${detail.baseline.cleanTarget?.note ?? "missing-clean-target-status"}`);
    }
    if (detail.failedCases > 0) {
      logger.warn(`aid 干净目标上共识差分 fail ${detail.failedCases} 个 case(可能为跨语言噪声或需求差异):${failCases.join(", ")}`);
    }
    return {
      kind: "description",
      description,
      meta: {
        llmCalls: this.#counted.calls(),
        durationMs: report.durationMs,
        signal: {
          kind: "aid-differential",
          caseIds: failCases,
          detail: `clean passRate=${detail.passRate.toFixed(2)} failed=${detail.failedCases} disputed=${detail.disputedCases} consensus=${detail.oracleSummary.consensusCount} variants=${detail.variants.filter((v) => v.passes).length}/${detail.variants.length}`,
        },
        aidBaseline: detail.baseline,
      },
    };
  }

  /**
   * 注入 bug 检出(扩展方法,评估层按 name==="aid" 调用):
   * 使用 clean run 冻结的输入和 oracle 重放目标侧，detected = 出现新的失败 case。
   */
  async detectOnTarget(
    task: QualityTask,
    test: GeneratedTest,
    targetSource: string,
    signal?: AbortSignal,
  ): Promise<AidDetectionResult> {
    const logger = defaultLogger("aid", this.#ctx);
    const description = test.description;
    if (!description) {
      return { detected: false, failedCasesClean: 0, failedCasesBuggy: 0, newFailedCaseIds: [], note: "no-description" };
    }
    const baseline = test.meta.aidBaseline;
    if (!baseline) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: "clean-baseline-unavailable",
      };
    }
    if (baseline.cleanTarget?.usable !== true) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: `clean-baseline-unusable:${baseline.cleanTarget?.note ?? "missing-clean-target-status"}`,
      };
    }
    if (!baseline.oracle.some((entry) => entry.confidence === "consensus")) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: "clean-baseline-unusable:no-consensus-oracle",
      };
    }
    const targetSide = buildTargetSide(description, task, targetSource);
    let buggyReport: AIDVerificationReport;
    try {
      buggyReport = await verifyTargetAgainstAIDBaseline(
        targetSide,
        baseline,
        this.#ctx.executor,
        logger,
      );
    } catch (error) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: `aid-run-failed:${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const targetUsable = baseline.batchDescription.cases.every((testCase) =>
      buggyReport.comparisons.some((comparison) => comparison.caseId === testCase.id && comparison.target !== null),
    );
    if (!targetUsable) {
      return {
        detected: false,
        failedCasesClean: 0,
        failedCasesBuggy: 0,
        newFailedCaseIds: [],
        note: "target-unusable",
      };
    }
    const cleanFails = new Set(baseline.cleanFailedCaseIds);
    const newFailedCaseIds = buggyReport.comparisons
      .filter((comparison) => comparison.verdict === "fail" && !cleanFails.has(comparison.caseId))
      .map((comparison) => comparison.caseId);
    return {
      detected: newFailedCaseIds.length > 0,
      failedCasesClean: cleanFails.size,
      failedCasesBuggy: buggyReport.failedCases,
      newFailedCaseIds,
    };
  }
}
