/**
 * 共识 oracle 与差分比较(规则 R0,不采用多数投票 —— 多数投票会被相似缺陷污染)。
 *
 * 对输入 i,参考组 {源} ∪ {变体} 的执行输出构成集合 O(去重):
 * - |O| = 1(参考组全一致):共识 = 唯一输出;目标 ≠ 共识 → fail;= → pass;
 * - |O| > 1 且 目标输出 ∉ O:目标与所有参考都不同 → fail(高置信,多样性优先的核心);
 * - |O| > 1 且 目标输出 ∈ O:disputed(低置信,不判 fail,报告标记待复核);
 * - k-共识辅助:若存在子集 S ⊆ O 且 |S| ≥ minAgreeingSides(默认 2)共享同一输出、
 *   目标 ≠ S 输出 → fail(对应论文 DFP 的「≥2 变体一致触发」)。
 *
 * disputed 复用现有 "divergent" 枚举 + details 标注(开放问题 1 的一期选择:不扩展枚举)。
 */
import { DEFAULT_EXCEPTION_ALIASES, valuesEqual, type CaseComparison, type ComparisonOptions } from "../comparator.js";
import type { TypedValue } from "../description.js";
import type { CaseResult, SideResults } from "../result-capture.js";

/** disputed 判定在 details 中的稳定标注前缀(消费方凭此前缀识别低置信 case)。 */
export const DISPUTED_DETAIL_PREFIX = "disputed:";

export interface ConsensusOracle {
  caseId: string;
  outcome: "return" | "exception";
  returnValue?: TypedValue;
  /** 归一化后的异常类型(跨语言别名映射后)。 */
  exceptionType?: string;
  /** |O|=1 → consensus;|O|>1 → disputed。 */
  confidence: "consensus" | "disputed";
  /** 与「共识输出」一致的参考数(分歧时取源侧输出,缺失取 count 最大组)。 */
  agreeingSides: number;
  totalSides: number;
  details: string[];
  /** 实现扩展:参考组全部去重输出组(R0 判 disputed/fail 需要全集,k-共识统计依赖它)。 */
  distinctOutputs: ConsensusOutputGroup[];
}

export interface ConsensusOutputGroup {
  outcome: "return" | "exception";
  returnValue?: TypedValue;
  exceptionType?: string;
  /** 产出该输出的参考侧数。 */
  count: number;
  sideLabels: string[];
}

export interface ConsensusOptions extends ComparisonOptions {
  /** k-共识触发门槛;默认 2(DFP「≥2 变体一致」)。 */
  minAgreeingSides?: number;
}

const DEFAULT_MIN_AGREEING_SIDES = 2;

// ---------------------------------------------------------------------------
// buildConsensus:参考组执行结果 → 每 case 一个 ConsensusOracle
// ---------------------------------------------------------------------------

export function buildConsensus(
  referenceSides: SideResults[],
  options: ConsensusOptions = {},
): Map<string, ConsensusOracle> {
  const aliases = { ...DEFAULT_EXCEPTION_ALIASES, ...(options.exceptionAliases ?? {}) };
  const oracle = new Map<string, ConsensusOracle>();
  const caseIds = new Set(referenceSides.flatMap((s) => s.results.map((r) => r.caseId)));

  for (const caseId of caseIds) {
    const groups = new Map<string, ConsensusOutputGroup>();
    let totalSides = 0;
    for (const side of referenceSides) {
      const result = side.results.find((r) => r.caseId === caseId);
      if (!result) continue;
      totalSides += 1;
      const key = outputKey(result, aliases);
      let group = groups.get(key);
      if (!group) {
        group =
          result.outcome === "return"
            ? { outcome: "return", returnValue: result.returnValue, count: 0, sideLabels: [] }
            : {
                outcome: "exception",
                exceptionType: normalizeExceptionType(result.exceptionType ?? "", aliases),
                count: 0,
                sideLabels: [],
              };
        groups.set(key, group);
      }
      group.count += 1;
      group.sideLabels.push(side.side);
    }
    if (totalSides === 0) continue;

    const groupList = [...groups.values()];
    const consensus = groupList.length === 1;
    // 共识输出:全一致 → 唯一输出;分歧 → 优先取源侧输出(源方法是参考锚),缺失取 count 最大组。
    let primary = groupList[0] as ConsensusOutputGroup;
    if (!consensus) {
      const sourceSide = referenceSides.find((s) => s.side === "source");
      const sourceResult = sourceSide?.results.find((r) => r.caseId === caseId);
      const sourceKey = sourceResult ? outputKey(sourceResult, aliases) : undefined;
      const sourceGroup = sourceKey ? groups.get(sourceKey) : undefined;
      primary = sourceGroup ?? primary;
    }

    const details: string[] = [];
    if (!consensus) {
      details.push(`${DISPUTED_DETAIL_PREFIX} reference group disagrees (${groupList.length} distinct outputs)`);
      for (const g of groupList) {
        details.push(`  - ${g.count} side(s) [${g.sideLabels.join(", ")}] -> ${describeGroup(g)}`);
      }
    }

    oracle.set(caseId, {
      caseId,
      outcome: primary.outcome,
      returnValue: primary.outcome === "return" ? primary.returnValue : undefined,
      exceptionType: primary.outcome === "exception" ? primary.exceptionType : undefined,
      confidence: consensus ? "consensus" : "disputed",
      agreeingSides: primary.count,
      totalSides,
      details,
      distinctOutputs: groupList,
    });
  }
  return oracle;
}

// ---------------------------------------------------------------------------
// compareAgainstConsensus:目标输出 vs 共识 oracle → CaseComparison[]
// ---------------------------------------------------------------------------

export function compareAgainstConsensus(
  target: SideResults,
  oracle: Map<string, ConsensusOracle>,
  options: ConsensusOptions = {},
): CaseComparison[] {
  const minAgreeing = options.minAgreeingSides ?? DEFAULT_MIN_AGREEING_SIDES;
  const aliases = { ...DEFAULT_EXCEPTION_ALIASES, ...(options.exceptionAliases ?? {}) };
  const targetByCase = new Map(target.results.map((r) => [r.caseId, r]));
  const caseIds = new Set([...oracle.keys(), ...targetByCase.keys()]);
  const comparisons: CaseComparison[] = [];

  for (const caseId of caseIds) {
    const o = oracle.get(caseId);
    const t = targetByCase.get(caseId) ?? null;
    if (!o || !t) {
      comparisons.push({
        caseId,
        verdict: "divergent",
        source: o ? oracleAsResult(o) : null,
        target: t,
        details: [o ? "Target side did not produce this case." : "No consensus oracle for this case."],
      });
      continue;
    }

    if (o.confidence === "consensus") {
      const issues = resultDiffersFromOracle(t, o, options);
      comparisons.push({
        caseId,
        verdict: issues.length === 0 ? "pass" : "fail",
        source: oracleAsResult(o),
        target: t,
        details: issues.length === 0 ? [] : [`oracle=${describeOracle(o)}`, ...issues],
      });
      continue;
    }

    // disputed:参考组内部不一致。
    const targetGroup = o.distinctOutputs.find((g) => targetMatchesGroup(t, g, options));
    if (!targetGroup) {
      // 目标输出与所有参考都不同 → 高置信 fail(多样性优先的核心:不需要多数一致也能触发)。
      comparisons.push({
        caseId,
        verdict: "fail",
        source: oracleAsResult(o),
        target: t,
        details: [
          `${DISPUTED_DETAIL_PREFIX} target differs from ALL ${o.totalSides} reference outputs`,
          ...o.details,
        ],
      });
      continue;
    }
    // 目标 ∈ O:disputed。k-共识辅助 —— 当「目标与源侧参考锚不一致」且存在 count ≥ minAgreeingSides
    // 且不含目标的输出组时提升为 fail(对应论文 DFP 的「≥2 变体一致触发」)。
    // 目标与源一致时不做提升:参考组内部分歧是「变体 vs 源」问题而非目标问题,归 disputed(避免误报)。
    const sourceGroup = o.distinctOutputs.find((g) => g.sideLabels.includes("source"));
    const sourceMatchesTarget = sourceGroup !== undefined && targetMatchesGroup(t, sourceGroup, options);
    const strongGroup = !sourceMatchesTarget
      ? o.distinctOutputs.find((g) => g.count >= minAgreeing && !targetMatchesGroup(t, g, options))
      : undefined;
    if (strongGroup) {
      comparisons.push({
        caseId,
        verdict: "fail",
        source: oracleAsResult(o),
        target: t,
        details: [
          `${DISPUTED_DETAIL_PREFIX} target matches ${targetGroup.count} reference(s) but conflicts with a ${strongGroup.count}-side consensus`,
          ...o.details,
        ],
      });
      continue;
    }
    // 低置信:目标与某个参考一致但参考组内部不一致 → disputed(复用 divergent 枚举 + details 标注)。
    comparisons.push({
      caseId,
      verdict: "divergent",
      source: oracleAsResult(o),
      target: t,
      details: [
        `${DISPUTED_DETAIL_PREFIX} reference group disagrees; target matches one reference — low confidence, needs review`,
        ...o.details,
      ],
    });
  }
  return comparisons;
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

/** 目标结果是否命中某输出组(return → valuesEqual;exception → 归一化类型相等)。 */
function targetMatchesGroup(t: CaseResult, g: ConsensusOutputGroup, options: ConsensusOptions): boolean {
  if (t.outcome !== g.outcome) return false;
  if (g.outcome === "exception") {
    const aliases = { ...DEFAULT_EXCEPTION_ALIASES, ...(options.exceptionAliases ?? {}) };
    return normalizeExceptionType(t.exceptionType ?? "", aliases) === g.exceptionType;
  }
  if (t.returnValue === undefined || g.returnValue === undefined) return false;
  return valuesEqual(t.returnValue, g.returnValue, options);
}

/** 目标结果 vs 共识 oracle 的差异(空数组 = 一致)。 */
function resultDiffersFromOracle(t: CaseResult, o: ConsensusOracle, options: ConsensusOptions): string[] {
  if (t.outcome !== o.outcome) {
    return [
      `behavior divergence: oracle ${o.outcome} but target ${t.outcome === "return" ? "return" : `exception ${t.exceptionType ?? ""}`}`,
    ];
  }
  if (o.outcome === "exception") {
    const aliases = { ...DEFAULT_EXCEPTION_ALIASES, ...(options.exceptionAliases ?? {}) };
    if (normalizeExceptionType(t.exceptionType ?? "", aliases) !== o.exceptionType) {
      return [`exception type mismatch: oracle ${o.exceptionType} vs target ${t.exceptionType}`];
    }
    return [];
  }
  if (t.returnValue === undefined || o.returnValue === undefined) return ["one side returned no value"];
  if (valuesEqual(t.returnValue, o.returnValue, options)) return [];
  return [
    "return value mismatch",
    `oracle: ${JSON.stringify(o.returnValue)}`,
    `target: ${JSON.stringify(t.returnValue)}`,
  ];
}

/** 共识 oracle 以 CaseResult 形式呈现(作为比较的 source 侧,便于 RepairLoop 判据复用)。 */
export function oracleAsResult(o: ConsensusOracle): CaseResult {
  return o.outcome === "return"
    ? { caseId: o.caseId, outcome: "return", returnValue: o.returnValue }
    : { caseId: o.caseId, outcome: "exception", exceptionType: o.exceptionType };
}

/** 结果 → 规范化分组键(异常:归一化类型;返回值:canonical JSON,map 键排序)。 */
function outputKey(result: CaseResult, aliases: Record<string, string>): string {
  if (result.outcome === "exception") {
    return `exc:${normalizeExceptionType(result.exceptionType ?? "", aliases)}`;
  }
  return `ret:${JSON.stringify(canonicalValue(result.returnValue))}`;
}

function canonicalValue(value: TypedValue | undefined): unknown {
  if (value === undefined) return "<undefined>";
  switch (value.type) {
    case "string":
      return { type: "string", value: value.value };
    case "number":
      return { type: "number", value: value.value };
    case "boolean":
      return { type: "boolean", value: value.value };
    case "null":
      return { type: "null", value: null };
    case "list":
      return { type: "list", value: value.value.map(canonicalValue) };
    case "map": {
      const entries = Object.entries(value.value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return { type: "map", value: entries.map(([k, v]) => [k, canonicalValue(v)]) };
    }
  }
}

function normalizeExceptionType(type: string, aliases: Record<string, string>): string {
  const simple = type.split(".").at(-1) ?? type;
  return aliases[simple] ?? simple;
}

function describeGroup(g: ConsensusOutputGroup): string {
  if (g.outcome === "exception") return `exception ${g.exceptionType ?? ""}`;
  return `return ${JSON.stringify(g.returnValue)}`;
}

function describeOracle(o: ConsensusOracle): string {
  if (o.outcome === "exception") return `exception ${o.exceptionType ?? ""}`;
  return `return ${JSON.stringify(o.returnValue)}`;
}
