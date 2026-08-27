/**
 * smoke 适配器:方向 1「冒烟验证 + 行为一致性自修复」,经统一策略入口自主执行。
 *
 * 接入方式:
 * - createTestStrategy("smoke") 构造自主 runner:单一 claude 会话完成读码 → 双侧 runner
 *   编写 → 编译运行 → 机械差分 → 语义裁决 → 目标修复 → report.json(SmokeReport);
 * - 产出 GeneratedTest(kind=runner):runner.files 优先取 report.detail.runnerFiles
 *   (双侧 runner/driver 文件,目标侧在前便于 metrics 拆分驱动入口),其次 targetFiles
 *   (修复后的目标文件全文,旧报告兼容);keepGeneratedTests=true 时若报告均未携带则
 *   回退从 keptDir 读取;
 *   report 字段挂 runner.report(检出信号来源:judge 决策 translation-bug);
 * - metrics 层对注入 bug 目标复用该 runner 做机械差分(T vs T'),不重跑 LLM 循环;
 * - 失败语义(保持既有,不中断评估):策略 status=error 时记录 warn 并返回空 runner
 *   (no-runner),不抛未捕获异常。
 *
 * 说明:自主会话不再需要磁盘上的源/目标文件(job 直接携带文件内容 + 只读参考根目录),
 * 旧 SmokeAgent 的 rootDir 硬性前置检查随之移除。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestStrategy } from "../../strategies/index.js";
import type { SmokeReport, RunnerFile } from "../../smoke/smoke-types.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";
import { buildStrategyJob } from "./strategy-job.js";

export class SmokeAdapter implements GeneratorAdapter {
  readonly name = "smoke" as const;
  readonly #ctx: AdapterContext;
  readonly #counted: ReturnType<typeof countedClaude>;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
    this.#counted = countedClaude(ctx.llm);
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();
    const logger = defaultLogger("smoke", this.#ctx);
    const runner = createTestStrategy("smoke", {
      llm: this.#counted.options,
      keepGeneratedTests: this.#ctx.keepGeneratedTests ?? false,
      maxTurns: this.#ctx.maxTurns ?? this.#ctx.maxSteps,
      workspaceRoot: this.#ctx.workspaceRoot,
    });
    const report = await runner.run(buildStrategyJob(task, this.#ctx.rootDir), signal);
    const language = task.target.language;
    if (report.status === "error") {
      // 自主会话失败(报告缺失/非法/中止):返回空 runner + 无报告,评估层按 no-runner 容忍。
      logger.warn(`smoke 策略失败(entry=${task.entry.id}),converged 不可用:${report.summary}`);
      return {
        kind: "runner",
        runner: { language, files: [], report: undefined },
        meta: { llmCalls: this.#counted.calls(), durationMs: report.durationMs },
      };
    }
    const detail = report.detail as SmokeReport;
    // runner 文件优先级:1) 报告内 runnerFiles(双侧 runner/driver,收敛无修复的常见路径
    // 下 targetFiles 为空,依赖本字段;目标侧在前,保证 metrics 拆分驱动入口取到目标侧驱动);
    // 2) targetFiles(修复后的目标文件全文,旧报告兼容);3) keep=true 时回退从 keptDir 读取。
    let files: RunnerFile[] = [];
    if (detail.runnerFiles && detail.runnerFiles.length > 0) {
      // 目标侧在前合并双侧文件(保留 path/content 原样)。
      files = [...detail.runnerFiles]
        .sort((a, b) => (a.side === "target" ? -1 : 1) - (b.side === "target" ? -1 : 1))
        .flatMap((r) => r.files);
    }
    if (files.length === 0) {
      files = detail.targetFiles ?? [];
    }
    if (files.length === 0 && report.keptDir) {
      files = readWorkspaceFiles(report.keptDir);
    }
    if (files.length === 0) {
      logger.warn(`smoke 报告未携带目标文件(entry=${task.entry.id}),converged=${detail.converged},按 no-runner 处理`);
    }
    return {
      kind: "runner",
      runner: { language, files, report: detail },
      meta: { llmCalls: this.#counted.calls(), durationMs: report.durationMs },
    };
  }
}

// ---------------------------------------------------------------------------
// SmokeReport 检出信号辅助(纯函数,供 metrics 层消费)
// ---------------------------------------------------------------------------

/** 任一 case 裁决为 translation-bug → 检出信号。 */
export function smokeReportHasBugSignal(report: SmokeReport): boolean {
  return report.cases.some((c) => c.decision === "translation-bug");
}

/** 被判定为翻译 bug 的 caseId 列表。 */
export function smokeReportBugCases(report: SmokeReport): string[] {
  return report.cases.filter((c) => c.decision === "translation-bug").map((c) => c.caseId);
}

/**
 * 从策略 keptDir 读取全部工作区文件作为 runner 文件(排除报告/步骤日志等元文件)。
 * 改进:跳过子目录项(避免 EISDIR)、跳过超大文件与二进制非 utf-8 文件(如 .class,
 * 解码会出现替换字符 U+FFFD),保证产出可被 driver 拆分/编译消费。
 */
function readWorkspaceFiles(dir: string): RunnerFile[] {
  const excluded = new Set(["report.json", "claude-steps.jsonl"]);
  /** 单文件大小上限(UTF-8 文本工作区文件一般远小于此;超限视为非目标文件)。 */
  const MAX_FILE_BYTES = 1_048_576;
  const files: RunnerFile[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (excluded.has(name)) continue;
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) continue; // 跳过子目录(如 variants/、bin/),避免 EISDIR。
    if (stat.size > MAX_FILE_BYTES) continue;
    let content: string;
    try {
      content = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    // 非 UTF-8 二进制(如 .class)解码会出现替换字符/空字节,跳过。
    if (content.includes("\uFFFD") || content.includes("\0")) continue;
    files.push({ path: name, content });
  }
  return files;
}
