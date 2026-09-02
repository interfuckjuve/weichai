/**
 * smoke 适配器:SmokeAgent 完整冒烟循环(方向 1)。
 *
 * 接入方式:
 * - 以 entry 的源/目标文件(single-file 模式)驱动 SmokeAgent 完整 agent 循环
 *   (可注入 fake spawnClaude + FakeDriverExecutor 做离线验收);
 * - 通过 RecordingExecutor 记录循环内全部 compile 调用,循环结束后按模块内容归类,
 *   从最终编译的 SideSpec 还原目标侧 runner 文件(驱动入口 + 附加文件),
 *   产出 GeneratedTest(kind=runner);
 * - 检出信号来源:SmokeReport 的 judge 决策(translation-bug 即检出信号)——
 *   metrics 层对注入 bug 目标复用该 runner 做机械差分(T vs T'),不重跑 LLM 循环。
 *
 * 已知限制:SmokeAgent 需要磁盘上的真实源/目标文件(rootDir 解析 entry.file,
 * 见 AdapterContext.rootDir),且 single-file 模式下目标文件须自包含
 * (编译不依赖同项目其他类)。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SmokeAgent } from "../../smoke-agent.js";
import type { SmokeReport } from "../../smoke-types.js";
import type { CompileOutcome, DriverExecutor, RunOutcome, SideSpec } from "../../executor.js";
import type { VerifierLanguage } from "../../description.js";
import type { RunnerFile } from "../../smoke-types.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";

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
    const rootDir = this.#ctx.rootDir ?? process.cwd();
    const sourceFile = resolve(rootDir, task.entry.source.file);
    const targetFile = resolve(rootDir, task.entry.target.file);
    if (!existsSync(sourceFile) || !existsSync(targetFile)) {
      throw new Error(
        `smoke 适配器需要磁盘上的源/目标文件(--root 指向仓库根):${task.entry.source.file} / ${task.entry.target.file}`,
      );
    }
    const targetContent = readFileSync(targetFile, "utf-8");
    const sourceContent = readFileSync(sourceFile, "utf-8");

    // 记录循环内全部 compile 调用,循环结束后按模块内容归类还原目标侧 runner。
    const recorder = new RecordingExecutor(this.#ctx.executor, { sourceContent, targetContent });
    const agent = new SmokeAgent({
      requirement: task.entry.requirement,
      sourceLang: task.source.language,
      targetLang: task.target.language,
      sourceFile,
      targetFile,
      targetClass: task.entry.target.className.split(".").pop(),
      targetMethod: task.entry.target.method,
      maxSteps: this.#ctx.maxSteps,
      maxRounds: this.#ctx.maxRounds,
      executor: recorder,
      spawnClaude: this.#counted.options.spawnClaude,
      apiKey: this.#counted.options.apiKey,
      model: this.#counted.options.model,
      timeoutMs: this.#counted.options.timeoutMs,
      logger,
    });
    const report = await agent.run();
    const runner = recorder.targetRunner();
    if (runner === null) {
      // 循环未产出目标侧可编译 runner(LLM 失败或契约违规):仍返回空 runner + 报告,
      // CSR/检出度量层以 no-runner 标注,不在此抛错(评估按 per-entry 容忍失败)。
      logger.warn(`smoke 循环未捕获目标侧 runner(entry=${task.entry.id}),converged=${report.converged}`);
    }
    return {
      kind: "runner",
      runner: {
        language: task.target.language as VerifierLanguage,
        files: runner?.files ?? [],
        report,
      },
      meta: { llmCalls: this.#counted.calls(), durationMs: Date.now() - started },
    };
  }
}

// ---------------------------------------------------------------------------
// 循环内调用记录(compile 全量留痕,供 runner 还原)
// ---------------------------------------------------------------------------

interface RecordedCall {
  side: SideSpec;
  outcome: CompileOutcome;
}

export class RecordingExecutor implements DriverExecutor {
  readonly #inner: DriverExecutor;
  readonly #sourceContent: string;
  readonly #targetContent: string;
  readonly compileCalls: RecordedCall[] = [];
  readonly runCalls: { side: SideSpec; outcome: RunOutcome }[] = [];

  constructor(inner: DriverExecutor, marker: { sourceContent: string; targetContent: string }) {
    this.#inner = inner;
    this.#sourceContent = marker.sourceContent;
    this.#targetContent = marker.targetContent;
  }

  async compile(side: SideSpec): Promise<CompileOutcome> {
    const outcome = await this.#inner.compile(side);
    this.compileCalls.push({ side, outcome });
    return outcome;
  }

  async run(side: SideSpec): Promise<RunOutcome> {
    const outcome = await this.#inner.run(side);
    this.runCalls.push({ side, outcome });
    return outcome;
  }

  /** 最后一次目标侧编译(按 sourceFiles 中是否含目标模块内容归类)。 */
  targetCompile(): RecordedCall | null {
    return this.#lastByContent(this.#targetContent);
  }

  #lastByContent(marker: string): RecordedCall | null {
    let found: RecordedCall | null = null;
    for (const call of this.compileCalls) {
      if (call.side.sourceFiles.some((f) => f.content === marker)) found = call;
    }
    return found;
  }

  /** 目标侧 runner 文件(驱动入口 + 附加文件,不含模块文件);不可用时 null。 */
  targetRunner(): { files: RunnerFile[]; compileOk: boolean; side: SideSpec } | null {
    const call = this.targetCompile();
    if (call === null) return null;
    return { files: splitSideSpec(call.side, this.#targetContent), compileOk: call.outcome.success, side: call.side };
  }
}

/** 从 SideSpec 还原 runner 文件列表:驱动入口 + 附加文件(去掉模块文件)。 */
export function splitSideSpec(side: SideSpec, moduleContent: string): RunnerFile[] {
  const extras: RunnerFile[] = [];
  for (const f of side.sourceFiles) {
    if (f.content === moduleContent) continue;
    extras.push({ path: f.relativePath, content: f.content });
  }
  return [{ path: driverPathFor(side.language, side.driverSource), content: side.driverSource }, ...extras];
}

/** 按语言确定驱动入口文件名(与 executor/smoke 契约一致)。 */
function driverPathFor(language: VerifierLanguage, driverSource: string): string {
  if (language === "Python") return "driver.py";
  if (language === "TypeScript") return "driver.ts";
  if (language === "C#") return "Driver.cs";
  const match = /public\s+class\s+(\w+)/.exec(driverSource);
  return `${match?.[1] ?? "Driver"}.java`;
}

// ---------------------------------------------------------------------------
// SmokeReport 检出信号辅助
// ---------------------------------------------------------------------------

/** 任一 case 裁决为 translation-bug → 检出信号。 */
export function smokeReportHasBugSignal(report: SmokeReport): boolean {
  return report.cases.some((c) => c.decision === "translation-bug");
}

/** 被判定为翻译 bug 的 caseId 列表。 */
export function smokeReportBugCases(report: SmokeReport): string[] {
  return report.cases.filter((c) => c.decision === "translation-bug").map((c) => c.caseId);
}
