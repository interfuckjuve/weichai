import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import { calculatePatchHashV2, canonicalJson } from "@forexplore/workflow-core";
import {
  createVerificationResult,
  DIFFERENTIAL_SMOKE_STRATEGY,
  type VerificationService,
} from "@forexplore/translation-verifier";
import { TranslationVerifierV2Adapter } from "./translation-verifier-v2-adapter";
import type {
  MigrationAnalysisV2,
  MigrationBehaviorVerificationInputV2,
  MigrationPlanV2,
  MigrationTranslationV2,
} from "./adaptation-adapter-v2";
import {
  fixtureVerificationAssessment,
  adaptationV2GeneratedContent,
  createAdaptationV2TestFixture,
} from "./adaptation-v2-test-support";

const analysis: MigrationAnalysisV2 = {
  schemaVersion: "1.0",
  behavior: ["Trim and uppercase."],
  targetConstraints: ["Keep sibling declarations."],
  mappings: [
    {
      source: "trim",
      target: "strip",
      rationale: "Equivalent whitespace normalization.",
    },
  ],
  risks: [],
  unresolved: [],
};

const plan: MigrationPlanV2 = {
  schemaVersion: "1.0",
  steps: ["Replace only the selected function."],
  preservedFacts: ["Sibling function remains unchanged."],
  expectedTargetChanges: ["Normalize implementation."],
  validationFocus: ["Behavior parity."],
  unresolved: [],
};

const translation: MigrationTranslationV2 = {
  schemaVersion: "1.0",
  generatedContent: adaptationV2GeneratedContent,
  completedSteps: ["Generated the target function."],
  unresolved: [],
};

describe("TranslationVerifierV2Adapter", () => {
  it("maps V2 migration artifacts without adding a reference policy or strategy options", async () => {
    const { request } = createAdaptationV2TestFixture();
    const files = [
      {
        path: "app/normalize.py",
        status: "modified" as const,
        expectedOriginalSha256: request.target.entity.fileContentHash,
        additions: 1,
        deletions: 1,
        hunks: [
          {
            header: "@@ -1,2 +1,3 @@",
            lines: [
              {
                type: "remove" as const,
                content: "    raise NotImplementedError()",
              },
              {
                type: "add" as const,
                content: "    return value.strip().upper()",
              },
            ],
          },
        ],
      },
    ];
    const patchHash = calculatePatchHashV2(files);
    const signal = AbortSignal.abort("stop");
    const verificationInput = {
      schemaVersion: "1.0" as const,
      request,
      analysisReport: analysis as unknown as RepositoryIngestionJsonValue,
      migrationPlan: plan as unknown as RepositoryIngestionJsonValue,
      translation: {
        round: 1,
        generatedContent: translation.generatedContent,
        files,
        patchHash,
      },
    };
    const result = createVerificationResult(
      verificationInput,
      DIFFERENTIAL_SMOKE_STRATEGY,
      {
        ...fixtureVerificationAssessment({}),
        summary: "verified",
        issues: [],
        artifacts: [],
        strategyReport: { cases: 1 },
      },
      () => "2026-09-05T00:00:00.000Z",
    );
    const path = "verification-result.json";
    const bytes = Buffer.from(canonicalJson(result), "utf8");
    const receipt = {
      result,
      resultArtifact: {
        id: `verification-result:${path}`,
        kind: "verification-result" as const,
        path,
        contentHash: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
        mediaType: "application/json" as const,
      },
    };
    expect(receipt.result.schemaVersion).toBe("2.0");
    expect(receipt.result).not.toHaveProperty("status");
    const service = {
      verifyWithReceipt: vi.fn<VerificationService["verifyWithReceipt"]>(
        async () => receipt,
      ),
    } satisfies Pick<VerificationService, "verifyWithReceipt">;
    const adapter = new TranslationVerifierV2Adapter(service);

    await expect(
      adapter.verifyWithReceipt(
        {
          request,
          analysis,
          plan,
          translation,
          round: 1,
          files,
          patchHash,
        } satisfies MigrationBehaviorVerificationInputV2,
        signal,
      ),
    ).resolves.toBe(receipt);

    expect(service.verifyWithReceipt.mock.calls[0]?.[0]).toEqual(
      verificationInput,
    );

    expect(adapter.providerId).toBe(
      "forexplore.translation-verifier.differential",
    );
    expect(adapter.providerVersion).toBe("1.0.0");
    expect(adapter.strategyDescriptor).toEqual(DIFFERENTIAL_SMOKE_STRATEGY);
    expect(adapter.strategyDescriptor).not.toBe(DIFFERENTIAL_SMOKE_STRATEGY);
    expect(Object.isFrozen(adapter.strategyDescriptor)).toBe(true);
    expect(service.verifyWithReceipt).toHaveBeenCalledOnce();
    expect(service.verifyWithReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: "1.0",
        request,
        analysisReport: analysis,
        migrationPlan: plan,
        translation: expect.objectContaining({
          round: 1,
          generatedContent: translation.generatedContent,
          files,
          patchHash,
        }),
      }),
      {},
      signal,
    );
  });
});
