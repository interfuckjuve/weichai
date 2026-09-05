import { describe, expect, it, vi } from "vitest";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import type { VerificationResult, VerificationService } from "@forexplore/translation-verifier";
import { TranslationVerifierV2Adapter } from "./translation-verifier-v2-adapter";
import type {
  MigrationAnalysisV2,
  MigrationBehaviorVerificationInputV2,
  MigrationPlanV2,
  MigrationTranslationV2,
} from "./adaptation-adapter-v2";
import {
  adaptationV2GeneratedContent,
  createAdaptationV2TestFixture,
} from "./adaptation-v2-test-support";

const analysis: MigrationAnalysisV2 = {
  schemaVersion: "1.0",
  behavior: ["Trim and uppercase."],
  targetConstraints: ["Keep sibling declarations."],
  mappings: [{ source: "trim", target: "strip", rationale: "Equivalent whitespace normalization." }],
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
  it("maps V2 migration artifacts to the verification service without strategy options", async () => {
    const { request } = createAdaptationV2TestFixture();
    const files = [{
      path: "app/normalize.py",
      status: "modified" as const,
      expectedOriginalSha256: request.target.entity.fileContentHash,
      additions: 1,
      deletions: 1,
      hunks: [{
        header: "@@ -1,2 +1,3 @@",
        lines: [
          { type: "remove" as const, content: "    raise NotImplementedError()" },
          { type: "add" as const, content: "    return value.strip().upper()" },
        ],
      }],
    }];
    const patchHash = calculatePatchHashV2(files);
    const signal = AbortSignal.abort("stop");
    const result = {
      schemaVersion: "1.0",
      strategyId: "differential-smoke",
      strategyVersion: "1.0.0",
      subjectHash: patchHash,
      round: 1,
      status: "pass",
      summary: "verified",
      issues: [],
      artifacts: [],
      strategyReport: { cases: 1 },
      createdAt: "2026-09-05T00:00:00.000Z",
      contentHash: "c".repeat(64),
    } satisfies VerificationResult;
    const service = {
      verify: vi.fn(async () => result),
    } satisfies Pick<VerificationService, "verify">;
    const adapter = new TranslationVerifierV2Adapter(service);

    await expect(adapter.verify({
      request,
      analysis,
      plan,
      translation,
      round: 1,
      files,
      patchHash,
    } satisfies MigrationBehaviorVerificationInputV2, signal)).resolves.toBe(result);

    expect(adapter.providerId).toBe("forexplore.translation-verifier.differential");
    expect(adapter.providerVersion).toBe("1.0.0");
    expect(service.verify).toHaveBeenCalledOnce();
    expect(service.verify).toHaveBeenCalledWith(
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
