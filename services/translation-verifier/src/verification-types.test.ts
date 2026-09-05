import type { AdaptationRequestV2 } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { describe, expect, it } from "vitest";
import {
  assertVerificationResult,
  createVerificationResult,
  type VerificationInput,
  type VerificationStrategyDescriptor,
} from "./verification-types.js";

const descriptor: VerificationStrategyDescriptor = {
  id: "fixture",
  version: "1.0.0",
  displayName: "Fixture Strategy",
};

function input(): VerificationInput {
  const files = [
    {
      status: "created" as const,
      path: "src/fixture.ts",
      additions: 1,
      deletions: 0,
      expectedAbsent: true as const,
      hunks: [
        {
          header: "@@ -0,0 +1,1 @@",
          lines: [{ type: "add" as const, content: "export const fixture = 1;" }],
        },
      ],
    },
  ];

  const request = {
    schemaVersion: "2.0",
    id: "request-fixture",
  } as AdaptationRequestV2;

  return {
    schemaVersion: "1.0",
    request,
    analysisReport: { kind: "analysis" },
    migrationPlan: { kind: "plan" },
    translation: {
      round: 0,
      generatedContent: "export const fixture = 1;\n",
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

describe("verification-types", () => {
  it("binds a result to the strategy, round, and exact patch hash", () => {
    const result = createVerificationResult(input(), descriptor, {
      status: "pass",
      summary: "verified",
      issues: [],
      artifacts: [],
      strategyReport: { cases: 1 },
    }, () => "2026-09-05T00:00:00.000Z");

    expect(result.strategyId).toBe("fixture");
    expect(result.subjectHash).toBe(input().translation.patchHash);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(assertVerificationResult(result, input(), descriptor)).toBe(result);
  });

  it("rejects a result from another patch", () => {
    const result = createVerificationResult(input(), descriptor, {
      status: "pass",
      summary: "verified",
      issues: [],
      artifacts: [],
      strategyReport: { cases: 1 },
    });

    expect(() => assertVerificationResult(
      { ...result, subjectHash: "f".repeat(64) }, input(), descriptor,
    )).toThrow(/subject hash/i);
  });

  it("rejects non-array issue lists and artifact lists", () => {
    expect(() => createVerificationResult(input(), descriptor, {
      status: "pass",
      summary: "verified",
      issues: {} as never,
      artifacts: [],
      strategyReport: {},
    })).toThrow(/issues.*array/i);

    expect(() => createVerificationResult(input(), descriptor, {
      status: "pass",
      summary: "verified",
      issues: [],
      artifacts: {} as never,
      strategyReport: {},
    })).toThrow(/artifacts.*array/i);
  });

  it("rejects non-array evidence artifact ids", () => {
    expect(() => createVerificationResult(input(), descriptor, {
      status: "fail",
      summary: "different",
      issues: [{
        id: "issue-1",
        kind: "custom",
        message: "different",
        evidenceArtifactIds: {} as never,
      }],
      artifacts: [{
        id: "artifact-1",
        kind: "report",
        path: "reports/result.json",
        contentHash: "a".repeat(64),
        mediaType: "application/json",
      }],
      strategyReport: {},
    })).toThrow(/evidence artifact ids.*array/i);
  });
});
