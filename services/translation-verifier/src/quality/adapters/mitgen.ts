/**
 * mitgen 适配器:方向 4「片段级微观测试生成(MitGen)」,经统一策略入口自主执行。
 *
 * 接入方式:
 * 1. createTestStrategy("mitgen") 自主会话:片段提取(预处理器)→ 主会话完成启发式预筛 +
 *    LLM 批量打分 → Top-K 片段定向输入生成 + 源侧插桩实跑验证 → report.json(MitGenResult);
 * 2. 产出描述必须通过 schema 校验(与 MitGen 自身验收同口径);
 * 3. GeneratedTest.signal = 片段级摘要(片段数 / verified 数 / case 数,可观测)。
 *
 * 成本:mitgen 自主会话 = 主会话 1 次 claude 调用(内部完成打分/输入生成/对应性,经计数包装统计)。
 */
import { createTestStrategy } from "../../strategies/index.js";
import { validateDescription } from "../../description.js";
import type { MitGenResult } from "../../mitgen/types.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";
import { buildStrategyJob } from "./strategy-job.js";

export class MitGenAdapter implements GeneratorAdapter {
  readonly name = "mitgen" as const;
  readonly #ctx: AdapterContext;
  readonly #counted: ReturnType<typeof countedClaude>;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
    this.#counted = countedClaude(ctx.llm);
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();

    // 策略 runner:自主会话完成片段划分 → 打分 → 定向输入生成 → 源侧实跑录制 expected。
    const runner = createTestStrategy("mitgen", {
      llm: this.#counted.options,
      maxTurns: this.#ctx.maxTurns,
      workspaceRoot: this.#ctx.workspaceRoot,
    });
    const report = await runner.run(buildStrategyJob(task, this.#ctx.rootDir), signal);
    if (report.status === "error") {
      throw new Error(`mitgen 策略失败(entry=${task.entry.id}): ${report.summary}`);
    }
    const detail = report.detail as MitGenResult;
    // 产出描述必须通过 schema 校验(与 MitGen 自身验收同口径)。
    validateDescription(detail.description);
    const verified = detail.fragments.filter((f) => f.reachability === "verified").length;
    return {
      kind: "description",
      description: detail.description,
      meta: {
        llmCalls: this.#counted.calls(),
        durationMs: report.durationMs,
        signal: {
          kind: "mitgen-fragments",
          detail: `fragments=${detail.fragments.length} verified=${verified} cases=${detail.description.cases.length}`,
        },
      },
    };
  }
}
