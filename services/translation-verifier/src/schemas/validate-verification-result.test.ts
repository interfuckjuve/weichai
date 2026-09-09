import type {
  AdaptationRequestV2,
  FilePatch,
  RepositoryIngestionJsonValue,
} from "@forexplore/contracts";
import { calculatePatchHashV2, canonicalJson } from "@forexplore/workflow-core";
import { Ajv } from "ajv";
import runSchema from "./verification-run.schema.json" with { type: "json" };
import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  VerificationReceipt as ServiceReceipt,
  VerificationResultArtifact as ServiceArtifact,
} from "../verification-service.js";
import inputSchema from "./verification-input.schema.json" with {
  type: "json",
};
import outputSchema from "./verification-output.schema.json" with {
  type: "json",
};
import {
  validateInputSchema,
  validateResultSchema,
  validateStrategyOutputSchema,
} from "./compile-schema-validators.js";
import { assertVerificationInput } from "./validate-verification-input.js";
import { assertVerificationReceipt } from "./validate-verification-receipt.js";
import { assertVerificationResult } from "./validate-verification-result.js";
import { createVerificationResult } from "./materialize-verification-result.js";
import {
  type VerificationInput,
  type VerificationStrategyDescriptor,
  type VerificationResult,
  type VerificationReceipt,
  type VerificationResultArtifact,
  type VerificationIssue,
  type VerificationArtifact,
  type VerificationStrategyOutput,
  type VerificationRun,
  type VerificationProblem,
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
          lines: [
            { type: "add" as const, content: "export const fixture = 1;" },
          ],
        },
      ],
    },
  ];

  const request = {
    schemaVersion: "2.0",
    id: "request-fixture",
    sourceBundle: {
      files: [
        {
          path: "src/source.ts",
          content: sourceContent,
          contentHash: sha256(sourceContent),
        },
      ],
    },
    targetContext: {
      sourceFiles: [
        {
          path: "src/existing.ts",
          content: targetContent,
          contentHash: sha256(targetContent),
        },
      ],
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

function outputFor(
  inputValue: VerificationInput,
  overrides: Partial<VerificationStrategyOutput> = {},
): VerificationStrategyOutput {
  const policy = inputValue.verificationPolicy;
  return {
    mode:
      policy?.referenceDecision === "accepted" ? "differential" : "target_only",
    referenceDecision: policy?.referenceDecision ?? "undetermined",
    referenceReason:
      policy?.reason ??
      "The Host has not accepted the reference implementation.",
    executionStatus: "completed",
    sourceAssessment:
      policy?.referenceDecision === "accepted"
        ? "no_bug_observed"
        : "not_checked",
    targetAssessment: "no_bug_observed",
    problems: [],
    summary: "verified",
    issues: [],
    artifacts: [],
    strategyReport: null,
    ...overrides,
  };
}

describe("status-free output boundary", () => {
  const output = {
    mode: "target_only" as const,
    referenceDecision: "undetermined" as const,
    referenceReason: "Reference not accepted",
    executionStatus: "completed" as const,
    sourceAssessment: "not_checked" as const,
    targetAssessment: "no_bug_observed" as const,
    problems: [],
    summary: "Target checks completed",
    issues: [],
    artifacts: [],
    strategyReport: null,
  };
  it("accepts status-free output and unrelated extensions", () => {
    expect(validateStrategyOutputSchema(output)).toBe(true);
    expect(validateStrategyOutputSchema({ ...output, extension: true })).toBe(
      true,
    );
  });
  it("rejects legacy status explicitly", () => {
    expect(validateStrategyOutputSchema({ ...output, status: "pass" })).toBe(
      false,
    );
  });
  it("requires issues for a confirmed target bug", () => {
    expect(
      validateStrategyOutputSchema({
        ...output,
        targetAssessment: "bug_found",
      }),
    ).toBe(false);
  });
  it("materializes output 2.0 and rejects result 1.0", () => {
    const value = input();
    const result = createVerificationResult(value, descriptor, {
      ...output,
      referenceReason:
        "The Host has not accepted the reference implementation.",
    });
    expect(result.schemaVersion).toBe("2.0");
    expect(result).not.toHaveProperty("status");
    expect(validateResultSchema({ ...result, schemaVersion: "1.0" })).toBe(
      false,
    );
  });
});

describe("verification-types", () => {
  it("preserves upstream types and exposes the status-free output 2.0 contract", () => {
    type LegacyInput = {
      schemaVersion: "1.0";
      request: AdaptationRequestV2;
      analysisReport: RepositoryIngestionJsonValue;
      migrationPlan: RepositoryIngestionJsonValue;
      translation: {
        round: number;
        generatedContent: string;
        files: FilePatch[];
        patchHash: string;
      };
      verificationPolicy?: {
        referenceDecision: "accepted" | "rejected" | "undetermined";
        reason: string;
        testBasis?: string;
      };
    };
    type LegacyIssue = {
      id: string;
      kind: string;
      message: string;
      caseId?: string;
      sourceObservation?: RepositoryIngestionJsonValue;
      targetObservation?: RepositoryIngestionJsonValue;
      evidenceArtifactIds: string[];
    };
    type LegacyArtifact = {
      id: string;
      kind: string;
      path: string;
      contentHash: string;
      mediaType: string;
    };
    type LegacyOutput = {
      summary: string;
      issues: LegacyIssue[];
      artifacts: LegacyArtifact[];
      strategyReport: RepositoryIngestionJsonValue;
      mode: "differential" | "target_only";
      referenceDecision: "accepted" | "rejected" | "undetermined";
      referenceReason: string;
      executionStatus: "completed" | "partial" | "failed" | "cancelled";
      sourceAssessment:
        | "bug_found"
        | "no_bug_observed"
        | "suspected_bug"
        | "inconclusive"
        | "not_checked";
      targetAssessment:
        | "bug_found"
        | "no_bug_observed"
        | "suspected_bug"
        | "inconclusive"
        | "not_checked";
      problems: {
        code: VerificationProblem["code"];
        message: string;
        side?: "source" | "target";
        commandId?: string;
      }[];
    };
    type LegacyResult = LegacyOutput & {
      schemaVersion: "2.0";
      strategyId: string;
      strategyVersion: string;
      subjectHash: string;
      inputHash: string;
      round: number;
      createdAt: string;
      contentHash: string;
    };
    type LegacyResultArtifact = {
      id: string;
      kind: "verification-result";
      path: string;
      contentHash: string;
      size: number;
      mediaType: "application/json";
    };
    type LegacyReceipt =
      | { result: LegacyResult; resultArtifact: LegacyResultArtifact }
      | { result: LegacyResult; resultArtifact?: undefined };
    type Shape<T> = { [K in keyof T]: T[K] };
    expectTypeOf<VerificationInput>().toMatchTypeOf<LegacyInput>();
    expectTypeOf<LegacyInput>().toMatchTypeOf<VerificationInput>();
    expectTypeOf<keyof VerificationInput>().toEqualTypeOf<keyof LegacyInput>();
    expectTypeOf<keyof VerificationInput["translation"]>().toEqualTypeOf<
      keyof LegacyInput["translation"]
    >();
    expectTypeOf<Shape<VerificationIssue>>().toEqualTypeOf<LegacyIssue>();
    expectTypeOf<Shape<VerificationArtifact>>().toEqualTypeOf<LegacyArtifact>();
    expectTypeOf<
      Shape<VerificationStrategyOutput>
    >().toEqualTypeOf<LegacyOutput>();
    expectTypeOf<Shape<VerificationResult>>().toEqualTypeOf<
      Shape<LegacyResult>
    >();
    expectTypeOf<VerificationReceipt>().toMatchTypeOf<LegacyReceipt>();
    expectTypeOf<LegacyReceipt>().toMatchTypeOf<VerificationReceipt>();
    expectTypeOf<keyof VerificationReceipt>().toEqualTypeOf<
      keyof LegacyReceipt
    >();
    expectTypeOf<VerificationResultArtifact>().toEqualTypeOf<LegacyResultArtifact>();
    expectTypeOf<ServiceReceipt>().toEqualTypeOf<VerificationReceipt>();
    expectTypeOf<ServiceArtifact>().toEqualTypeOf<VerificationResultArtifact>();
    expectTypeOf<
      VerificationInput["request"]
    >().toEqualTypeOf<AdaptationRequestV2>();
    expectTypeOf<VerificationInput["translation"]["files"]>().toEqualTypeOf<
      FilePatch[]
    >();
    expectTypeOf<VerificationStrategyDescriptor>().toMatchTypeOf<
      NonNullable<VerificationRun["strategy"]["selected"]>
    >();
    const adapterInput: LegacyInput = input();
    const publicInput: VerificationInput = adapterInput;
    expect(publicInput).toBe(adapterInput);
  });

  it.each([inputSchema, outputSchema])(
    "compiles public $title with ordinary strict Ajv",
    (schema) => {
      expect(() => new Ajv({ strict: true }).compile(schema)).not.toThrow();
    },
  );

  it("compiles the public run schema with local references and no custom keywords", () => {
    const ajv = new Ajv({ strict: true });
    ajv.addSchema(
      inputSchema,
      new URL("verification-input.schema.json", runSchema.$id).href,
    );
    ajv.addSchema(
      outputSchema,
      new URL("verification-output.schema.json", runSchema.$id).href,
    );
    expect(() => ajv.compile(runSchema)).not.toThrow();
    expect(() =>
      ajv.compile({ $ref: `${runSchema.$id}#/definitions/event` }),
    ).not.toThrow();
  });

  it("compiles the external schema files used by runtime validation", () => {
    expect(validateInputSchema.schema).toStrictEqual(inputSchema);
    expect(validateResultSchema.schema).toStrictEqual(outputSchema);
    expect(validateInputSchema(input())).toBe(true);
  });

  it("preserves open upstream JSON slots and existing envelope extension acceptance", () => {
    const value = input();
    value.analysisReport = null;
    value.migrationPlan = [true, "plan", 1];
    Object.assign(value, { upstreamExtension: true });
    Object.assign(value.translation, { upstreamExtension: true });
    expect(validateInputSchema(value)).toBe(true);
    expect(assertVerificationInput(value)).toBe(value);
    const result = createVerificationResult(
      value,
      descriptor,
      outputFor(value, {
        summary: "checked",
        strategyReport: false,
      }),
    );
    expect(validateResultSchema(result)).toBe(true);
    expect(validateResultSchema({ ...result, upstreamExtension: true })).toBe(
      false,
    );
  });

  it("rejects malformed input fields without coercing or mutating data", () => {
    const value = input();
    value.translation.round = "0" as never;
    const before = structuredClone(value);
    expect(validateInputSchema(value)).toBe(false);
    expect(() => assertVerificationInput(value)).toThrow(
      /translation\.round.*integer/i,
    );
    expect(value).toEqual(before);
  });

  it.each([
    ["missing created-file precondition", { expectedAbsent: undefined }],
    ["false created-file precondition", { expectedAbsent: false }],
    ["unknown patch status", { status: "deleted" }],
    [
      "missing modified-file hash",
      { status: "modified", expectedAbsent: undefined },
    ],
    ["negative additions", { additions: -1 }],
    [
      "invalid hunk lines",
      {
        hunks: [
          {
            header: "@@ -0,0 +1,1 @@",
            lines: [{ type: "invalid", content: "x" }],
          },
        ],
      },
    ],
  ])("rejects %s through the input schema", (_name, overrides) => {
    const value = input();
    // JSON roundtrip models missing optional properties at the wire boundary.
    value.translation.files[0] = JSON.parse(
      JSON.stringify({ ...value.translation.files[0], ...overrides }),
    );
    value.translation.patchHash = calculatePatchHashV2(value.translation.files);
    expect(validateInputSchema(value)).toBe(false);
    expect(() => assertVerificationInput(value)).toThrow(
      /Verification input\.translation\.files/,
    );
  });

  it.each(["no_bug_observed", "bug_found", "inconclusive"] as const)(
    "materializes schema-valid %s results",
    (targetAssessment) => {
      const result = createVerificationResult(
        input(),
        descriptor,
        outputFor(input(), {
          targetAssessment,
          issues:
            targetAssessment === "bug_found"
              ? [
                  {
                    id: "finding",
                    kind: "behavior",
                    message: "different",
                    evidenceArtifactIds: [],
                  },
                ]
              : [],
          strategyReport: {
            languageId: "custom-language",
            details: [null, true, 2, "value"],
          },
        }),
      );
      expect(validateResultSchema(result)).toBe(true);
      expect(assertVerificationResult(result, input(), descriptor)).toBe(
        result,
      );
    },
  );

  it("requires every detailed assessment field", () => {
    const result = outputFor(input());
    for (const field of [
      "mode",
      "referenceDecision",
      "referenceReason",
      "executionStatus",
      "sourceAssessment",
      "targetAssessment",
      "problems",
    ] as const) {
      const invalid = { ...result } as Record<string, unknown>;
      delete invalid[field];
      expect(validateStrategyOutputSchema(invalid)).toBe(false);
      expect(() =>
        createVerificationResult(input(), descriptor, invalid as never),
      ).toThrow(new RegExp(field));
    }
  });

  it("rejects contradictory target-only source findings", () => {
    expect(() =>
      createVerificationResult(
        input(),
        descriptor,
        outputFor(input(), { sourceAssessment: "no_bug_observed" }),
      ),
    ).toThrow(/target-only verification cannot assess the unexecuted source/i);
  });

  it("allows a strategy to determine reference suitability independently of legacy Host policy", () => {
    const acceptedInput = {
      ...input(),
      verificationPolicy: {
        referenceDecision: "accepted" as const,
        reason: "trusted upstream implementation",
      },
    };
    expect(() =>
      createVerificationResult(
        acceptedInput,
        descriptor,
        outputFor(acceptedInput, {
          mode: "target_only",
          referenceDecision: "undetermined",
          referenceReason:
            "The Host has not accepted the reference implementation.",
          sourceAssessment: "not_checked",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects differential execution without an accepted reference", () => {
    expect(() =>
      createVerificationResult(
        input(),
        descriptor,
        outputFor(input(), {
          mode: "differential",
          referenceDecision: "rejected",
        }),
      ),
    ).toThrow(/differential verification requires an accepted reference/i);
  });

  it.each(["pass", "warn", "fail", "unverified"])(
    "rejects legacy %s status in the constructor",
    (status) => {
      expect(() =>
        createVerificationResult(
          input(),
          descriptor,
          Object.assign(outputFor(input()), { status }),
        ),
      ).toThrow(/must NOT be valid/);
    },
  );
  it("rejects malformed output shape and fail-without-issues using the output schema", () => {
    const result = createVerificationResult(
      input(),
      descriptor,
      outputFor(input(), {
        summary: "verified",
        strategyReport: null,
      }),
    );
    for (const invalid of [
      { ...result, schemaVersion: "1.0" },
      { ...result, status: "error" },
      { ...result, summary: " " },
      { ...result, issues: null },
      { ...result, targetAssessment: "bug_found" },
      { ...result, unexpected: true },
    ]) {
      expect(validateResultSchema(invalid)).toBe(false);
      expect(() =>
        assertVerificationResult(invalid as never, input(), descriptor),
      ).toThrow();
    }
  });

  it("still enforces hash and evidence relationships beyond structural schemas", () => {
    const value = input();
    value.translation.patchHash = "f".repeat(64);
    expect(validateInputSchema(value)).toBe(true);
    expect(() => assertVerificationInput(value)).toThrow(/patch hash.*files/i);
    const output = outputFor(input(), {
      targetAssessment: "bug_found",
      summary: "different",
      strategyReport: {},
      issues: [
        {
          id: "finding",
          kind: "behavior",
          message: "different",
          evidenceArtifactIds: ["missing"],
        },
      ],
    });
    expect(() => createVerificationResult(input(), descriptor, output)).toThrow(
      /evidence artifact reference/,
    );
    expect(() =>
      createVerificationResult(
        input(),
        descriptor,
        outputFor(input(), {
          ...output,
          issues: [
            { ...output.issues[0], evidenceArtifactIds: [] },
            { ...output.issues[0], evidenceArtifactIds: [] },
          ],
        }),
      ),
    ).toThrow(/IDs must be unique/);
  });

  it("requires an explicit clean persistence failure when a receipt has no result artifact", () => {
    const value = input();
    const output = outputFor(value, {
      executionStatus: "failed",
      targetAssessment: "inconclusive",
      problems: [
        { code: "artifact_persistence_failed", message: "Storage failed" },
      ],
    });
    const result = createVerificationResult(value, descriptor, output);
    expect(assertVerificationReceipt({ result }, value, descriptor)).toEqual({
      result,
    });
    const artifact = {
      id: "report",
      kind: "report",
      path: "report.json",
      contentHash: "a".repeat(64),
      mediaType: "application/json",
    };
    for (const overrides of [
      {
        problems: [
          { code: "internal_error" as const, message: "Not persistence" },
        ],
        issues: [
          {
            id: "artifact-persistence-failed",
            kind: "artifact-persistence-failed",
            message: "Legacy issue alone",
            evidenceArtifactIds: [],
          },
        ],
      },
      { executionStatus: "partial" as const },
      { artifacts: [artifact] },
      {
        executionStatus: "partial" as const,
        targetAssessment: "no_bug_observed" as const,
      },
      {
        executionStatus: "cancelled" as const,
        problems: [{ code: "cancelled" as const, message: "Cancelled" }],
      },
    ]) {
      const invalid = createVerificationResult(value, descriptor, {
        ...output,
        ...overrides,
      });
      expect(() =>
        assertVerificationReceipt({ result: invalid }, value, descriptor),
      ).toThrow(/omit its result artifact/);
    }
    const bytes = Buffer.from(canonicalJson(result));
    const path = "verification-result.json";
    const receipt: VerificationReceipt = {
      result,
      resultArtifact: {
        id: `verification-result:${path}`,
        kind: "verification-result",
        path,
        contentHash: sha256(bytes.toString("utf8")),
        size: bytes.length,
        mediaType: "application/json",
      },
    };
    expect(assertVerificationReceipt(receipt, value, descriptor)).toBe(receipt);
  });

  it("rejects a receipt whose result artifact metadata is tampered", () => {
    const result = createVerificationResult(
      input(),
      descriptor,
      outputFor(input(), { strategyReport: { cases: 1 } }),
      () => "2026-09-05T00:00:00.000Z",
    );
    const bytes = Buffer.from(JSON.stringify(result), "utf8");
    const receipt = {
      result,
      resultArtifact: {
        id: "verification-result:attempt-1/verification-result.json",
        kind: "verification-result" as const,
        path: "attempt-1/verification-result.json",
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        mediaType: "application/json" as const,
      },
    };
    expect(() =>
      assertVerificationReceipt(receipt, input(), descriptor),
    ).toThrow();
    expect(() =>
      assertVerificationReceipt(
        {
          ...receipt,
          resultArtifact: {
            ...receipt.resultArtifact,
            size: bytes.byteLength + 1,
          },
        },
        input(),
        descriptor,
      ),
    ).toThrow();
  });

  it("binds a result to the strategy, round, and exact patch hash", () => {
    const result = createVerificationResult(
      input(),
      descriptor,
      outputFor(input(), { strategyReport: { cases: 1 } }),
      () => "2026-09-05T00:00:00.000Z",
    );

    expect(result.strategyId).toBe("fixture");
    expect(result.subjectHash).toBe(input().translation.patchHash);
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(assertVerificationResult(result, input(), descriptor)).toBe(result);
  });

  it("rejects replay when the verification test basis changes", () => {
    const originalInput = input();
    const result = createVerificationResult(
      originalInput,
      descriptor,
      outputFor(originalInput),
      () => "2026-09-05T00:00:00.000Z",
    );
    const changedInput: VerificationInput = {
      ...originalInput,
      verificationPolicy: {
        referenceDecision: "undetermined",
        reason: "The Host has not accepted the reference implementation.",
        testBasis: "independent acceptance suite v2",
      },
    };
    expect(result.targetAssessment).toBe("no_bug_observed");
    expect(() =>
      assertVerificationResult(result, changedInput, descriptor),
    ).toThrow(/input hash/i);
  });

  it("rejects missing or malformed staged file arrays", () => {
    const request = requestRecord();

    expect(() =>
      assertVerificationInput(
        inputWithRequest({
          ...request,
          sourceBundle: {},
        }),
      ),
    ).toThrow(/sourceBundle\.files.*required/i);

    expect(() =>
      assertVerificationInput(
        inputWithRequest({
          ...request,
          targetContext: { sourceFiles: {} },
        }),
      ),
    ).toThrow(/targetContext\.sourceFiles.*array/i);
  });

  it("rejects source and target content hash mismatches", () => {
    expect(() =>
      assertVerificationInput(
        inputWithSourceFile({
          path: "src/source.ts",
          content: sourceContent,
          contentHash: "f".repeat(64),
        }),
      ),
    ).toThrow(/sourceBundle\.files\[0\].*contentHash.*sha256/i);

    expect(() =>
      assertVerificationInput(
        inputWithTargetSourceFile({
          path: "src/existing.ts",
          content: targetContent,
          contentHash: "f".repeat(64),
        }),
      ),
    ).toThrow(/targetContext\.sourceFiles\[0\].*contentHash.*sha256/i);
  });

  it("rejects traversal paths in staged files and translation patches", () => {
    expect(() =>
      assertVerificationInput(
        inputWithSourceFile({
          path: "../escape.ts",
          content: sourceContent,
          contentHash: sha256(sourceContent),
        }),
      ),
    ).toThrow(/sourceBundle\.files\[0\].*repository-relative/i);

    expect(() =>
      assertVerificationInput(
        inputWithTargetSourceFile({
          path: "src/../escape.py",
          content: targetContent,
          contentHash: sha256(targetContent),
        }),
      ),
    ).toThrow(/targetContext\.sourceFiles\[0\].*repository-relative/i);

    const patch = { ...input().translation.files[0]!, path: "../escape.ts" };
    expect(() =>
      assertVerificationInput(inputWithTranslationFiles([patch])),
    ).toThrow(/translation\.files\[0\].*repository-relative/i);
  });

  it("rejects empty translation files even with the matching empty patch hash", () => {
    expect(() =>
      assertVerificationInput(inputWithTranslationFiles([])),
    ).toThrow(/translation\.files.*fewer than 1 items/i);
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
        Object.defineProperty(request, Symbol("hidden"), {
          value: true,
          enumerable: true,
        });
        assertVerificationInput(inputWithRequest(request));
      },
      () =>
        assertVerificationInput({
          ...input(),
          analysisReport: { missing: undefined } as never,
        }),
      () =>
        assertVerificationInput({
          ...input(),
          analysisReport: { bad: BigInt(1) } as never,
        }),
      () =>
        assertVerificationInput({
          ...input(),
          migrationPlan: [() => undefined] as never,
        }),
      () =>
        assertVerificationInput({
          ...input(),
          migrationPlan: { bad: Symbol("bad") } as never,
        }),
      () =>
        createVerificationResult(
          input(),
          descriptor,
          outputFor(input(), {
            strategyReport: { score: Number.POSITIVE_INFINITY },
          }),
        ),
      () =>
        createVerificationResult(
          input(),
          descriptor,
          outputFor(input(), {
            strategyReport: new Map() as never,
          }),
        ),
      () =>
        createVerificationResult(
          input(),
          descriptor,
          outputFor(input(), {
            targetAssessment: "bug_found",
            summary: "different",
            issues: [
              {
                id: "issue-1",
                kind: "custom",
                message: "different",
                sourceObservation: cyclicValue() as never,
                evidenceArtifactIds: [],
              },
            ],
            strategyReport: {},
          }),
        ),
      () =>
        createVerificationResult(
          input(),
          descriptor,
          outputFor(input(), {
            targetAssessment: "bug_found",
            summary: "different",
            issues: [
              {
                id: "issue-1",
                kind: "custom",
                message: "different",
                targetObservation: [undefined] as never,
                evidenceArtifactIds: [],
              },
            ],
            strategyReport: {},
          }),
        ),
    ];

    for (const testCase of cases) {
      expect(testCase).toThrow(/JSON-compatible/i);
    }
  });

  it("rejects a result from another patch", () => {
    const result = createVerificationResult(
      input(),
      descriptor,
      outputFor(input(), {
        strategyReport: { cases: 1 },
      }),
    );

    expect(() =>
      assertVerificationResult(
        { ...result, subjectHash: "f".repeat(64) },
        input(),
        descriptor,
      ),
    ).toThrow(/subject hash/i);
  });

  it("rejects non-array issue lists and artifact lists", () => {
    expect(() =>
      createVerificationResult(
        input(),
        descriptor,
        outputFor(input(), {
          issues: {} as never,
          strategyReport: {},
        }),
      ),
    ).toThrow(/issues.*array/i);

    expect(() =>
      createVerificationResult(
        input(),
        descriptor,
        outputFor(input(), {
          artifacts: {} as never,
          strategyReport: {},
        }),
      ),
    ).toThrow(/artifacts.*array/i);
  });

  it("rejects non-array evidence artifact ids", () => {
    expect(() =>
      createVerificationResult(
        input(),
        descriptor,
        outputFor(input(), {
          targetAssessment: "bug_found",
          summary: "different",
          issues: [
            {
              id: "issue-1",
              kind: "custom",
              message: "different",
              evidenceArtifactIds: {} as never,
            },
          ],
          artifacts: [
            {
              id: "artifact-1",
              kind: "report",
              path: "reports/result.json",
              contentHash: "a".repeat(64),
              mediaType: "application/json",
            },
          ],
          strategyReport: {},
        }),
      ),
    ).toThrow(/evidenceArtifactIds.*array/i);
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

function inputWithTargetSourceFile(
  file: Record<string, unknown>,
): VerificationInput {
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
