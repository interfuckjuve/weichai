/**
 * baseline 适配器:TestMigratorAgent(现有迁移描述生成器)。
 *
 * 输入:需求 + 检索代码(源方法体)→ 语言无关 TestDescription(含 expected)。
 * 需求第一:TestMigratorAgent 的 prompt 已强制「REQUIREMENT 为唯一 ground truth,
 * 源实现可能含缺陷,不得继承」——这正是 conformance 评估要验证的核心能力。
 */
import { TestMigratorAgent, type MigrationInput } from "../../test-migrator.js";
import type { QualityTask, GeneratedTest, GeneratorAdapter } from "../types.js";
import { countedClaude, defaultLogger, type AdapterContext } from "../adapters.js";

export class BaselineAdapter implements GeneratorAdapter {
  readonly name = "baseline" as const;
  readonly #migrator: TestMigratorAgent;
  readonly #counted: ReturnType<typeof countedClaude>;

  constructor(ctx: AdapterContext) {
    this.#counted = countedClaude(ctx.llm);
    this.#migrator = new TestMigratorAgent({ ...this.#counted.options, logger: defaultLogger("baseline", ctx) });
  }

  async generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest> {
    const started = Date.now();
    this.#counted.reset();
    const description = await this.#migrator.extractDescription(toMigrationInput(task), signal);
    return {
      kind: "description",
      description,
      meta: { llmCalls: this.#counted.calls(), durationMs: Date.now() - started },
    };
  }
}

/** 从 QualityTask 构造 TestMigratorAgent 的输入(需求 + 源方法体 + 目标契约)。 */
export function toMigrationInput(task: QualityTask): MigrationInput {
  const entry = task.entry;
  return {
    requirement: entry.requirement,
    sourceLanguage: entry.source.language,
    sourceCode: task.source.sourceFiles.map((f) => f.content).join("\n\n"),
    repository: "commons-fileupload",
    sourcePath: entry.source.file,
    target: {
      language: task.target.language,
      className: entry.target.className,
      method: entry.target.method,
      isStatic: entry.target.isStatic,
    },
    targetSignature: undefined,
    targetContext: task.target.sourceFiles.map((f) => f.content).join("\n\n") || undefined,
    targetCode: task.target.sourceFiles.map((f) => f.content).join("\n\n"),
  };
}
