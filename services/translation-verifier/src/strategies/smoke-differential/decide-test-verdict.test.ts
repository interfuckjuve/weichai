import { describe, expect, it } from "vitest";
import { validCommandEvidence, validSmokeCase, validSmokeReport } from "./differential-test-fixtures.js";
import type { CommandEvidence, SmokeReport } from "./differential-test-types.js";
import { evaluateSmokeReport } from "./decide-test-verdict.js";

describe("evaluateSmokeReport", () => {
  it("只有 translation-bug 产生 fail", () => {
    const report = validSmokeReport();
    report.cases = [validSmokeCase("translation-bug")];
    const result = evaluateSmokeReport(report, validCommandEvidence(), "verify-only");
    expect(result.status).toBe("fail");
    expect(result.bugCases.map((item) => item.caseId)).toEqual(["c1"]);
  });

  it.each(["accepted-diff", "pass"] as const)("%s 且证据完整时通过", (decision) => {
    const report = validSmokeReport();
    report.cases = [validSmokeCase(decision)];
    expect(evaluateSmokeReport(report, validCommandEvidence(), "verify-only").status).toBe("pass");
  });

  it("unclear、零 case 和证据不一致均为 unverified", () => {
    const unclear = validSmokeReport();
    unclear.cases = [validSmokeCase("unclear")];
    expect(evaluateSmokeReport(unclear, validCommandEvidence(), "verify-only").status).toBe("unverified");
    expect(evaluateSmokeReport(validSmokeReport(), [], "verify-only").reason).toBe("invalid-evidence");
  });

  describe("证据信任门控(禁止误判 pass)", () => {
    const result = (evidence: CommandEvidence[], report: SmokeReport = validSmokeReport()) =>
      evaluateSmokeReport(report, evidence, "verify-only");
    const expectRejected = (evaluation: ReturnType<typeof evaluateSmokeReport>) => {
      expect(evaluation.status).toBe("unverified");
      expect(evaluation.reason).toBe("invalid-evidence");
      expect(evaluation.bugCases).toEqual([]);
    };

    it("commandId 匹配到重复证据(多于一条)→ 拒绝", () => {
      const evidence = validCommandEvidence();
      evidence.push({ ...evidence[0], commandId: "source-compile" });
      expectRejected(result(evidence));
    });

    it("证据 side 与报告声明不一致 → 拒绝", () => {
      const evidence = validCommandEvidence();
      evidence[1] = { ...evidence[1], side: "target" };
      expectRejected(result(evidence));
    });

    it("证据 phase 与报告声明不一致 → 拒绝", () => {
      const evidence = validCommandEvidence();
      evidence[2] = { ...evidence[2], phase: "run" };
      expectRejected(result(evidence));
    });

    it("证据 exitCode 与报告声明不一致 → 拒绝", () => {
      const evidence = validCommandEvidence();
      evidence[3] = { ...evidence[3], exitCode: 5 };
      expectRejected(result(evidence));
    });

    it("证据 baselineValid=false → 拒绝", () => {
      const evidence = validCommandEvidence();
      evidence[0] = { ...evidence[0], baselineValid: false };
      expectRejected(result(evidence));
    });

    it("证据 timedOut=true → 拒绝", () => {
      const evidence = validCommandEvidence();
      evidence[0] = { ...evidence[0], timedOut: true };
      expectRejected(result(evidence));
    });

    it("证据 exitCode 非零(报告如实声明)→ 拒绝", () => {
      const report = validSmokeReport();
      report.executions![0] = { ...report.executions![0], exitCode: 5 };
      const evidence = validCommandEvidence();
      evidence[0] = { ...evidence[0], exitCode: 5 };
      expectRejected(result(evidence, report));
    });

    it("verify-only 报告携带 rounds>0 目标修复 → 拒绝(兜底)", () => {
      const report = validSmokeReport();
      report.rounds = 1;
      expectRejected(result(validCommandEvidence(), report));
    });

    it("verify-only 报告携带非空 targetFiles → 拒绝(兜底)", () => {
      const report = validSmokeReport();
      report.targetFiles = [{ path: "Target.cs", content: "changed" }];
      expectRejected(result(validCommandEvidence(), report));
    });

    it("同形报告在 diagnostic-repair 模式不触发 verify-only 兜底", () => {
      const report = validSmokeReport();
      report.rounds = 1;
      const evaluation = evaluateSmokeReport(report, validCommandEvidence(), "diagnostic-repair");
      expect(evaluation.status).toBe("pass");
    });
  });
});
