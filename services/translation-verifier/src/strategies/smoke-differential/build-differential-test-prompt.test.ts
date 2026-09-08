import { describe, expect, it } from "vitest";
import {
  buildSmokeTaskPrompt,
  type SmokeTaskInput,
} from "./build-differential-test-prompt.js";
import { acceptedPolicy } from "./differential-test-fixtures.js";

const input: SmokeTaskInput = {
  verificationPolicy: acceptedPolicy,
  requirement: "Decode text",
  analysisReport: "PRIVATE ANALYSIS",
  source: {
    language: "Java",
    root: "/private/reference",
    candidatePath: "Reference.java",
    files: [{ relativePath: "secret.java", content: "PRIVATE CODE" }],
  },
  target: {
    language: "C#",
    root: "/target",
    className: "Decoder",
    method: "decode",
    isStatic: true,
    file: "Decoder.cs",
  },
};

describe("Host-owned smoke prompt", () => {
  it("requires independent per-side attribution and real per-case observations", () => {
    const prompt = buildSmokeTaskPrompt(input);
    for (const value of [
      acceptedPolicy.testBasis,
      "sourceAssessment",
      "targetAssessment",
      "requirement",
      "commandIds",
      "stdout",
      "compile AND run",
      "both may have the same bug",
      "sourceIssues are annotations",
      "suspected_bug",
    ])
      expect(prompt).toContain(value);
    expect(prompt).toContain("/private/reference");
    expect(prompt).toContain("PRIVATE ANALYSIS");
  });
  it.each(["rejected", "undetermined"] as const)(
    "%s hides every reference path and analysis",
    (referenceDecision) => {
      const prompt = buildSmokeTaskPrompt({
        ...input,
        verificationPolicy: { ...acceptedPolicy, referenceDecision },
      });
      for (const secret of [
        "/private/reference",
        "Reference.java",
        "secret.java",
        "PRIVATE CODE",
        "PRIVATE ANALYSIS",
        "SOURCE SIDE",
      ])
        expect(prompt).not.toContain(secret);
      expect(prompt).toContain("target ONLY");
      expect(prompt).toContain('"source": null');
      expect(prompt).toContain('"sourceAssessment": "not_checked"');
    },
  );
  it("missing policy is target-only and never invents a test basis", () => {
    const prompt = buildSmokeTaskPrompt({
      ...input,
      verificationPolicy: undefined,
    });
    expect(prompt).toContain("target_only");
    expect(prompt).toContain("MISSING");
    expect(prompt).not.toContain("PRIVATE ANALYSIS");
  });
  it("defaults to verify-only, never permits target repairs, and stops after reporting", () => {
    const prompt = buildSmokeTaskPrompt(input);
    expect(prompt).toBe(buildSmokeTaskPrompt(input, "verify-only"));
    for (const value of [
      "Never modify the target implementation",
      '"rounds": 0',
      '"targetFiles": []',
      "verifier-command",
      "READ-ONLY",
      "TERMINATION",
      "report.json",
      "[VERIFIER_STEP]",
    ])
      expect(prompt).toContain(value);
    expect(prompt).not.toContain("at most 2 rounds");
  });
  it("permits bounded repairs only with explicit diagnostic mode", () => {
    const prompt = buildSmokeTaskPrompt(input, "diagnostic-repair");
    expect(prompt).toContain("at most 2 rounds");
    expect(prompt).toContain("never use this mode for write-back decisions");
  });
});
