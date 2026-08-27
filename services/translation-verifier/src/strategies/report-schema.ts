/**
 * 四个策略 runner 的报告 schema 轻量校验(spec §5.4)。
 *
 * 背景:claude 自主会话可能产出「合法 JSON 但缺字段」的报告,若不校验会静默错判
 * (smoke 缺 converged → 落成 fail 而非 error)或 TypeError 逃逸。校验函数在
 * readReport 解析后立即断言顶层必填字段存在且类型正确,失败抛带
 * "report schema 校验失败" 前缀的明确错误 → runner catch 落成 status=error。
 *
 * 校验范围与各 runner 归一化代码直接解引用的字段对齐(轻量、不做深校验)。
 */
import type { SmokeReport } from "../smoke/smoke-types.js";
import type { ConsistencyResult } from "../distinct/consistency-verifier-types.js";
import type { AIDVerificationReport } from "../aid/aid-verifier.js";
import type { MitGenResult } from "../mitgen/types.js";

type FieldType = "boolean" | "number" | "string" | "array" | "object";

/** 顶层必须是对象(非 null/非数组)。 */
function asObject(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`report schema 校验失败: ${path} 应为对象`);
  }
  return raw as Record<string, unknown>;
}

/** 断言字段存在且类型正确,失败抛带前缀的明确错误。 */
function requireField(obj: Record<string, unknown>, key: string, type: FieldType): unknown {
  const value = obj[key];
  const ok = type === "array" ? Array.isArray(value) : typeof value === type;
  if (!ok) {
    throw new Error(`report schema 校验失败: ${key} 字段缺失或类型错误(期望 ${type})`);
  }
  return value;
}

/** smoke:converged boolean + cases 数组 + summary string(归一化直接解引用)。 */
export function assertSmokeReport(raw: unknown): asserts raw is SmokeReport {
  const obj = asObject(raw, "report 顶层");
  requireField(obj, "converged", "boolean");
  requireField(obj, "cases", "array");
  requireField(obj, "summary", "string");
}

/** distinct:report 对象(含 failedCases/passRate/divergentCases 等数值)+ augmented boolean。 */
export function assertDistinctReport(raw: unknown): asserts raw is ConsistencyResult {
  const obj = asObject(raw, "report 顶层");
  const report = requireField(obj, "report", "object") as Record<string, unknown>;
  requireField(report, "failedCases", "number");
  requireField(report, "passRate", "number");
  requireField(report, "passedCases", "number");
  requireField(report, "divergentCases", "number");
  requireField(report, "totalCases", "number");
  requireField(obj, "augmented", "boolean");
}

/** aid:baseline 对象 + failedCases/passRate 数值 + oracleSummary 对象(归一化直接解引用)。 */
export function assertAidReport(raw: unknown): asserts raw is AIDVerificationReport {
  const obj = asObject(raw, "report 顶层");
  requireField(obj, "baseline", "object");
  requireField(obj, "failedCases", "number");
  requireField(obj, "passRate", "number");
  requireField(obj, "oracleSummary", "object");
}

/** mitgen:fragments 数组 + description 对象(description.cases 数组供 summary 计数)。 */
export function assertMitgenReport(raw: unknown): asserts raw is MitGenResult {
  const obj = asObject(raw, "report 顶层");
  requireField(obj, "fragments", "array");
  const description = requireField(obj, "description", "object") as Record<string, unknown>;
  requireField(description, "cases", "array");
}
