/**
 * 统一测试质量评估框架 — 类型定义。
 *
 * 与 .superpowers/sdd/4-test-methods/quality/quality-spec.md 第二节契约严格对齐:
 * - 2.1 GeneratorAdapter 接口(QualityTask / GeneratedTest / GeneratorAdapter);
 * - 2.2 五维指标(QualityMetrics);
 * - 2.3 评估器输出(evaluate)。
 *
 * 适配器真实 LLM 调用统一走 claude-client.ts(可注入 spawnClaude);执行统一走
 * DriverExecutor(可注入 FakeDriverExecutor,单测友好)。
 */
import type { TestDescription, TypedValue, VerifierLanguage } from "../description.js";
import type { SideSpec } from "../executor.js";
import type { SmokeReport } from "../smoke/smoke-types.js";
import type { InjectedBugKind } from "../bug-injection.js";
import type { AIDReplayBaseline } from "../aid/aid-verifier.js";

// ---------------------------------------------------------------------------
// 数据集(数据集 agent 产出,评估框架消费)
// ---------------------------------------------------------------------------

/** 检索侧(Java 源骨架)描述:语言 + 仓库相对路径 + 类/方法签名。 */
export interface DatasetEntrySource {
  language: string;
  file: string;
  className: string;
  method: string;
  /** 源方法是否静态(驱动生成需要);缺省按静态处理。 */
  isStatic?: boolean;
  constructorArgs?: TypedValue[];
}

/** 翻译侧(C#)描述:语言 + 仓库相对路径 + 类/方法签名。 */
export interface DatasetEntryTarget {
  language: string;
  file: string;
  className: string;
  method: string;
  isStatic: boolean;
  constructorArgs: TypedValue[];
}

/** 数据集单条 entry:需求 + 双侧文件与签名 + 需求差异标注(conformance 评估的 ground truth)。 */
export interface DatasetEntry {
  id: string;
  requirement: string;
  source: DatasetEntrySource;
  target: DatasetEntryTarget;
  /** 需求与检索代码的显式差异清单(conformance 评审的基准,不直接喂给生成器)。 */
  requirementDiffs: string[];
  notes?: string;
}

/** 数据集文件 schema(commons-fileupload-31.json)。 */
export interface QualityDataset {
  schemaVersion: string;
  source: string;
  entries: DatasetEntry[];
}

// ---------------------------------------------------------------------------
// 评估任务与生成器契约(quality-spec 2.1)
// ---------------------------------------------------------------------------

/**
 * 单条评估任务:数据集 entry + 双侧 SideSpec 模板。
 * 注意:source/target 的 driverSource 依赖生成的描述(驱动由描述推导),
 * 框架按「语言 + sourceFiles + projectRoot」构造模板,实际驱动在度量阶段按
 * 生成的测试重建(见 metrics.buildDescriptionSides)。
 */
export interface QualityTask {
  entry: DatasetEntry;
  source: SideSpec;
  target: SideSpec;
}

/** 生成器产出的测试:描述型(schema)或 runner 型(冒烟)。 */
export interface GeneratedTest {
  kind: "description" | "runner";
  description?: TestDescription;
  runner?: {
    language: VerifierLanguage;
    /** 目标侧 runner 文件(至少含目标侧驱动入口;smoke 适配器额外携带源侧 runner)。 */
    files: { path: string; content: string }[];
    /** smoke 的 SmokeReport(含 judge 决策,即检出信号来源)。 */
    report?: SmokeReport;
  };
  meta: {
    /** 生成过程 LLM 调用次数(经计数 spawnClaude 包装统计,含重试)。 */
    llmCalls: number;
    durationMs?: number;
    /** 适配器附加信号(distinct 的 flag-fail、aid 的共识差分等,仅供报告可观测)。 */
    signal?: { kind: string; caseIds?: string[]; detail?: string };
    /** AID clean run 的冻结证据，用于后续注入目标的无 LLM 重放。 */
    aidBaseline?: AIDReplayBaseline;
  };
}

/** 生成器适配器名称(与 quality-spec 2.4 一致)。 */
export type GeneratorName = "baseline" | "smoke" | "distinct" | "aid" | "mitgen";

/** 统一生成器适配器接口(quality-spec 2.1,签名严格对齐)。 */
export interface GeneratorAdapter {
  name: GeneratorName;
  generateTest(task: QualityTask, signal?: AbortSignal): Promise<GeneratedTest>;
}

// ---------------------------------------------------------------------------
// 五维指标(quality-spec 2.2)
// ---------------------------------------------------------------------------

/** conformance 评审三态判定。 */
export interface ConformanceJudgement {
  verdict: "conforms" | "diverges" | "unverified";
  reasoning: string;
}

/** 单次注入检测试验。 */
export interface DetectionTrial {
  kind: InjectedBugKind;
  detected: boolean;
  /** 无效原因(target-compile-failed / source-unusable / clean-already-violating / no-runner 等)。 */
  note?: string;
  /**
   * 是否能作为检出率分母。缺省兼容旧制品：无 note = eligible，有 note = unverified。
   * injection-failed 单独计数，不能悄悄从报告中消失。
   */
  status?: "eligible" | "injection-failed" | "unverified";
}

/** 单 entry 单适配器的度量明细。 */
export interface PerEntryResult {
  entryId: string;
  /** 生成是否成功(失败时其余字段按空值)。 */
  generated: boolean;
  error?: string;
  /** CSR:目标侧编译是否通过。 */
  csr: boolean;
  /** conformance 三态评审;--skip-conformance 或评审失败时为 null。 */
  conformance: ConformanceJudgement | null;
  /** 各注入策略的检出试验。 */
  detections: DetectionTrial[];
  /** 干净翻译误报(true = 测试在干净目标上误报)。 */
  falsePositive: boolean;
  fpNote?: string;
  /** 生成成本:LLM 调用次数。 */
  llmCalls: number;
  /** 适配器附加信号(distinct flag-fail / aid 检出等)。 */
  signal?: { kind: string; caseIds?: string[]; detail?: string };
}

/** 单适配器五维汇总(quality-spec 2.3 的 per-adapter 结构)。 */
export interface QualityMetrics {
  /** CSR 编译通过率:成功生成且目标侧编译通过的 entry 占比。 */
  csr: number;
  conformance: {
    /** 已评审 entry 数。 */
    judged: number;
    conforms: number;
    diverges: number;
    unverified: number;
    /** conforms / (conforms + diverges);无有效判定时为 0。 */
    rate: number;
  };
  /** 检出率:检出试验数 / 有效试验数(排除注明的无效试验)。 */
  detectionRate: number;
  /** 检出率分母和注入失败的透明统计。 */
  detection: {
    attempted: number;
    eligible: number;
    injectionFailed: number;
    unverified: number;
    detected: number;
  };
  /** 误报率:干净目标误报 entry 数 / 有效 entry 数。 */
  falsePositiveRate: number;
  /** 成本:生成 LLM 调用总次数。 */
  llmCalls: number;
  perEntry: PerEntryResult[];
}

/** 评估模式:quick = 抽样 + 单注入策略;full = 全部 entry + 4 策略。 */
export type EvaluationMode = "quick" | "full";
