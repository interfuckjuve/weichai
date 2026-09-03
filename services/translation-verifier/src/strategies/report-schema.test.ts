import { describe, expect, it } from "vitest";
import { validSmokeCase, validSmokeReport } from "../smoke-test-fixtures.js";
import { assertSmokeReport } from "./report-schema.js";

describe("assertSmokeReport", () => {
  it("合法顶层字段通过且类型收窄(多余字段不拒绝)", () => {
    const raw: unknown = validSmokeReport();
    expect(() => assertSmokeReport(raw)).not.toThrow();
  });

  it("顶层非对象(数组/null/原始值)→ 抛 校验失败", () => {
    expect(() => assertSmokeReport([])).toThrow(/校验失败: report 顶层 应为对象/);
    expect(() => assertSmokeReport(null)).toThrow(/report 顶层 应为对象/);
    expect(() => assertSmokeReport("text")).toThrow(/report 顶层 应为对象/);
  });

  it("缺 converged(JSON.stringify 会丢弃 undefined)→ 抛明确错误,不得静默通过", () => {
    const { converged: _omit, ...rest } = validSmokeReport();
    expect(() => assertSmokeReport(rest)).toThrow(/converged 字段缺失或类型错误/);
  });

  it("converged 非 boolean → 抛明确错误", () => {
    expect(() => assertSmokeReport({ ...validSmokeReport(), converged: "yes" })).toThrow(/converged 字段缺失或类型错误/);
  });

  it("cases 非数组 / summary 非 string → 抛明确错误", () => {
    expect(() => assertSmokeReport({ ...validSmokeReport(), cases: {} })).toThrow(/cases 字段缺失或类型错误/);
    expect(() => assertSmokeReport({ ...validSmokeReport(), summary: 1 })).toThrow(/summary 字段缺失或类型错误/);
  });

  describe("深校验", () => {
    it("拒绝空 cases 和重复 caseId", () => {
      expect(() => assertSmokeReport({ ...validSmokeReport(), cases: [] }, "verify-only")).toThrow(/cases.*non-empty/);
      const c = validSmokeCase();
      expect(() => assertSmokeReport({ ...validSmokeReport(), cases: [c, c] }, "verify-only")).toThrow(/duplicate.*c1/);
    });

    it("拒绝 case 内外 ID 不一致和缺双侧 runner", () => {
      const broken = validSmokeCase();
      broken.target = { ...broken.target!, caseId: "other" };
      expect(() => assertSmokeReport({ ...validSmokeReport(), cases: [broken] }, "verify-only")).toThrow(/target.*caseId/);
      expect(() => assertSmokeReport({ ...validSmokeReport(), runnerFiles: validSmokeReport().runnerFiles!.slice(0, 1) }, "verify-only")).toThrow(/runnerFiles.*target/);
    });

    it("拒绝逃逸路径、未知枚举和超限文本", () => {
      expect(() => assertSmokeReport({ ...validSmokeReport(), summary: "x".repeat(100_001) }, "verify-only")).toThrow(/summary.*size/);
      const report = validSmokeReport();
      report.runnerFiles![0].files[0].path = "../Shadow.java";
      expect(() => assertSmokeReport(report, "verify-only")).toThrow(/runnerFiles.*path/);
      expect(() => assertSmokeReport({ ...validSmokeReport(), cases: [{ ...validSmokeCase(), decision: "maybe" }] }, "verify-only"))
        .toThrow(/decision/);
    });

    it("verify-only 拒绝目标修复报告", () => {
      expect(() => assertSmokeReport({ ...validSmokeReport(), rounds: 1 }, "verify-only")).toThrow(/rounds/);
      expect(() => assertSmokeReport({ ...validSmokeReport(), targetFiles: [{ path: "Target.cs", content: "changed" }] }, "verify-only")).toThrow(/targetFiles/);
    });
  });
});
