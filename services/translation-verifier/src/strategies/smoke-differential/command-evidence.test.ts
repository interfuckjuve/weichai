import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptedPolicy,
  validCommandEvidence,
  validSmokeReport,
} from "./differential-test-fixtures.js";
import { evaluateSmokeReport } from "./decide-test-verdict.js";
import { evaluateEvidence } from "./evaluate-evidence.js";
import { isCommandEvidence, readCommandEvidence } from "./command-evidence.js";
import { SmokeVerificationError } from "./smoke-errors.js";
import { prepareSmokeWorkspaceFixture } from "./prepared-workspace-fixture.js";
import { readReport } from "./read-test-report.js";
import { assertSmokeReport } from "./validate-test-report.js";
import { assertWorkspaceBaseline } from "./protect-project-files.js";

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "command-evidence-"));
  roots.push(root);
  return prepareSmokeWorkspaceFixture(root, {
    verificationPolicy: acceptedPolicy,
    requirement: "Check behavior",
    source: { language: "Java" },
    target: {
      language: "C#",
      className: "Target",
      method: "Run",
      isStatic: true,
    },
  });
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const policy = { verificationPolicy: acceptedPolicy };

describe("shared command evidence boundary", () => {
  it.each([
    null,
    [],
    { commandId: "x", side: "target" },
    ...[
      "commandId",
      "side",
      "phase",
      "durationMs",
      "exitCode",
      "cwd",
      "command",
      "baselineValid",
      "timedOut",
      "stdout",
      "stderr",
    ].map((field) => {
      const entry = { ...validCommandEvidence()[0] } as Record<string, unknown>;
      delete entry[field];
      return entry;
    }),
    ...[
      { side: "other" },
      { phase: "other" },
      { commandId: " " },
      { durationMs: Infinity },
      { durationMs: NaN },
      { durationMs: -1 },
      { durationMs: "1" },
      { exitCode: Infinity },
      { exitCode: NaN },
      { exitCode: -1 },
      { exitCode: 1.5 },
      { stdout: null },
      { stderr: [] },
      { baselineValid: "true" },
      { timedOut: 1 },
      { cwd: 1 },
      { command: null },
    ].map((fields) => ({ ...validCommandEvidence()[0], ...fields })),
  ])("rejects malformed raw structure %#", (raw) => {
    expect(isCommandEvidence(raw)).toBe(false);
    expect(
      evaluateSmokeReport(validSmokeReport(), [raw], policy).targetAssessment,
    ).toBe("inconclusive");
  });
  it("accepts finite durations, null exits and optional non-authoritative extensions", () => {
    expect(
      isCommandEvidence({
        ...validCommandEvidence()[0],
        durationMs: 0.5,
        exitCode: null,
        timing: "ignored",
      }),
    ).toBe(true);
  });
  it("keeps raw JSON untrusted and preserves line and byte limits", () => {
    const { layout } = workspace();
    writeFileSync(layout.evidencePath, "null\n{}\n42\n");
    expect(readCommandEvidence(layout.evidencePath)).toEqual([null, {}, 42]);
    writeFileSync(layout.evidencePath, "\n \n" + "{}\n".repeat(400));
    expect(readCommandEvidence(layout.evidencePath)).toHaveLength(400);
    writeFileSync(layout.evidencePath, "{}\n".repeat(401));
    expect(() => readCommandEvidence(layout.evidencePath)).toThrow(
      expect.objectContaining({ code: "report_evidence_invalid" }),
    );
    truncateSync(layout.evidencePath, 64 * 1024 * 1024 + 1);
    expect(() => readCommandEvidence(layout.evidencePath)).toThrow(
      expect.objectContaining({ code: "report_evidence_invalid" }),
    );
  });
  it("preserves coded validation identity when wording changes", async () => {
    const { layout } = workspace();
    writeFileSync(join(layout.agentDir, "report.json"), "{}");
    const cause = new Error("original cause");
    const error = new SmokeVerificationError(
      "report_invalid_json",
      "Different wording",
      { cause },
    );
    await expect(
      readReport(layout.agentDir, (_raw): asserts _raw is unknown => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(error.code).toBe("report_invalid_json");
    expect(error.cause).toBe(cause);
  });
  it.each(["cwd", "command", "stdout", "stderr", "durationMs"])(
    "rejects missing %s in normal evaluation and failed-report diagnostics",
    async (field) => {
      const evidence = validCommandEvidence();
      const invalid = {
        ...evidence[0],
        timedOut: true,
        baselineValid: false,
      } as Record<string, unknown>;
      delete invalid[field];
      const raw = [invalid, ...evidence.slice(1)];
      const evaluation = evaluateSmokeReport(validSmokeReport(), raw, policy);
      expect(evaluation.problems[0].code).toBe("report_evidence_invalid");
      expect(evaluation.targetAssessment).toBe("inconclusive");
      const { layout } = workspace();
      writeFileSync(
        layout.evidencePath,
        raw.map((item) => JSON.stringify(item)).join("\n"),
      );
      const result = await evaluateEvidence(layout, policy);
      expect(result.problems.map((item) => item.code)).toEqual([
        "report_missing",
        "report_evidence_invalid",
      ]);
    },
  );

  it.each(["structure", "stdout", "baseline"])(
    "retains every independent command problem after %s rejection",
    (kind) => {
      const report = validSmokeReport();
      const evidence = validCommandEvidence(report);
      if (kind === "structure")
        delete (evidence[0] as Partial<(typeof evidence)[0]>).cwd;
      if (kind === "stdout") evidence[3].stdout = "[]";
      if (kind === "baseline") evidence[0].baselineValid = false;
      evidence.push({
        ...evidence[2],
        commandId: "later-timeout",
        timedOut: true,
        exitCode: null,
      });
      evidence.push({
        ...evidence[3],
        commandId: "later-failure",
        exitCode: 2,
        baselineValid: false,
      });
      const result = evaluateSmokeReport(report, evidence, policy);
      expect(result.targetAssessment).toBe("inconclusive");
      expect(result.problems).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "command_timeout",
            commandId: "later-timeout",
          }),
          expect.objectContaining({
            code: "environment_unavailable",
            commandId: "later-failure",
          }),
          expect.objectContaining({
            code: "workspace_integrity_violation",
            commandId: "later-failure",
          }),
        ]),
      );
    },
  );

  it("retains independent command failures when stdout binding rejects an otherwise intact report", () => {
    const report = validSmokeReport();
    const evidence = validCommandEvidence(report);
    evidence[3].stdout = "[]";
    evidence.push({
      ...evidence[3],
      commandId: "later-timeout",
      timedOut: true,
      exitCode: null,
    });
    evidence.push({ ...evidence[1], commandId: "later-failure", exitCode: 2 });
    const result = evaluateSmokeReport(report, evidence, policy);
    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.problems.map((problem) => problem.code)).toEqual([
      "report_evidence_invalid",
      "command_timeout",
      "environment_unavailable",
    ]);
    expect(result.summary).toContain("actual stdout");
  });

  it("only treats the ENOENT system code as missing evidence", () => {
    const { layout } = workspace();
    expect(readCommandEvidence(layout.evidencePath)).toEqual([]);
    expect(() =>
      readCommandEvidence(join(layout.baselinePath, "ENOENT")),
    ).toThrow();
  });

  it("codes malformed JSONL and preserves its parser cause", () => {
    const { layout } = workspace();
    writeFileSync(layout.evidencePath, "{");
    expect(() => readCommandEvidence(layout.evidencePath)).toThrow(
      expect.objectContaining({
        code: "report_evidence_invalid",
        cause: expect.any(SyntaxError),
      }),
    );
  });
});

describe("coded report and baseline origins", () => {
  it("retains filesystem ENOENT as the missing report cause", async () => {
    const { layout } = workspace();
    await expect(readReport(layout.agentDir)).rejects.toMatchObject({
      code: "report_missing",
      cause: { code: "ENOENT" },
    });
  });
  it("distinguishes parser errors from schema errors", async () => {
    const { layout } = workspace();
    writeFileSync(join(layout.agentDir, "report.json"), "{");
    await expect(
      readReport(layout.agentDir, assertSmokeReport),
    ).rejects.toMatchObject({
      code: "report_invalid_json",
      cause: expect.any(SyntaxError),
    });
    writeFileSync(join(layout.agentDir, "report.json"), "{}");
    await expect(
      readReport(layout.agentDir, assertSmokeReport),
    ).rejects.toMatchObject({ code: "report_schema_invalid" });
  });
  it("codes baseline I/O and integrity failures at their origin", () => {
    const { layout } = workspace();
    expect(() =>
      assertWorkspaceBaseline(
        layout.executionRoot,
        join(layout.agentDir, "absent"),
      ),
    ).toThrow(
      expect.objectContaining({
        code: "workspace_integrity_violation",
        cause: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
    writeFileSync(join(layout.executionRoot, "shadow.txt"), "changed");
    expect(() =>
      assertWorkspaceBaseline(layout.executionRoot, layout.baselinePath),
    ).toThrow(
      expect.objectContaining({ code: "workspace_integrity_violation" }),
    );
  });
});
