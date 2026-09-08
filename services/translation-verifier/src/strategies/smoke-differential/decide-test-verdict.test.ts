import { describe, expect, it } from "vitest";
import {
  acceptedPolicy,
  validCommandEvidence,
  validSmokeCase,
  validSmokeReport,
} from "./differential-test-fixtures.js";
import type {
  CommandEvidence,
  SmokeReport,
} from "./differential-test-types.js";
import { evaluateSmokeReport } from "./decide-test-verdict.js";

const policy = { verificationPolicy: acceptedPolicy };
const evaluate = (
  report = validSmokeReport(),
  evidence = validCommandEvidence(report),
) => evaluateSmokeReport(report, evidence, policy);

describe("independent side assessments", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("source bug=%s target bug=%s", (sourceBug, targetBug) => {
    const report = validSmokeReport();
    const item = report.cases[0];
    for (const [side, bug] of [
      ["source", sourceBug],
      ["target", targetBug],
    ] as const) {
      item[`${side}Assessment`] = bug ? "bug_found" : "no_bug_observed";
      item[side] = {
        caseId: "c1",
        outcome: "return",
        returnValue: { type: "string", value: bug ? "wrong" : "ok" },
      };
    }
    // The legacy decision is deliberately pass, including two equal buggy observations.
    const result = evaluate(report);
    expect(result).toMatchObject({
      executionStatus: "completed",
      sourceAssessment: sourceBug ? "bug_found" : "no_bug_observed",
      targetAssessment: targetBug ? "bug_found" : "no_bug_observed",
    });
  });
  it("accepts explicitly justified language-specific exception expectations", () => {
    const report = validSmokeReport();
    const item = report.cases[0];
    item.source = {
      caseId: "c1",
      outcome: "exception",
      exceptionType: "ValueError",
    };
    item.target = {
      caseId: "c1",
      outcome: "exception",
      exceptionType: "IllegalArgumentException",
    };
    item.requirement = {
      basis: acceptedPolicy.testBasis,
      expected: item.source,
      expectedBySide: { target: item.target },
    };
    item.decision = "accepted-diff";
    item.reasoning =
      "The independently supplied requirement permits different exception representations.";
    expect(evaluate(report)).toMatchObject({
      sourceAssessment: "no_bug_observed",
      targetAssessment: "no_bug_observed",
    });
  });

  it("does not turn sourceIssues annotations into confirmed source defects", () => {
    expect(
      evaluate(validSmokeReport({ sourceIssues: ["possible defect"] }))
        .sourceAssessment,
    ).toBe("no_bug_observed");
  });
  it.each(["suspected_bug", "inconclusive"] as const)(
    "retains %s without a false bug claim",
    (targetAssessment) => {
      const report = validSmokeReport();
      report.cases[0].targetAssessment = targetAssessment;
      expect(evaluate(report)).toMatchObject({
        targetAssessment,
        executionStatus: "completed",
      });
    },
  );
  it("missing policy or independent basis fails closed", () => {
    for (const input of [
      {},
      {
        verificationPolicy: {
          referenceDecision: "accepted" as const,
          reason: "accepted",
        },
      },
    ]) {
      expect(
        evaluateSmokeReport(validSmokeReport(), validCommandEvidence(), input)
          .problems[0].code,
      ).toBe("insufficient_test_basis");
    }
  });
  it("target-only checks exactly one side and rejects a source claim", () => {
    const report = validSmokeReport();
    const item = report.cases[0];
    item.source = null;
    item.sourceAssessment = "not_checked";
    item.commandIds = { target: "target-run" };
    report.executions = report.executions!.filter(
      (entry) => entry.side === "target",
    );
    report.runnerFiles = report.runnerFiles!.filter(
      (entry) => entry.side === "target",
    );
    const input = {
      verificationPolicy: {
        ...acceptedPolicy,
        referenceDecision: "rejected" as const,
      },
    };
    const result = evaluateSmokeReport(
      report,
      validCommandEvidence(report),
      input,
    );
    expect(result).toMatchObject({
      mode: "target_only",
      sourceAssessment: "not_checked",
      targetAssessment: "no_bug_observed",
    });
    item.sourceAssessment = "no_bug_observed";
    expect(
      evaluateSmokeReport(report, validCommandEvidence(report), input)
        .problems[0].code,
    ).toBe("report_evidence_invalid");
  });
});

describe("execution evidence gates", () => {
  const rejected = (report: SmokeReport, evidence: CommandEvidence[]) => {
    const result = evaluate(report, evidence);
    expect(result.executionStatus).toBe("failed");
    expect(result.bugCases).toEqual([]);
    expect(result.targetAssessment).toBe("inconclusive");
    return result;
  };
  it.each([
    "duplicate",
    "side",
    "phase",
    "exit",
    "baseline",
    "timeout",
    "stdout",
  ])("rejects invalid %s evidence", (kind) => {
    const report = validSmokeReport();
    const evidence = validCommandEvidence();
    if (kind === "duplicate") evidence.push({ ...evidence[0] });
    if (kind === "side") evidence[1].side = "target";
    if (kind === "phase") evidence[0].phase = "run";
    if (kind === "exit") {
      evidence[0].exitCode = 5;
      report.executions![0].exitCode = 5;
    }
    if (kind === "baseline") evidence[0].baselineValid = false;
    if (kind === "timeout") evidence[0].timedOut = true;
    if (kind === "stdout") evidence[3].stdout = "[]";
    const result = rejected(report, evidence);
    if (kind === "timeout")
      expect(result.problems[0].code).toBe("command_timeout");
    if (kind === "exit")
      expect(result.problems[0].code).toBe("environment_unavailable");
    if (kind === "baseline")
      expect(result.problems[0].code).toBe("workspace_integrity_violation");
  });
  it.each([
    "no commands",
    "compile missing",
    "run reference missing",
    "wrong basis",
    "contradictory assessment",
    "duplicate observation",
  ])("rejects %s", (kind) => {
    const report = validSmokeReport();
    const evidence = validCommandEvidence();
    if (kind === "no commands") report.executions = [];
    if (kind === "compile missing")
      report.executions = report.executions!.filter(
        (item) => item.commandId !== "source-compile",
      );
    if (kind === "run reference missing")
      report.cases[0].commandIds = undefined;
    if (kind === "wrong basis")
      report.cases[0].requirement!.basis = "Agent invented a requirement";
    if (kind === "contradictory assessment")
      report.cases[0].targetAssessment = "bug_found";
    if (kind === "duplicate observation")
      evidence[3].stdout = JSON.stringify([
        report.cases[0].target,
        report.cases[0].target,
      ]);
    rejected(report, evidence);
  });
  it.each([false, true])(
    "preserves validated findings with a later timeout (declared=%s)",
    (declared) => {
      const report = validSmokeReport({
        cases: [validSmokeCase({ targetAssessment: "bug_found" })],
      });
      const evidence = validCommandEvidence(report);
      const later = {
        ...evidence[3],
        commandId: "later-command",
        timedOut: true,
        exitCode: null,
      };
      evidence.push(later);
      if (declared)
        report.executions!.push({
          side: later.side,
          phase: later.phase,
          commandId: later.commandId,
          exitCode: null,
          durationMs: later.durationMs,
        });
      expect(evaluate(report, evidence)).toMatchObject({
        executionStatus: "partial",
        targetAssessment: "bug_found",
        problems: [{ code: "command_timeout" }],
      });
    },
  );
  it("accepts a recovered runner compile error without discarding its execution history", () => {
    const report = validSmokeReport();
    const evidence = validCommandEvidence(report);
    const failed = {
      ...evidence[0],
      commandId: "initial-compile",
      exitCode: 1,
    };
    evidence.unshift(failed);
    report.executions!.unshift({
      commandId: failed.commandId,
      side: failed.side,
      phase: failed.phase,
      exitCode: failed.exitCode,
      durationMs: failed.durationMs,
    });
    expect(evaluate(report, evidence)).toMatchObject({
      executionStatus: "completed",
      problems: [],
    });
    expect(report.executions![0].exitCode).toBe(1);
  });

  it.each(["later-compile", "earlier-run", "compile-timeout"])(
    "retains an unresolved %s failure",
    (kind) => {
      const report = validSmokeReport();
      const evidence = validCommandEvidence(report);
      const failed: CommandEvidence = {
        ...evidence[0],
        commandId: "unresolved",
        exitCode: 1,
        phase: kind === "earlier-run" ? "run" : "compile",
        timedOut: kind === "compile-timeout",
      };
      if (kind === "later-compile") evidence.push(failed);
      else evidence.unshift(failed);
      expect(evaluate(report, evidence)).toMatchObject({
        executionStatus: "partial",
        problems: [expect.objectContaining({ commandId: "unresolved" })],
      });
    },
  );

  it("unconditionally rejects both repair rounds and target files", () => {
    const report = validSmokeReport({ rounds: 1 });
    rejected(report, validCommandEvidence(report));
    report.rounds = 0;
    report.targetFiles = [{ path: "Target.cs", content: "changed" }];
    rejected(report, validCommandEvidence(report));
  });
});
