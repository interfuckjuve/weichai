/**
 * distinct 适配器:方向 2「分支一致性验证(DISTINCT)」,经统一策略入口自主执行。
 *
 * 接入方式:
 * 1. TestMigratorAgent 生成 baseline 描述(需求第一)——GeneratedTest.description 契约
 *    (metrics/evaluate 的 CSR/conformance/差分检出均需 TestDescription);
 * 2. createTestStrategy("distinct") 自主会话完成:双侧驱动编写 → 差分验证 → 分支清单构建 →
 *    case 级 NLD 三态裁决 → report.json(ConsistencyResult);
 * 3. flag-fail 即「偏离需求信号」:report.detail.consistency.cases 中
 *    recommend=flag-fail / nldVerdict=diverges 的 case 汇总进 meta.signal(可观测);
 *    描述本体不变(修正语义由 strictNld 选项控制,默认仅标记,不篡改差分结果)。
 *
 * 成本:baseline 描述(1+重试)+ distinct 自主会话(1 次 claude 调用,内部完成差分与分析)。
 */
import { basename } from "node:path";
import { createTestStrategy } from "../../strategies/index.js";
import type { ConsistencyResult } from "../../distinct/consistency-verifier-types.js";
import { generateDriverSource, generateSourceDriverSource } from "../../driver/driver-codegen.js";
import type { SourceInvocation } from "../../driver/source-invocation.js";
import { TestMigratorAgent } from "../../test-migrator.js";
import { normalizeSourceSignature } from "../dataset.js";
import type { SideSpec } from "../../executor.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";
import { toMigrationInput } from "./baseline.js";
import { buildStrategyJob } from "./strategy-job.js";

export class DistinctAdapter implements GeneratorAdapter {
  readonly name = "distinct" as const;
  readonly #ctx: AdapterContext;
  readonly #counted: ReturnType<typeof countedClaude>;
  readonly #migrator: TestMigratorAgent;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
    this.#counted = countedClaude(ctx.llm);
    this.#migrator = new TestMigratorAgent({ ...this.#counted.options, logger: defaultLogger("distinct", ctx) });
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();
    const logger = defaultLogger("distinct", this.#ctx);

    // 1. baseline 描述(需求第一;description-kind 契约要求 TestDescription)。
    const description = await this.#migrator.extractDescription(toMigrationInput(task), signal);

    // 2. 策略 runner:自主会话完成差分验证 + 分支一致性分析(内部 LLM 调用经计数包装)。
    const runner = createTestStrategy("distinct", {
      llm: this.#counted.options,
      maxTurns: this.#ctx.maxTurns,
      workspaceRoot: this.#ctx.workspaceRoot,
    });
    const report = await runner.run(buildStrategyJob(task, this.#ctx.rootDir), signal);
    if (report.status === "error") {
      // 保持既有失败语义:生成失败抛错,evaluate 层记录 per-entry 失败,不中断评估。
      throw new Error(`distinct 策略失败(entry=${task.entry.id}): ${report.summary}`);
    }
    const detail = report.detail as ConsistencyResult;

    // 3. flag-fail 即偏离需求信号。
    const flagged = detail.consistency.cases.filter(
      (c) => c.recommend === "flag-fail" || c.nldVerdict === "diverges",
    );
    const caseIds = flagged.map((c) => c.caseId);
    if (caseIds.length > 0) {
      logger.warn(`distinct 检出 ${caseIds.length} 个偏离需求 case:${caseIds.join(", ")}`);
    }
    return {
      kind: "description",
      description,
      meta: {
        llmCalls: this.#counted.calls(),
        durationMs: report.durationMs,
        signal:
          caseIds.length > 0
            ? {
                kind: "flag-fail",
                caseIds,
                detail: flagged.map((c) => `${c.caseId}:${c.nldVerdict}/${c.recommend}`).join("; "),
              }
            : undefined,
      },
    };
  }
}

/** 从描述 + task 构造目标侧 SideSpec(驱动 + 目标模块文件;保留项目文件结构,替换模块内容)。 */
export function buildTargetSide(
  description: Parameters<typeof generateDriverSource>[0],
  task: QualityTask,
  targetContent: string,
): SideSpec {
  const targetFile = basename(task.entry.target.file);
  const sourceFiles = task.target.sourceFiles.map((f) =>
    f.relativePath === targetFile ? { ...f, content: targetContent } : f,
  );
  return {
    ...task.target,
    driverSource: generateDriverSource(description),
    sourceFiles,
  };
}

/** 从描述 + task 构造源侧 SideSpec(源驱动 + 源模块文件;签名经规范化:package→FQN、静态性探测)。 */
export function buildSourceSide(
  description: Parameters<typeof generateDriverSource>[0],
  task: QualityTask,
): SideSpec {
  const entry = task.entry;
  const sourceCode = task.source.sourceFiles.map((f) => f.content).join("\n");
  const signature = normalizeSourceSignature(entry, sourceCode, task.source.projectRoot);
  const invocation: SourceInvocation = {
    language: task.source.language,
    className: signature.className,
    method: signature.method,
    isStatic: signature.isStatic,
    constructorArgs: signature.constructorArgs,
  };
  return {
    ...task.source,
    driverSource: generateSourceDriverSource(description, invocation),
  };
}
