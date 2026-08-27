/**
 * AIDVerifier 编排(verifyWithVariants):变体轨道 = 参考组(源+变体) vs 目标(C#)的差分。
 * 流程:变体生成 → 变体过滤(基础输入集 + 同语言差分)→ 输入生成器 → 批量合成
 * → 参考组批量执行 → 共识 oracle(规则 R0)→ 目标执行 → compareAgainstConsensus → 报告。
 * 现有 verify 双轨语义零改动(executeSide 已提取为公共辅助);本模块只新增不侵入。
 */
import { validateAgainstExpected, type CaseComparison } from "../comparator.js";
import type { TestDescription, TypedValue } from "../description.js";
import { generateDriverSource } from "../driver/driver-codegen.js";
import type { DriverExecutor, SideSpec } from "../executor.js";
import { createLogger, type Logger } from "../logger.js";
import type { CaseResult, SideResults } from "../result-capture.js";
import { executeSide } from "../verifier.js";
import {
  DISPUTED_DETAIL_PREFIX,
  buildConsensus,
  compareAgainstConsensus,
  oracleAsResult,
  type ConsensusOracle,
  type ConsensusOptions,
} from "./consensus.js";
import { runInputGenerator, toBatchDescription, type InputGeneratorAgent } from "./input-generator.js";
import {
  buildReferenceSide,
  buildVariantSideSpec,
  filterVariants,
  parseMethodSignature,
  parseSourceContract,
  type FilteredVariant,
  type SourceContract,
} from "./variant-filter.js";
import type { VariantGeneratorAgent } from "./variant-generator.js";

export interface AIDJobOptions {
  /** 生成变体数;默认 3。 */
  variantCount?: number;
  /** 生成器目标输入数;默认 50。 */
  inputCount?: number;
  /** k-共识触发门槛;默认 2。 */
  minAgreeingSides?: number;
}

export interface AIDJob {
  /** 需求 + 目标契约 + 基础 cases(仅用 inputs;expected 保留用于冲突标注)。 */
  description: TestDescription;
  /** 源侧(真实实现;sourceFiles 同时提供源方法文件)。 */
  source: SideSpec;
  /** 目标翻译产物侧。 */
  target: SideSpec;
  options?: AIDJobOptions;
}

/**
 * 可重放的干净 AID 基线。注入测试必须复用这份制品，避免重新生成变体、输入或
 * oracle 后把随机差异误计为缺陷检出。
 *
 * 仅使用数组和普通对象，便于随评估制品保存和重放；`oracle` 不保留运行时 Map。
 */
export interface AIDReplayBaseline {
  schemaVersion: "1.1";
  /** 生成时的原始描述，用于复核声明 expected 与 oracle 的冲突。 */
  description: TestDescription;
  /** 基础用例加上已冻结生成输入后的完整驱动描述。 */
  batchDescription: TestDescription;
  /** 已过滤的变体（含被剔除原因），作为可审计证据。 */
  variants: FilteredVariant[];
  /** 参考组在 batchDescription 上形成的冻结 oracle。 */
  oracle: ConsensusOracle[];
  /** 建立 oracle 时使用的比较选项。 */
  consensusOptions: ConsensusOptions;
  /**
   * clean 目标是否完整执行了 batch 中的每一个 case。若否，不能把后续注入目标的
   * 结果用于检出率，因为它不再与完整的 clean 运行可比。
   */
  cleanTarget: { usable: boolean; note?: string };
  /** 干净目标已失败的 case，注入检测只计算新增失败。 */
  cleanFailedCaseIds: string[];
}

export interface AIDVerificationReport {
  schemaVersion: "1.1";
  /** 变体清单(含剔除者与原因)。 */
  variants: FilteredVariant[];
  oracleSummary: { consensusCount: number; disputedCount: number };
  /** 目标 vs 共识的比较(verdict: pass / fail / divergent[=disputed])。 */
  comparisons: CaseComparison[];
  passRate: number;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  /** 低置信 case 数(disputed,复用 divergent 枚举 + details 标注)。 */
  disputedCases: number;
  /** 共识 vs description.expected 冲突的 caseId 列表(供人工复核与二期演进)。 */
  consensusExpectedConflicts: string[];
  /** 可用于对注入目标进行无 LLM 重放的干净基线。 */
  baseline: AIDReplayBaseline;
}

export async function verifyWithVariants(
  job: AIDJob,
  executor: DriverExecutor,
  agents: { variants: VariantGeneratorAgent; inputs: InputGeneratorAgent },
  logger: Logger = createLogger("aid-verifier"),
): Promise<AIDVerificationReport> {
  const description = job.description;
  const language = job.source.language;
  const sourceContent = job.source.sourceFiles.map((f) => f.content).join("\n");
  const contract = parseSourceContract(sourceContent, language);
  if (!contract) {
    throw new Error(`cannot parse source contract from source side (${language})`);
  }

  const variantCount = job.options?.variantCount ?? 3;
  const inputCount = job.options?.inputCount ?? 50;
  const consensusOptions: ConsensusOptions =
    job.options?.minAgreeingSides === undefined ? {} : { minAgreeingSides: job.options.minAgreeingSides };

  // 1. 变体生成 + 过滤(基础输入集 + 同语言差分)。
  logger.info(`AID 开始:变体生成(${variantCount} 个)→ 过滤 → 输入生成(${inputCount})`);
  const rawVariants = await agents.variants.generateVariants({
    requirement: description.requirement ?? "",
    sourceLanguage: language,
    sourceCode: sourceContent,
    target: {
      className: description.target.className,
      method: description.target.method,
      isStatic: description.target.isStatic,
    },
    variantCount,
  });
  const baseCases = description.cases.map((c) => ({ id: c.id, inputs: c.inputs }));
  const filtered = await filterVariants(rawVariants, { sourceSide: job.source, baseCases, executor, logger });
  const kept = filtered.filter((v) => v.passes);
  logger.info(`AID:变体过滤完成,保留 ${kept.length}/${filtered.length}`);
  if (kept.length === 0) {
    logger.warn("AID:全部变体被过滤,参考组退化为仅源方法(等价现有双轨),AID 不降级失败");
  }

  // 2. 输入生成器(LLM 写脚本 → 执行批量产输入);失败时退化为基础输入集。
  let generatedInputs: TypedValue[][] = [];
  const generatorErrors: string[] = [];
  try {
    const script = await agents.inputs.generate({
      requirement: description.requirement ?? "",
      sourceLanguage: language,
      sourceCode: sourceContent,
      count: inputCount,
      targetSignature: parseMethodSignature(sourceContent, contract),
    });
    const generated = await runInputGenerator(script, inputCount, executor, logger);
    generatedInputs = generated.inputs;
    generatorErrors.push(...generated.errors);
  } catch (error) {
    generatorErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (generatedInputs.length === 0) {
    logger.warn(`AID:输入生成器未产出可用输入(错误:${generatorErrors.join("; ") || "无"}),退化为基础输入集`);
  }

  // 3. 批量合成:基础 cases(回归+冲突标注)+ 生成输入,一次编译一次运行产出全部结果。
  const batchDescription = toBatchDescription(description, generatedInputs);

  // 4. 参考组批量执行(源 + 保留变体)。
  const referenceSides: SideResults[] = [];
  const runReferenceSide = async (side: SideSpec, label: string): Promise<void> => {
    const info = await executeSide(executor, side, label);
    if (info.results && info.results.results.length > 0) referenceSides.push(info.results);
  };
  await runReferenceSide(
    buildReferenceSide(batchDescription, language, contract, { sourceFiles: job.source.sourceFiles }),
    "source",
  );
  for (let i = 0; i < kept.length; i += 1) {
    const variant = kept[i] as FilteredVariant;
    const spec = buildVariantSideSpec(batchDescription, language, contract, variant.code, i + 1);
    await runReferenceSide(spec, `Variant_${i + 1}`);
  }
  logger.info(`AID:参考组执行完成,${referenceSides.length} 侧有可用结果`);

  // 5. 共识 oracle(规则 R0)。
  const oracle = buildConsensus(referenceSides, consensusOptions);

  // 6. 目标侧批量执行 + 与共识比较。
  const { targetInfo, comparisons } = await compareTargetAgainstOracle(
    job.target,
    batchDescription,
    oracle,
    consensusOptions,
    executor,
  );
  const baseline = createReplayBaseline(
    description,
    batchDescription,
    filtered,
    oracle,
    consensusOptions,
    comparisons,
    assessCompleteTargetRun(targetInfo, batchDescription),
  );
  return buildReport(description, filtered, baseline, oracle, comparisons, targetInfo.results?.results ?? [], logger);
}

/**
 * 使用已经冻结的 clean 基线验证另一个目标实现。这个路径绝不调用 LLM、过滤变体、
 * 执行源侧或执行变体，因此注入试验与 clean 试验使用完全相同的输入和 oracle。
 */
export async function verifyTargetAgainstAIDBaseline(
  target: SideSpec,
  baseline: AIDReplayBaseline,
  executor: DriverExecutor,
  logger: Logger = createLogger("aid-verifier"),
): Promise<AIDVerificationReport> {
  const oracle = new Map(baseline.oracle.map((entry) => [entry.caseId, entry]));
  const { targetInfo, comparisons } = await compareTargetAgainstOracle(
    target,
    baseline.batchDescription,
    oracle,
    baseline.consensusOptions,
    executor,
  );
  return buildReport(
    baseline.description,
    baseline.variants,
    baseline,
    oracle,
    comparisons,
    targetInfo.results?.results ?? [],
    logger,
  );
}

async function compareTargetAgainstOracle(
  target: SideSpec,
  batchDescription: TestDescription,
  oracle: Map<string, ConsensusOracle>,
  consensusOptions: ConsensusOptions,
  executor: DriverExecutor,
): Promise<{ targetInfo: Awaited<ReturnType<typeof executeSide>>; comparisons: CaseComparison[] }> {
  const targetBatchSide: SideSpec = {
    language: target.language,
    driverSource: generateDriverSource(batchDescription),
    sourceFiles: target.sourceFiles,
  };
  const targetInfo = await executeSide(executor, targetBatchSide, "target");
  const comparisons =
    targetInfo.results && targetInfo.results.results.length > 0
      ? compareAgainstConsensus(targetInfo.results, oracle, consensusOptions)
      : batchDescription.cases.map((c) => ({
          caseId: c.id,
          verdict: "divergent" as const,
          source: null,
          target: null,
          details: ["Target side produced no usable results."],
        }));
  return { targetInfo, comparisons };
}

function createReplayBaseline(
  description: TestDescription,
  batchDescription: TestDescription,
  variants: FilteredVariant[],
  oracle: Map<string, ConsensusOracle>,
  consensusOptions: ConsensusOptions,
  comparisons: CaseComparison[],
  cleanTarget: AIDReplayBaseline["cleanTarget"],
): AIDReplayBaseline {
  return {
    schemaVersion: "1.1",
    description,
    batchDescription,
    variants,
    oracle: [...oracle.values()],
    consensusOptions,
    cleanTarget,
    cleanFailedCaseIds: comparisons.filter((comparison) => comparison.verdict === "fail").map((comparison) => comparison.caseId),
  };
}

/** 评估 clean 目标是否提供了与冻结 batch 完整对应的可比结果。 */
function assessCompleteTargetRun(
  target: Awaited<ReturnType<typeof executeSide>>,
  batchDescription: TestDescription,
): AIDReplayBaseline["cleanTarget"] {
  if (!target.compile.success) return { usable: false, note: "target-compile-failed" };
  if (target.run === null || target.run.exitCode !== 0) return { usable: false, note: "target-run-failed" };
  if (target.results === null || target.results.results.length === 0) {
    return { usable: false, note: "target-results-unusable" };
  }
  const resultIds = new Set(target.results.results.map((result) => result.caseId));
  const missingCaseIds = batchDescription.cases.filter((testCase) => !resultIds.has(testCase.id)).map((testCase) => testCase.id);
  if (missingCaseIds.length > 0) {
    return { usable: false, note: `target-results-incomplete:${missingCaseIds.join(",")}` };
  }
  return { usable: true };
}

function buildReport(
  description: TestDescription,
  variants: FilteredVariant[],
  baseline: AIDReplayBaseline,
  oracle: Map<string, ConsensusOracle>,
  comparisons: CaseComparison[],
  targetResults: CaseResult[],
  logger: Logger,
): AIDVerificationReport {
  const oracles = [...oracle.values()];
  const consensusCount = oracles.filter((o) => o.confidence === "consensus").length;
  const disputedCount = oracles.filter((o) => o.confidence === "disputed").length;
  const passedCases = comparisons.filter((c) => c.verdict === "pass").length;
  const failedCases = comparisons.filter((c) => c.verdict === "fail").length;
  const disputedCases = comparisons.filter(
    (c) => c.verdict === "divergent" && c.details.some((d) => d.startsWith(DISPUTED_DETAIL_PREFIX)),
  ).length;
  const totalCases = comparisons.length;
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases;
  const consensusExpectedConflicts = computeConsensusExpectedConflicts(description, oracle, targetResults);

  logger.info(
    `AID 完成:passRate=${passRate.toFixed(2)} (pass=${passedCases} fail=${failedCases} disputed=${disputedCases}), oracle consensus=${consensusCount} disputed=${disputedCount}`,
  );
  return {
    schemaVersion: "1.1",
    variants,
    oracleSummary: { consensusCount, disputedCount },
    comparisons,
    passRate,
    totalCases,
    passedCases,
    failedCases,
    disputedCases,
    consensusExpectedConflicts,
    baseline,
  };
}

/** 共识 vs description.expected 冲突:基础 case 上共识为 consensus 且与声明期望不一致 → 冲突。 */
function computeConsensusExpectedConflicts(
  description: TestDescription,
  oracle: Map<string, ConsensusOracle>,
  targetResults: CaseResult[],
): string[] {
  const conflicts: string[] = [];
  for (const c of description.cases) {
    const o = oracle.get(c.id);
    if (!o) continue;
    if (o.confidence === "disputed") {
      conflicts.push(
        `${c.id} (reference group disagrees on this case; declared expectation cannot be verified by consensus)`,
      );
      continue;
    }
    const issues = validateAgainstExpected(oracleAsResult(o), c.expected);
    if (issues.length > 0) {
      conflicts.push(`${c.id} (consensus differs from declared expected: ${issues.join("; ")})`);
    }
  }
  void targetResults;
  return conflicts;
}
