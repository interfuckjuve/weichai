import { runClaude, type ClaudeClientOptions } from "./claude-client.js";
import { validateDescription, type TestDescription } from "./description.js";
import type { SourceInvocation } from "./driver/source-invocation.js";
import { extractJson, coerceTypedValue } from "./llm-json.js";
import { createLogger, type Logger } from "./logger.js";

export interface MigrationInput {
  sourceLanguage: string;
  /**
   * 完整方法体(按 SearchCandidate.path 从语料读取,而非 preview 片段)。
   * target-only 模式(无源侧参考,Analyzer 判定 reject/reference)时可省略。
   */
  sourceCode?: string;
  /** 同仓库锚定的相关测试(参考;上游 code-indexer 不索引测试,须自寻)。 */
  existingTests?: string;
  /** 用户需求,最高优先级(必填)。 */
  requirement: string;
  /** 来源仓库(SearchCandidate.repository),用于 prompt 引用与报告追踪。 */
  repository?: string;
  /** 来源文件路径(SearchCandidate.path,仓库相对路径)。 */
  sourcePath?: string;
  /**
   * 目标方法签名(含返回类型与参数,如 "public static String decodeText(String)");
   * 供 prompt 的 Target contract 段展示(Analyzer 分支分析需要)。缺省时提示 LLM 从源方法声明推导。
   */
  targetSignature?: string;
  /** 完整目标类上下文，用于类级入口(尤其是构造函数)推导合法输入。 */
  targetContext?: string;
  /** 目标侧翻译产物源码(MitGen 片段对应性检查用;其余生成器忽略)。 */
  targetCode?: string;
  /** Analyzer 报告 JSON 字符串(applicability/行为映射/契约映射/实现计划;供描述生成参考)。 */
  analysisReport?: string;
  target: {
    language: "Java" | "C#";
    className: string;
    method: string;
    isStatic: boolean;
  };
  /**
   * Validator(试编译反馈循环)注入的编译诊断反馈:存在时 buildMigrationPrompt 输出
   * VALIDATION_FEEDBACK 段,提示 LLM 上次描述导致驱动编译失败(是描述问题,不是翻译问题)。
   */
  validationFeedback?: string;
  /**
   * 源侧调用信息(Validator 重建源侧驱动试编译用);e2e/CLI 从源文件声明行解析后传入。
   */
  sourceInvocation?: SourceInvocation;
}

export interface TestMigratorOptions extends ClaudeClientOptions {}

const MAX_MIGRATION_RETRIES = 0;

export const MIGRATOR_SYSTEM_PROMPT = `You are a test migration specialist. Given a user requirement and a
candidate implementation (source method plus optional existing tests) retrieved from a codebase, produce
a language-agnostic test description that captures the required behavior: inputs, outputs, exceptions.
The description must exercise nominal, boundary, and error paths. Output one JSON object matching this
exact schema (no markdown):
{
  "schemaVersion": "1.0",
  "target": {
    "language": "Java" | "C#",
    "className": "...",
    "method": "...",
    "isStatic": true,
    "constructorArgs": []
  },
  "cases": [
    {
      "id": "...",
      "description": "...",
      "branches": ["..."],
      "inputs": [ { "type": "string|number|boolean|null|list|map", "value": ... } ],
      "expected": { "kind": "return", "value": { "type": "...", "value": ... } }
    }
  ]
}
Priority rules:
1. The user REQUIREMENT is the highest priority and the ONLY ground truth. The source method is a
   reference implementation that may contain defects. Do NOT write expected values that replicate source
   defects; when in doubt, follow the requirement. The source method and its tests are only a REFERENCE
   IMPLEMENTATION that helps you understand the logic; they are not the ground truth.
2. When the reference implementation conflicts with the requirement, follow the requirement, and note the
   conflict in the case description (e.g. "reference impl diverges from requirement here").
3. Do not inherit defects of the reference implementation (ignored whitespace, off-by-one errors,
   historical quirks).
4. Keep expected values language-agnostic; for exceptions use "kind": "exception" with "type" and
   optional "messageContains"; include AT LEAST 3 cases covering nominal, boundary, and error classes;
   explicitly name boundaries in the cases (null, empty, 0, extremes, off-by-one, empty/single/full
   collections); values must be JSON-safe.
5. Make the case "description" mandatory and semantically rich, with three structured parts:
   场景: <scenario> / 触发行为: <triggered behavior> / 目标分支或边界: <target branch or boundary>.
   The optional "branches" field declares claimed branch targets (e.g. "nominal", "boundary", "error",
   or an explicit branch-condition summary); it is consumed by a branch-level consistency analyzer.
6. Derive each "expected" by first reasoning from the requirement, then cross-checking against the
   reference implementation; when they conflict, follow the requirement and note it in the description.
7. When target.method is "__constructor__", each case invokes the target constructor using case.inputs.
   A successful construction MUST use expected {"kind":"return","value":{"type":"null","value":null}};
   do not invent object fields or serialize the constructed object.`;

export class TestMigratorAgent {
  readonly #options: TestMigratorOptions;
  readonly #logger: Logger;

  constructor(options: TestMigratorOptions) {
    this.#options = options;
    this.#logger = options.logger ?? createLogger("test-migrator");
  }

  async extractDescription(input: MigrationInput, signal?: AbortSignal): Promise<TestDescription> {
    const prompt = buildMigrationPrompt(input);
    this.#logger.debug(`buildMigrationPrompt 输出:\n${prompt}`);
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_MIGRATION_RETRIES; attempt += 1) {
      if (attempt === 0) {
        this.#logger.info("extractDescription 开始");
      } else {
        this.#logger.info(`extractDescription 重试第 ${attempt} 次`);
      }
      try {
        // 架构修正:LLM 调度统一走 claude 子进程("Claude Code + DeepSeek" agent 架构),
        // 不再 DeepSeek HTTP 直调;system 提示与 user prompt 合并为单一 prompt。
        const raw = await runClaude(`${MIGRATOR_SYSTEM_PROMPT}\n\n${prompt}`, this.#options);
        this.#logger.debug(`LLM 原始返回:\n${raw}`);
        const description = validateDescription(coerceDescription(JSON.parse(extractJson(raw))));
        this.#logger.info("extractDescription 完成");
        return description;
      } catch (error) {
        lastError = error;
        this.#logger.error(`校验失败(第 ${attempt + 1} 次):${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`TestMigratorAgent failed to produce a valid test description: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

export function buildMigrationPrompt(input: MigrationInput): string {
  // 需求第一:REQUIREMENT 段在最前;源码/测试为参考实现。
  const validationFeedback = input.validationFeedback?.trim()
    ? `VALIDATION_FEEDBACK (编译诊断反馈,最高优先修正)
${input.validationFeedback.trim()}

`
    : "";
  // 需求第一:REQUIREMENT 段在最前;源码/测试为参考实现。
  const analysisReport = input.analysisReport?.trim()
    ? `ANALYSIS_REPORT (Analyzer 对候选适用性的判定,参考;不覆盖需求)
${input.analysisReport.trim()}

`
    : "";
  return `REQUIREMENT
${input.requirement}

${validationFeedback}${analysisReport}REFERENCE_IMPLEMENTATION
Source language: ${input.sourceLanguage}${input.repository ? `\nRepository: ${input.repository}` : ""}${input.sourcePath ? `\nPath: ${input.sourcePath}` : ""}
Target contract:
- language: ${input.target.language}
- className: ${input.target.className}
- method: ${input.target.method}
- isStatic: ${input.target.isStatic}
- signature: ${input.targetSignature ?? "derive from the source method declaration (return type + parameters)"}

SOURCE_METHOD
${input.sourceCode
    ? `\`\`\`
${input.sourceCode}
\`\`\``
    : "(target-only 模式:无源侧参考实现。仅依据 REQUIREMENT、ANALYSIS_REPORT 与 TARGET_TRANSLATION 编写测试描述,不要假设源侧行为。)"}${input.targetCode ? `TARGET_TRANSLATION (目标侧翻译产物,参考;帮助对齐描述与目标契约)
\`\`\`
${input.targetCode}
\`\`\`
` : ""}${input.targetContext ? `TARGET_CLASS_CONTEXT
\`\`\`
${input.targetContext}
\`\`\`
` : ""}${input.existingTests ? `EXISTING_TESTS
\`\`\`
${input.existingTests}
\`\`\`
` : ""}`;
}

function coerceDescription(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const description = value as Record<string, unknown>;
  const cases = Array.isArray(description.cases) ? description.cases : undefined;
  if (!cases) return value;
  return {
    ...description,
    cases: cases.map((testCase) => {
      if (!testCase || typeof testCase !== "object") return testCase;
      const c = testCase as Record<string, unknown>;
      const expected = c.expected && typeof c.expected === "object"
        ? c.expected as Record<string, unknown>
        : undefined;
      return {
        ...c,
        inputs: Array.isArray(c.inputs) ? c.inputs.map(coerceTypedValue) : c.inputs,
        expected: expected?.kind === "return"
          ? { ...expected, value: coerceTypedValue(expected.value) }
          : c.expected,
      };
    }),
  };
}


