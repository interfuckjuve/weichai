import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@forexplore/translation-verifier", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@forexplore/translation-verifier")>();
  return {
    ...actual,
    createDefaultVerificationService: vi.fn(
      actual.createDefaultVerificationService,
    ),
  };
});

import {
  createVerificationResult,
  DIFFERENTIAL_SMOKE_STRATEGY,
  type VerificationService,
} from "@forexplore/translation-verifier";
import { canonicalJson } from "@forexplore/workflow-core";
import { createAdaptationV2Runtime } from "./adaptation-v2-runtime";
import {
  fixtureVerificationAssessment,
  adaptationV2GeneratedContent,
  adaptationV2TestNow,
  createAdaptationV2TestFixture,
} from "./adaptation-v2-test-support";
import type {
  MigrationAnalyzerV2,
  MigrationPlannerV2,
  MigrationTranslatorV2,
} from "./adaptation-adapter-v2";

const providers = {
  analyzer: {
    providerId: "forexplore.analyzer.deepseek",
    providerVersion: "1.0.0",
    analyze: vi.fn(async (input) => ({
      schemaVersion: "1.0" as const,
      behavior: ["Normalize text."],
      targetConstraints: [...input.targetContext.constraints],
      mappings: [],
      risks: [],
      unresolved: [],
    })),
  } satisfies MigrationAnalyzerV2,
  planner: {
    providerId: "forexplore.planner.deepseek",
    providerVersion: "1.0.0",
    plan: vi.fn(async () => ({
      schemaVersion: "1.0" as const,
      steps: ["Replace the selected function."],
      preservedFacts: [],
      expectedTargetChanges: ["normalize"],
      validationFocus: [],
      unresolved: [],
    })),
  } satisfies MigrationPlannerV2,
  translator: {
    providerId: "forexplore.translator.deepseek",
    providerVersion: "1.0.0",
    strategy: "translate" as const,
    translate: vi.fn(async () => ({
      schemaVersion: "1.0" as const,
      generatedContent: adaptationV2GeneratedContent,
      completedSteps: ["Replace the selected function."],
      unresolved: [],
    })),
    repair: vi.fn(),
  } satisfies MigrationTranslatorV2,
};

describe("createAdaptationV2Runtime", () => {
  it("passes explicit API key and verification roots and timeout to the default factory", async () => {
    const { createDefaultVerificationService } = await import(
      "@forexplore/translation-verifier"
    );
    const factory = vi.mocked(createDefaultVerificationService);
    factory.mockClear();
    createAdaptationV2Runtime({
      apiKey: "explicit-key",
      verificationWorkspaceRoot: "/workspace-root",
      verificationArtifactRoot: "/artifact-root",
      verificationTimeoutMs: 456,
    });
    expect(factory).toHaveBeenCalledWith({
      workspaceRoot: "/workspace-root",
      artifactRoot: "/artifact-root",
      timeoutMs: 456,
      apiKey: "explicit-key",
    });
  });
  it("executes V2 verification without inventing a Host reference policy", async () => {
    const fixture = createAdaptationV2TestFixture();
    const verify = vi.fn<VerificationService["verifyWithReceipt"]>(
      async (input) => {
        const result = createVerificationResult(
          input,
          DIFFERENTIAL_SMOKE_STRATEGY,
          {
            ...fixtureVerificationAssessment(input),
            status: "pass",
            summary: "verified",
            issues: [],
            artifacts: [],
            strategyReport: {},
          },
          () => adaptationV2TestNow,
        );
        const path = "verification-result.json";
        const bytes = Buffer.from(canonicalJson(result), "utf8");
        return {
          result,
          resultArtifact: {
            id: `verification-result:${path}`,
            kind: "verification-result",
            path,
            contentHash: createHash("sha256").update(bytes).digest("hex"),
            size: bytes.byteLength,
            mediaType: "application/json",
          },
        };
      },
    );
    const runtime = createAdaptationV2Runtime(
      {
        apiKey: "test-key",
        verificationWorkspaceRoot: "/tmp/workspaces",
        verificationArtifactRoot: "/tmp/artifacts",
        verificationTimeoutMs: 300000,
      },
      {
        createdAt: adaptationV2TestNow,
        targetEngineeringRegistry: undefined,
        ...providers,
        verificationService: { verifyWithReceipt: verify } satisfies Pick<
          VerificationService,
          "verifyWithReceipt"
        >,
      },
    );

    const result = await runtime.adapterV2.adapt(
      fixture.request,
      fixture.validationContext,
    );

    expect(result.files).toHaveLength(1);
    expect(verify).toHaveBeenCalledOnce();
    const input = verify.mock.calls[0]![0];
    expect(input).not.toHaveProperty("verificationPolicy");
    expect(input.translation.generatedContent).toBe(
      adaptationV2GeneratedContent,
    );
    expect(input.request).toBe(fixture.request);
    expect(input.translation.round).toBe(0);
    expect(input.translation.files).toEqual(result.files);
    expect(input.translation.patchHash).toBe(result.patchHash);
    expect(
      input.translation.files.flatMap((file) =>
        file.hunks.flatMap((hunk) => hunk.lines),
      ),
    ).toContainEqual({ type: "add", content: "    return trimmed.upper()" });
    expect(input).not.toHaveProperty("strategy");

    const stage = runtime.runtimeCapabilitySnapshot.routes[2]!.stages.find(
      (candidate) => candidate.stage === "behavior-validation",
    )!;
    expect(stage).toMatchObject({
      providerId: "forexplore.translation-verifier.differential",
      providerVersion: "1.0.0",
      availability: {
        status: "available",
        reasonCodes: ["local-process-execution"],
      },
    });
    expect(stage.availability.summary).toMatch(/not isolated/i);
  });
});
