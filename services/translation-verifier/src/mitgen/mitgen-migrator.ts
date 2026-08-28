/**
 * MitGenMigratorAgent:片段级微观测试生成编排(与 TestMigratorAgent 平级)。
 *
 * 三阶段流水线:
 * ① extractFragments 片段划分(纯函数,无 LLM);
 * ② 启发式预筛 + LLM 单次批量打分(CamPri 简化版) + rankFragments 选 Top-K;
 * ③ 逐片段:LLM 定向输入生成(受 pathCondition 引导)→ 插桩副本实跑验证可达性
 *    + 录制 expected(源侧是真实可运行参考实现,天然规避「LLM 写 expected 不可靠」)→
 *    失败反馈重试 1 次 → 汇总为 schema 兼容 TestDescription;目标侧片段对应检查(correspondence)。
 *
 * 与现有流程的关系:verify/comparator/driver/executor/repair-loop 零改动,
 * description 仍是唯一契约;LLM 统一走 claude-client 的 runClaude(可注入 spawnClaude)。
 */
import { runClaude, type ClaudeClientOptions } from "../claude-client.js";
import {
  validateDescription,
  validateTypedValue,
  type TargetLanguage,
  type TestCase,
  type TestDescription,
  type TypedValue,
  type VerifierLanguage,
} from "../description.js";
import { generateSourceDriverSource } from "../driver/driver-codegen.js";
import type { SourceInvocation } from "../driver/source-invocation.js";
import type { DriverExecutor, RunOutcome, SideSpec } from "../executor.js";
import { coerceTypedValue, extractJson } from "../llm-json.js";
import { createLogger, type Logger } from "../logger.js";

/** MitGen 内部输入:sourceCode 必填(target-only 不适用片段级生成)。 */
type MitGenMigrationInput = MigrationInput & { sourceCode: string };

function requireMitGenSource(input: MigrationInput): MitGenMigrationInput {
  if (!input.sourceCode || !input.sourceCode.trim()) {
    throw new Error("MitGen 需要源方法源码(sourceCode);target-only 模式不适用。");
  }
  return input as MitGenMigrationInput;
}
import { parseSideResults, type CaseResult } from "../result-capture.js";
import type { MigrationInput } from "../test-migrator.js";
import { extractFragments, locateMethod } from "./fragment-extractor.js";
import {
  DEFAULT_RANK_WEIGHTS,
  parseFragmentScores,
  rankFragments,
} from "./fragment-prioritizer.js";
import type { RankWeights } from "./types.js";
import {
  buildCorrespondencePrompt,
  buildInputGenerationPrompt,
  buildRetryInputPrompt,
  buildScoringPrompt,
} from "./mitgen-prompts.js";
import { MARKER_PREFIX, extractMarkers, instrumentFragment, stripMarkers } from "./splicer.js";
import type { CodeFragment, Correspondence, FragmentReport, FragmentScore, MitGenResult, Reachability } from "./types.js";

export interface MitGenOptions extends ClaudeClientOptions {
  /** 每片段候选输入数(默认 3)。 */
  casesPerFragment?: number;
  /** 选中片段上限(默认 5)。 */
  maxFragments?: number;
  /** 片段提取嵌套深度上限(默认 3)。 */
  maxDepth?: number;
  /** 是否插桩实跑验证可达性(默认 true;false 时仍实跑录制 expected,但不做 marker 门控)。 */
  verifyReachability?: boolean;
  /** 排序权重 w1·llmRisk + w2·llmFixability + w3·heuristic(默认 0.5/0.3/0.2)。 */
  rankWeights?: RankWeights;
  /** 源方法名(方法体定位;缺省取最后一个候选)。 */
  methodName?: string;
  /** marker 语句构造(按源语言;可注入以便测试)。 */
  markerStatement?: (language: string, fragmentId: string) => string;
}

interface CandidateInput {
  description: string;
  inputs: TypedValue[];
}

interface VerifiedCase {
  case: TestCase;
  markers: string[];
}

/** 启发式预筛进 LLM 打分的候选上限。 */
const PRE_FILTER_N = 8;

/** 可达性失败后反馈重试的最大轮数(Validator 模式,轻量)。 */
const MAX_REACHABILITY_RETRIES = 1;

export const MITGEN_SYSTEM_PROMPT = `You are a micro-level test generation specialist applying fragment-based
test generation. Given a user requirement and a source method decomposed into fragments, you produce structured
JSON outputs that drive directed input generation and translation-risk analysis.
The user REQUIREMENT is the highest priority. The source method is a REFERENCE IMPLEMENTATION that helps you
understand the logic; it is not the ground truth, and its defects must not be inherited.
All outputs must be JSON matching the exact schema shown in each prompt; do not wrap in markdown.`;

function defaultMarkerStatement(language: string, fragmentId: string): string {
  switch (language) {
    case "Python":
      // Python 用分号分隔使 marker 与原语句同行合法(插桩点在缩进之后)。
      return `print("${MARKER_PREFIX}${fragmentId}"); `;
    case "TypeScript":
      return `console.log("${MARKER_PREFIX}${fragmentId}");`;
    case "C#":
      return `System.Console.WriteLine("${MARKER_PREFIX}${fragmentId}");`;
    default:
      return `System.out.println("${MARKER_PREFIX}${fragmentId}");`;
  }
}

function sourceFileFor(language: VerifierLanguage): string {
  switch (language) {
    case "Java":
      return "source.java";
    case "C#":
      return "source.cs";
    case "Python":
      return "source.py";
    case "TypeScript":
      return "source.ts";
  }
}

/** 源语言归一化:MigrationInput.sourceLanguage 是 string,收敛为 VerifierLanguage。 */
function normalizeSourceLanguage(value: string): VerifierLanguage {
  if (value === "Java" || value === "C#" || value === "Python" || value === "TypeScript") return value;
  throw new Error(`MitGen: 不支持的源语言 "${value}"(支持 Java/C#/Python/TypeScript)。`);
}

/** 目标侧语言(description.target.language 只接受 Java/C#)。 */
function targetLanguageOf(language: VerifierLanguage): TargetLanguage {
  return language === "C#" ? "C#" : "Java";
}

/** 从源侧运行结果构造 expected(源侧实跑录制,不依赖 LLM 单点推理)。 */
function expectedFromCaseResult(result: CaseResult): TestCase["expected"] {
  if (result.outcome === "return" && result.returnValue !== undefined) {
    return { kind: "return", value: result.returnValue };
  }
  return {
    kind: "exception",
    type: result.exceptionType ?? "Exception",
    ...(result.exceptionMessage ? { messageContains: result.exceptionMessage } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MitGenMigratorAgent {
  readonly #options: Required<
    Pick<MitGenOptions, "casesPerFragment" | "maxFragments" | "maxDepth" | "verifyReachability" | "rankWeights">
  > &
    MitGenOptions;
  readonly #logger: Logger;

  constructor(options: MitGenOptions) {
    this.#options = {
      casesPerFragment: options.casesPerFragment ?? 3,
      maxFragments: options.maxFragments ?? 5,
      maxDepth: options.maxDepth ?? 3,
      verifyReachability: options.verifyReachability ?? true,
      rankWeights: options.rankWeights ?? DEFAULT_RANK_WEIGHTS,
      ...options,
    };
    this.#logger = options.logger ?? createLogger("mitgen-migrator");
  }

  /**
   * 生成 MitGen 结果:片段级定向输入 + 源侧实跑录制 expected + 可达性验证,
   * 汇总为 schema 兼容 TestDescription(直接喂 verify)。executor 用于源侧实跑。
   */
  async generate(input: MigrationInput, executor: DriverExecutor, signal?: AbortSignal): Promise<MitGenResult> {
    const mi: MitGenMigrationInput = requireMitGenSource(input);
    this.#assertNotAborted(signal);
    this.#logger.info("MitGen.generate 开始");

    const fragments = extractFragments(mi.sourceCode, { maxDepth: this.#options.maxDepth, methodName: this.#options.methodName });
    if (fragments.length === 0) {
      throw new Error("MitGen: 无法从源方法提取任何片段(extractFragments 返回空)。");
    }
    this.#logger.info(`片段划分:共 ${fragments.length} 个片段`);

    // ② 启发式预筛(确定性)→ LLM 单次批量打分 → rankFragments 选 Top-K。
    const preFiltered = [...fragments]
      .sort((a, b) => b.heuristicScore - a.heuristicScore || a.id.localeCompare(b.id))
      .slice(0, PRE_FILTER_N);
    const scores = await this.#scoreFragments(mi, preFiltered, signal);
    const selected = rankFragments(preFiltered, scores, this.#options.rankWeights).slice(0, this.#options.maxFragments);
    this.#logger.info(`片段选择:打分 ${scores.length} 条,选中 ${selected.length} 个片段(${selected.map((f) => f.id).join(", ")})`);

    // ③ 逐片段生成。
    const reports: FragmentReport[] = [];
    const cases: TestCase[] = [];
    for (let i = 0; i < selected.length; i += 1) {
      this.#assertNotAborted(signal);
      const report = await this.#generateForFragment(mi, executor, selected[i] as CodeFragment, signal);
      reports.push(report);
      cases.push(...report.cases);
    }
    if (cases.length === 0) {
      throw new Error("MitGen: 所有选中片段均未产出可达用例(输入生成或可达性验证失败)。");
    }

    // 目标侧片段对应检查(只进报告,不进 verdict)。
    const correspondences = await this.#checkCorrespondence(mi, selected, signal);
    for (const report of reports) {
      const c = correspondences.get(report.fragmentId);
      if (c) {
        report.correspondence = c.correspondence;
        report.correspondenceNote = c.note;
      }
    }

    const description: TestDescription = {
      schemaVersion: "1.0",
      requirement: input.requirement,
      target: {
        language: input.target.language,
        className: input.target.className,
        method: input.target.method,
        isStatic: input.target.isStatic,
        constructorArgs: [],
      },
      cases,
    };
    // 与现有验收同口径:产出描述必须通过 schema 校验。
    validateDescription(description);
    this.#logger.info(`MitGen.generate 完成:${cases.length} 个 case,${reports.length} 个片段报告`);
    return { description, fragments: reports };
  }

  // -- ② 片段打分 -----------------------------------------------------------

  async #scoreFragments(input: MitGenMigrationInput, fragments: CodeFragment[], signal?: AbortSignal): Promise<FragmentScore[]> {
    this.#assertNotAborted(signal);
    const prompt = buildScoringPrompt(input, fragments);
    this.#logger.debug(`buildScoringPrompt 输出:\n${prompt}`);
    try {
      const raw = await runClaude(`${MITGEN_SYSTEM_PROMPT}\n\n${prompt}`, this.#llmOptions());
      const parsed = JSON.parse(extractJson(raw));
      return parseFragmentScores(parsed);
    } catch (error) {
      // 仅 JSON 解析失败可容忍(打分是建议性的,启发式分兜底);LLM 层错误(无 key/子进程失败)原样抛出。
      if (error instanceof SyntaxError || /did not contain a JSON object/.test(errorMessage(error))) {
        this.#logger.warn(`片段打分解析失败,回退启发式排序:${errorMessage(error)}`);
        return [];
      }
      throw error;
    }
  }

  // -- ③ 逐片段生成 ---------------------------------------------------------

  async #generateForFragment(
    input: MitGenMigrationInput,
    executor: DriverExecutor,
    fragment: CodeFragment,
    signal?: AbortSignal,
  ): Promise<FragmentReport> {
    this.#logger.info(`片段 ${fragment.id} (${fragment.kind}) 开始生成`);
    // 1. 定向输入生成(第一次)。
    const candidates = await this.#generateCandidateInputs(input, fragment, signal);
    this.#logger.info(`片段 ${fragment.id}:候选输入 ${candidates.length} 个`);

    // 2. 插桩实跑验证可达性 + 录制 expected。
    let { verified, unreached } = await this.#runAndVerify(input, executor, fragment, candidates);

    // 3. 可达性失败 → 反馈 LLM 重试 1 次(Validator 模式);仍失败丢弃该 case。
    if (this.#options.verifyReachability && unreached.length > 0) {
      this.#logger.info(`片段 ${fragment.id}:${unreached.length} 个输入未到达片段,反馈重试`);
      const retryCandidates = await this.#retryUnreachedInputs(input, fragment, unreached, signal);
      if (retryCandidates.length > 0) {
        const retry = await this.#runAndVerify(input, executor, fragment, retryCandidates);
        verified.push(...retry.verified);
        unreached = retry.unreached;
      }
      if (unreached.length > 0) {
        this.#logger.warn(`片段 ${fragment.id}:重试后仍有 ${unreached.length} 个输入不可达,已丢弃`);
      }
    }

    const cases = verified.map((v) => v.case);
    const reachability: Reachability = this.#options.verifyReachability
      ? verified.length > 0
        ? "verified"
        : "failed"
      : "skipped";
    this.#logger.info(`片段 ${fragment.id} 完成:${cases.length} 个可达 case,可达性=${reachability}`);
    return {
      fragmentId: fragment.id,
      sourceCode: fragment.code,
      correspondence: "unknown",
      correspondenceNote: "",
      cases,
      reachability,
    };
  }

  /** LLM 生成候选整方法输入(受 pathCondition 引导;JSON 收敛为 TypedValue)。 */
  async #generateCandidateInputs(input: MitGenMigrationInput, fragment: CodeFragment, signal?: AbortSignal): Promise<CandidateInput[]> {
    this.#assertNotAborted(signal);
    const signature = this.#methodSignature(input);
    const prompt = buildInputGenerationPrompt(input, fragment, this.#options.casesPerFragment, signature);
    this.#logger.debug(`buildInputGenerationPrompt(${fragment.id}) 输出:\n${prompt}`);
    const raw = await runClaude(`${MITGEN_SYSTEM_PROMPT}\n\n${prompt}`, this.#llmOptions());
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (error) {
      throw new Error(`MitGen 输入生成(片段 ${fragment.id})返回无法解析的 JSON:${errorMessage(error)}`);
    }
    return this.#coerceCandidateInputs(parsed, fragment);
  }

  /** 可达性失败后的反馈重试:重新生成这些输入。 */
  async #retryUnreachedInputs(
    input: MitGenMigrationInput,
    fragment: CodeFragment,
    failed: CandidateInput[],
    signal?: AbortSignal,
  ): Promise<CandidateInput[]> {
    this.#assertNotAborted(signal);
    const prompt = buildRetryInputPrompt(input, fragment, failed);
    this.#logger.debug(`buildRetryInputPrompt(${fragment.id}) 输出:\n${prompt}`);
    const raw = await runClaude(`${MITGEN_SYSTEM_PROMPT}\n\n${prompt}`, this.#llmOptions());
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (error) {
      this.#logger.warn(`片段 ${fragment.id} 重试返回无法解析的 JSON,放弃重试:${errorMessage(error)}`);
      return [];
    }
    return this.#coerceCandidateInputs(parsed, fragment);
  }

  /** 把 LLM 返回的候选输入收敛为 TypedValue 列表(非法条目跳过;相同 inputs 去重)。 */
  #coerceCandidateInputs(parsed: unknown, fragment: CodeFragment): CandidateInput[] {
    const list: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.cases)
        ? ((parsed as { cases: unknown[] }).cases)
        : [];
    const out: CandidateInput[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      const inputs = Array.isArray(record.inputs) ? record.inputs : [];
      if (inputs.length === 0) continue;
      try {
        const coerced = inputs.map(coerceTypedValue) as TypedValue[];
        for (const v of coerced) validateTypedValue(v, `fragment ${fragment.id} inputs`);
        const key = JSON.stringify(coerced);
        if (seen.has(key)) continue; // 相同 inputs 去重
        seen.add(key);
        out.push({ description: typeof record.description === "string" ? record.description : "", inputs: coerced });
      } catch (error) {
        this.#logger.warn(`片段 ${fragment.id} 候选输入非法,跳过:${errorMessage(error)}`);
      }
    }
    return out.slice(0, this.#options.casesPerFragment);
  }

  /** 对每个候选输入:插桩副本实跑,返回可达性(marker 序列)+ 录制结果。 */
  async #runAndVerify(
    input: MitGenMigrationInput,
    executor: DriverExecutor,
    fragment: CodeFragment,
    candidates: CandidateInput[],
  ): Promise<{ verified: VerifiedCase[]; unreached: CandidateInput[] }> {
    const verified: VerifiedCase[] = [];
    const unreached: CandidateInput[] = [];
    for (const candidate of candidates) {
      const run = await this.#runInstrumented(input, executor, fragment, candidate);
      if (run === null) {
        unreached.push(candidate);
        continue;
      }
      const { markers, result } = run;
      if (this.#options.verifyReachability && !markers.includes(fragment.id)) {
        unreached.push(candidate);
        continue;
      }
      verified.push({
        markers,
        case: {
          id: `${fragment.id}-${verified.length + 1}`,
          description: `片段 ${fragment.id} (${fragment.kind}): ${candidate.description || fragment.pathCondition}`,
          inputs: candidate.inputs,
          expected: expectedFromCaseResult(result),
        },
      });
    }
    return { verified, unreached };
  }

  /** 构造插桩副本并实跑:编译失败/运行失败 → null;否则返回 marker 序列与首个 case 结果。 */
  async #runInstrumented(
    input: MitGenMigrationInput,
    executor: DriverExecutor,
    fragment: CodeFragment,
    candidate: CandidateInput,
  ): Promise<{ markers: string[]; result: CaseResult } | null> {
    const language = normalizeSourceLanguage(input.sourceLanguage);
    const markerStatement = this.#options.markerStatement ?? defaultMarkerStatement;
    const instrumented = instrumentFragment(input.sourceCode, fragment, markerStatement(language, fragment.id));
    const invocation = this.#sourceInvocation(input, language);
    const description: TestDescription = {
      schemaVersion: "1.0",
      target: {
        language: targetLanguageOf(language),
        className: invocation.className ?? "",
        method: invocation.method,
        isStatic: invocation.isStatic,
        constructorArgs: [],
      },
      cases: [
        {
          id: "probe",
          inputs: candidate.inputs,
          expected: { kind: "return", value: { type: "null", value: null } },
        },
      ],
    };
    const side: SideSpec = {
      language,
      driverSource: generateSourceDriverSource(description, invocation),
      sourceFiles: [{ relativePath: sourceFileFor(language), content: instrumented }],
    };
    const run: RunOutcome = await executor.run(side);
    if (run.exitCode !== 0) {
      this.#logger.warn(`片段 ${fragment.id} 插桩运行失败(exit=${run.exitCode})`);
      return null;
    }
    const markers = extractMarkers(run.stdout);
    const clean = stripMarkers(run.stdout);
    const results = parseSideResults("source", clean);
    const result = results.results[0];
    if (!result) {
      this.#logger.warn(`片段 ${fragment.id} 插桩运行无可用结果`);
      return null;
    }
    return { markers, result };
  }

  // -- 目标侧片段对应检查 ----------------------------------------------------

  async #checkCorrespondence(
    input: MitGenMigrationInput,
    fragments: CodeFragment[],
    signal?: AbortSignal,
  ): Promise<Map<string, { correspondence: Correspondence; note: string }>> {
    this.#assertNotAborted(signal);
    if (!input.targetCode) {
      this.#logger.debug("未提供 targetCode,correspondence 全部标记 unknown");
      return new Map();
    }
    const prompt = buildCorrespondencePrompt(input, fragments);
    this.#logger.debug(`buildCorrespondencePrompt 输出:\n${prompt}`);
    try {
      const raw = await runClaude(`${MITGEN_SYSTEM_PROMPT}\n\n${prompt}`, this.#llmOptions());
      const parsed = JSON.parse(extractJson(raw)) as unknown;
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.correspondences)
          ? ((parsed as { correspondences: unknown[] }).correspondences)
          : [];
      const valid = new Set<Correspondence>(["equivalent", "missing", "divergent", "unknown"]);
      const map = new Map<string, { correspondence: Correspondence; note: string }>();
      for (const item of list) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        if (typeof record.fragmentId !== "string") continue;
        const c = valid.has(record.correspondence as Correspondence) ? (record.correspondence as Correspondence) : "unknown";
        map.set(record.fragmentId, { correspondence: c, note: typeof record.note === "string" ? record.note : "" });
      }
      return map;
    } catch (error) {
      this.#logger.warn(`correspondence 检查失败,全部标记 unknown:${errorMessage(error)}`);
      return new Map();
    }
  }

  // -- 辅助 ----------------------------------------------------------------

  /** 源侧调用元数据:类名/方法名优先从源码定位,缺省回退 target 信息。 */
  #sourceInvocation(input: MitGenMigrationInput, language: VerifierLanguage): SourceInvocation {
    const located = locateMethod(input.sourceCode, this.#options.methodName);
    const className = located?.className ?? /(?:public\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(input.sourceCode)?.[1];
    return {
      language,
      module: language === "Python" ? "source" : language === "TypeScript" ? "source.ts" : undefined,
      className: className ?? input.target.className,
      method: located?.name ?? this.#options.methodName ?? input.target.method,
      isStatic: true,
      constructorArgs: [],
    };
  }

  /** 方法签名文本(供输入生成 prompt 参考)。 */
  #methodSignature(input: MitGenMigrationInput): string | undefined {
    const located = locateMethod(input.sourceCode, this.#options.methodName);
    if (!located) return undefined;
    const signature = input.sourceCode.slice(0, located.start).trim();
    return signature || undefined;
  }

  #llmOptions(): ClaudeClientOptions {
    return {
      apiKey: this.#options.apiKey,
      model: this.#options.model,
      spawnClaude: this.#options.spawnClaude,
      timeoutMs: this.#options.timeoutMs,
      logger: this.#logger,
    };
  }

  #assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new Error("MitGen.generate aborted by caller signal.");
    }
  }
}
