import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertVerificationInput,
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

const sourceContent = "export function source() {\n  return 1;\n}\n";
const targetContent = "export const fixture = 0;\n";

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
    sourceBundle: {
      files: [{ path: "src/source.ts", content: sourceContent, contentHash: sha256(sourceContent) }],
    },
    targetContext: {
      sourceFiles: [{ path: "src/existing.ts", content: targetContent, contentHash: sha256(targetContent) }],
    },
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

  it("rejects missing or malformed staged file arrays", () => {
    const request = requestRecord();

    expect(() => assertVerificationInput(inputWithRequest({
      ...request,
      sourceBundle: {},
    }))).toThrow(/sourceBundle\.files.*array/i);

    expect(() => assertVerificationInput(inputWithRequest({
      ...request,
      targetContext: { sourceFiles: {} },
    }))).toThrow(/targetContext\.sourceFiles.*array/i);
  });

  it("rejects source and target content hash mismatches", () => {
    expect(() => assertVerificationInput(inputWithSourceFile({
      path: "src/source.ts",
      content: sourceContent,
      contentHash: "f".repeat(64),
    }))).toThrow(/sourceBundle\.files\[0\].*contentHash.*sha256/i);

    expect(() => assertVerificationInput(inputWithTargetSourceFile({
      path: "src/existing.ts",
      content: targetContent,
      contentHash: "f".repeat(64),
    }))).toThrow(/targetContext\.sourceFiles\[0\].*contentHash.*sha256/i);
  });

  it("rejects traversal paths in staged files and translation patches", () => {
    expect(() => assertVerificationInput(inputWithSourceFile({
      path: "../escape.ts",
      content: sourceContent,
      contentHash: sha256(sourceContent),
    }))).toThrow(/sourceBundle\.files\[0\].*repository-relative/i);

    expect(() => assertVerificationInput(inputWithTargetSourceFile({
      path: "src/../escape.py",
      content: targetContent,
      contentHash: sha256(targetContent),
    }))).toThrow(/targetContext\.sourceFiles\[0\].*repository-relative/i);

    const patch = { ...input().translation.files[0]!, path: "../escape.ts" };
    expect(() => assertVerificationInput(inputWithTranslationFiles([patch])))
      .toThrow(/translation\.files\[0\].*repository-relative/i);
  });

  it("rejects empty translation files even with the matching empty patch hash", () => {
    expect(() => assertVerificationInput(inputWithTranslationFiles([])))
      .toThrow(/at least one patch/i);
  });

  it("rejects non-JSON generic payload values before cloning or hashing", () => {
    const cases = [
      () => {
        const request = requestRecord();
        request.extra = new Date("2026-09-05T00:00:00.000Z");
        assertVerificationInput(inputWithRequest(request));
      },
      () => {
        const request = requestRecord();
        Object.defineProperty(request, Symbol("hidden"), { value: true, enumerable: true });
        assertVerificationInput(inputWithRequest(request));
      },
      () => assertVerificationInput({ ...input(), analysisReport: { missing: undefined } as never }),
      () => assertVerificationInput({ ...input(), analysisReport: { bad: BigInt(1) } as never }),
      () => assertVerificationInput({ ...input(), migrationPlan: [() => undefined] as never }),
      () => assertVerificationInput({ ...input(), migrationPlan: { bad: Symbol("bad") } as never }),
      () => createVerificationResult(input(), descriptor, {
        status: "pass",
        summary: "verified",
        issues: [],
        artifacts: [],
        strategyReport: { score: Number.POSITIVE_INFINITY },
      }),
      () => createVerificationResult(input(), descriptor, {
        status: "pass",
        summary: "verified",
        issues: [],
        artifacts: [],
        strategyReport: new Map() as never,
      }),
      () => createVerificationResult(input(), descriptor, {
        status: "fail",
        summary: "different",
        issues: [{
          id: "issue-1",
          kind: "custom",
          message: "different",
          sourceObservation: cyclicValue() as never,
          evidenceArtifactIds: [],
        }],
        artifacts: [],
        strategyReport: {},
      }),
      () => createVerificationResult(input(), descriptor, {
        status: "fail",
        summary: "different",
        issues: [{
          id: "issue-1",
          kind: "custom",
          message: "different",
          targetObservation: [undefined] as never,
          evidenceArtifactIds: [],
        }],
        artifacts: [],
        strategyReport: {},
      }),
    ];

    for (const testCase of cases) {
      expect(testCase).toThrow(/JSON-compatible/i);
    }
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

function inputWithRequest(request: unknown): VerificationInput {
  return { ...input(), request: request as AdaptationRequestV2 };
}

function requestRecord(): Record<string, unknown> {
  return structuredClone(input().request) as unknown as Record<string, unknown>;
}

function inputWithSourceFile(file: Record<string, unknown>): VerificationInput {
  const request = requestRecord();
  request.sourceBundle = { files: [file] };
  return inputWithRequest(request);
}

function inputWithTargetSourceFile(file: Record<string, unknown>): VerificationInput {
  const request = requestRecord();
  request.targetContext = { sourceFiles: [file] };
  return inputWithRequest(request);
}

function inputWithTranslationFiles(files: FilePatch[]): VerificationInput {
  const fixture = input();
  return {
    ...fixture,
    translation: {
      ...fixture.translation,
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

function cyclicValue(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
