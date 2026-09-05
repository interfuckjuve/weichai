import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import {
  createVerificationResult,
  type VerificationResult,
} from "@forexplore/translation-verifier";
import {
  evaluateValidationPolicyGate,
  validateAdaptationResultV2,
} from "@forexplore/workflow-core";
import {
  AdaptationAdapterV2,
  type MigrationAnalyzerV2,
  type MigrationBehaviorVerificationInputV2,
  type MigrationBehaviorVerifierV2,
  type MigrationPlannerV2,
  type MigrationTranslatorV2,
} from "./adaptation-adapter-v2";
import {
  adaptationV2GeneratedContent,
  adaptationV2SourceContent,
  adaptationV2TestNow,
  createAdaptationV2TestFixture,
} from "./adaptation-v2-test-support";

function deterministicProviders() {
  const analyzer: MigrationAnalyzerV2 = {
    providerId: "forexplore.analyzer.deepseek",
    providerVersion: "1.0.0",
    analyze: vi.fn(async (input) => {
      expect(input.sourceBundle.files[0]?.content).toBe(adaptationV2SourceContent);
      expect(input).not.toHaveProperty("preview");
      return {
        schemaVersion: "1.0" as const,
        behavior: ["Trim surrounding whitespace and uppercase the remainder."],
        targetConstraints: [...input.targetContext.constraints],
        mappings: [{ source: "String.trim/toUpperCase", target: "str.strip/upper", rationale: "Equivalent string operations" }],
        risks: [],
        unresolved: [],
      };
    }),
  };
  const planner: MigrationPlannerV2 = {
    providerId: "forexplore.planner.deepseek",
    providerVersion: "1.0.0",
    plan: vi.fn(async () => ({
      schemaVersion: "1.0" as const,
      steps: ["Replace only the approved top-level Python function."],
      preservedFacts: ["Keep the sibling function."],
      expectedTargetChanges: ["normalize implementation"],
      validationFocus: ["TypeScript/Python output parity"],
      unresolved: [],
    })),
  };
  const translator: MigrationTranslatorV2 = {
    providerId: "forexplore.translator.deepseek",
    providerVersion: "1.0.0",
    strategy: "translate",
    translate: vi.fn(async () => ({
      schemaVersion: "1.0" as const,
      generatedContent: adaptationV2GeneratedContent,
      completedSteps: ["Mapped the reviewed behavior."],
      unresolved: [],
    })),
  };
  return { analyzer, planner, translator };
}

// Test-only seam: it executes only the fixed repository fixture in local child
// processes. It is deterministic evidence for this test, not a production
// isolated-executor attestation (it inherits this test process environment).
const behaviorVerifier: MigrationBehaviorVerifierV2 = {
  providerId: "forexplore.translation-verifier.differential",
  providerVersion: "1.0.0",
  async verify(input) {
    const samples = ["  alpha ", "Beta"];
    const tsxCli = fileURLToPath(
      new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const sourceOutput = execFileSync(
      process.execPath,
      [
        tsxCli,
        "-e",
        `${input.request.sourceBundle.files[0]!.content}\nconsole.log(JSON.stringify(${JSON.stringify(samples)}.map(normalize)));`,
      ],
      { encoding: "utf8" },
    ).trim();
    const python = process.env.PYTHON_COMMAND?.trim() || "python";
    const targetOutput = execFileSync(
      python,
      [
        "-c",
        `${input.translation.generatedContent}\nimport json\nprint(json.dumps([normalize(v) for v in ${JSON.stringify(samples)}], separators=(',', ':')))`,
      ],
      { encoding: "utf8" },
    ).trim();
    return sourceOutput === targetOutput
      ? validVerificationResult(input, {
          status: "pass",
          summary: "Controlled local TypeScript and Python fixture drivers returned identical outputs.",
          issues: [],
          artifacts: [{
            id: "typescript-python-normalize-report",
            kind: "report",
            path: ".forexplore/evidence/typescript-python-normalize.json",
            contentHash: "a".repeat(64),
            mediaType: "application/json",
          }],
          strategyReport: { sourceOutput, targetOutput },
        })
      : validVerificationResult(input, {
          status: "fail",
          summary: `Differential output mismatch: ${sourceOutput} != ${targetOutput}`,
          issues: [{
            id: "behavioral-divergence",
            kind: "behavioral-divergence",
            message: "Controlled local fixture drivers returned different outputs.",
            evidenceArtifactIds: [],
          }],
          artifacts: [],
          strategyReport: { sourceOutput, targetOutput },
        });
  },
};

function validVerificationResult(
  input: MigrationBehaviorVerificationInputV2,
  output: Parameters<typeof createVerificationResult>[2] = {
    status: "pass",
    summary: "Verifier passed.",
    issues: [],
    artifacts: [],
    strategyReport: {},
  },
): VerificationResult {
  return createVerificationResult({
    schemaVersion: "1.0",
    request: input.request,
    analysisReport: input.analysis as unknown as RepositoryIngestionJsonValue,
    migrationPlan: input.plan as unknown as RepositoryIngestionJsonValue,
    translation: {
      round: input.round,
      generatedContent: input.translation.generatedContent,
      files: input.files,
      patchHash: input.patchHash,
    },
  }, {
    id: "forexplore.translation-verifier.differential",
    version: "1.0.0",
    displayName: "Fixture Differential Verifier",
  }, output, () => adaptationV2TestNow);
}

type VerificationResultMutation = (result: VerificationResult) => VerificationResult;

describe("AdaptationAdapterV2", () => {
  it("uses the full TypeScript bundle and adapter-owned Python facts to produce a validated patch", async () => {
    const fixture = createAdaptationV2TestFixture();
    const providers = deterministicProviders();
    const adapter = new AdaptationAdapterV2({
      runtimeCapabilities: fixture.serviceRuntime,
      ...providers,
      verifier: behaviorVerifier,
      now: () => adaptationV2TestNow,
    });

    const result = await adapter.adapt(fixture.request, fixture.validationContext);

    expect(validateAdaptationResultV2(result, fixture.request, fixture.validationContext)).toBe(result);
    const fullFileFact = fixture.targetContext.sourceFiles.find((fact) =>
      fact.role === "source-file");
    expect(fullFileFact?.contentHash).toBe(fixture.request.target.entity.fileContentHash);
    expect(providers.analyzer.analyze).toHaveBeenCalledOnce();
    expect(providers.translator.translate).toHaveBeenCalledOnce();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      path: "app/normalize.py",
      status: "modified",
      expectedOriginalSha256: fixture.request.target.entity.fileContentHash,
    });
    const patchLines = result.files[0]!.hunks.flatMap((hunk) => hunk.lines);
    expect(patchLines).toContainEqual({ type: "add", content: "    return trimmed.upper()" });
    expect(patchLines).not.toContainEqual(expect.objectContaining({
      type: "remove",
      content: expect.stringContaining("def keep"),
    }));
    expect(result.validation).toEqual(expect.arrayContaining([
      expect.objectContaining({
        policyCheckId: "behavior-differential",
        status: "pass",
        required: true,
        artifactPath: ".forexplore/evidence/typescript-python-normalize.json",
      }),
      expect.objectContaining({ policyCheckId: "patch-boundary", status: "pass" }),
      expect.objectContaining({ policyCheckId: "target-compile", status: "pass" }),
    ]));
    expect(evaluateValidationPolicyGate(
      fixture.request.validationPolicy,
      result.validation,
      { subjectHash: result.patchHash },
    ).allowed).toBe(true);
  });

  it("retains missing required verifier evidence as unverified and blocks the gate", async () => {
    const fixture = createAdaptationV2TestFixture();
    const adapter = new AdaptationAdapterV2({
      runtimeCapabilities: fixture.serviceRuntime,
      ...deterministicProviders(),
      now: () => adaptationV2TestNow,
    });

    const result = await adapter.adapt(fixture.request, fixture.validationContext);
    const behavior = result.validation.find((record) =>
      record.policyCheckId === "behavior-differential");
    expect(behavior).toMatchObject({
      status: "unverified",
      required: true,
      failureReason: "required-verifier-evidence-missing",
    });
    expect(evaluateValidationPolicyGate(
      fixture.request.validationPolicy,
      result.validation,
      { subjectHash: result.patchHash },
    )).toMatchObject({
      allowed: false,
      blockers: [expect.objectContaining({ policyCheckId: "behavior-differential" })],
    });
  });

  it.each<[string, VerificationResultMutation]>([
    ["stale subjectHash", (result) => ({ ...result, subjectHash: "f".repeat(64) })],
    ["wrong round", (result) => ({ ...result, round: result.round + 1 })],
    ["invalid contentHash", (result) => ({ ...result, contentHash: "f".repeat(64) })],
  ])("fails closed when the behavior verifier returns a %s", async (_name, mutate) => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = {
      providerId: "forexplore.translation-verifier.differential",
      providerVersion: "1.0.0",
      verify: vi.fn(async (input) => mutate(validVerificationResult(input))),
    };
    const adapter = new AdaptationAdapterV2({
      runtimeCapabilities: fixture.serviceRuntime,
      ...deterministicProviders(),
      verifier,
      now: () => adaptationV2TestNow,
    });

    const result = await adapter.adapt(fixture.request, fixture.validationContext);
    const behavior = result.validation.find((record) =>
      record.policyCheckId === "behavior-differential");

    expect(behavior).toMatchObject({
      status: "unverified",
      required: true,
      subjectHash: result.patchHash,
      failureReason: "invalid-verifier-result",
    });
    expect(evaluateValidationPolicyGate(
      fixture.request.validationPolicy,
      result.validation,
      { subjectHash: result.patchHash },
    ).allowed).toBe(false);
  });
});
