import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import {
  createVerificationResult,
  type VerificationResult,
  type VerificationStrategyDescriptor,
} from "@forexplore/translation-verifier";
import {
  evaluateValidationPolicyGate,
  validateAdaptationResultV2,
} from "@forexplore/workflow-core";
import {
  AdaptationAdapterV2,
  DeepSeekMigrationTranslatorV2,
  type MigrationAnalysisV2,
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
    repair: vi.fn(),
  };
  return { analyzer, planner, translator };
}

const behaviorStrategyDescriptor: VerificationStrategyDescriptor = {
  id: "forexplore.translation-verifier.differential",
  version: "1.0.0",
  displayName: "Fixture Differential Verifier",
};

// Test-only seam: it executes only the fixed repository fixture in local child
// processes. It is deterministic evidence for this test, not a production
// isolated-executor attestation (it inherits this test process environment).
const behaviorVerifier: MigrationBehaviorVerifierV2 = {
  providerId: "forexplore.translation-verifier.differential",
  providerVersion: "1.0.0",
  strategyDescriptor: behaviorStrategyDescriptor,
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
  descriptor: VerificationStrategyDescriptor = behaviorStrategyDescriptor,
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
  }, descriptor, output.status === "fail" && output.artifacts.length === 0
    ? { ...output, artifacts: [{ id: "repair-artifact", kind: "report", path: "repair.json", contentHash: "b".repeat(64), mediaType: "application/json" }] }
    : output, () => adaptationV2TestNow);
}

type VerificationResultMutation = (input: MigrationBehaviorVerificationInputV2) => VerificationResult;

describe("AdaptationAdapterV2", () => {
  it("sends structured repair feedback without strategy reports", async () => {
    const fixture = createAdaptationV2TestFixture();
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        schemaVersion: "1.0",
        generatedContent: adaptationV2GeneratedContent,
        completedSteps: [],
        unresolved: [],
      }) } }],
    }), { status: 200 }));
    const translator = new DeepSeekMigrationTranslatorV2({ apiKey: "test-key", request: request as unknown as typeof globalThis.fetch });
    const analysis: MigrationAnalysisV2 = { schemaVersion: "1.0", behavior: [], targetConstraints: [], mappings: [], risks: [], unresolved: [] };
    const plan = { schemaVersion: "1.0" as const, steps: [], preservedFacts: [], expectedTargetChanges: [], validationFocus: [], unresolved: [] };
    await translator.repair(fixture.request as never, analysis, plan, {
      schemaVersion: "1.0", generatedContent: "previous", completedSteps: [], unresolved: [],
    }, {
      round: 1, inputPatchHash: "a".repeat(64), issues: [{ id: "x", kind: "behavioral-divergence", message: "m", evidenceArtifactIds: [] }], validationRecordIds: [],
    });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    const payload = JSON.parse(body.messages[1].content);
    expect(payload.feedback.issues).toEqual([expect.objectContaining({ kind: "behavioral-divergence" })]);
    expect(JSON.stringify(payload)).not.toContain("strategyReport");
    expect(payload).toHaveProperty("previous");
  });

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
    ["stale subjectHash", (input) => ({ ...validVerificationResult(input), subjectHash: "f".repeat(64) })],
    ["wrong round", (input) => {
      const result = validVerificationResult(input);
      return { ...result, round: result.round + 1 };
    }],
    ["invalid contentHash", (input) => ({ ...validVerificationResult(input), contentHash: "f".repeat(64) })],
    ["wrong strategyId", (input) => validVerificationResult(input, undefined, {
      ...behaviorStrategyDescriptor,
      id: "unexpected-strategy",
    })],
    ["wrong strategyVersion", (input) => validVerificationResult(input, undefined, {
      ...behaviorStrategyDescriptor,
      version: "9.9.9",
    })],
  ])("fails closed when the behavior verifier returns a %s", async (_name, mutate) => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = {
      providerId: "forexplore.translation-verifier.differential",
      providerVersion: "1.0.0",
      strategyDescriptor: behaviorStrategyDescriptor,
      verify: vi.fn(async (input) => mutate(input)),
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
  it("runs one repair from behavior failure to pass and records normalized feedback", async () => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verify: vi.fn()
      .mockImplementationOnce(async (input) => validVerificationResult(input, { status: "fail", summary: "diverged", issues: [{ id: "div", kind: "behavioral-divergence", message: "different", evidenceArtifactIds: [] }], artifacts: [], strategyReport: {} }))
      .mockImplementationOnce(async (input) => validVerificationResult(input)) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async () => ({ schemaVersion: "1.0", generatedContent: adaptationV2GeneratedContent + "\n# repaired", completedSteps: [], unresolved: [] }));
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier, now: () => adaptationV2TestNow }).adapt(fixture.request, fixture.validationContext);
    expect(providers.translator.repair).toHaveBeenCalledOnce();
    expect(providers.translator.repair.mock.calls[0]?.[4].issues).toEqual([expect.objectContaining({ kind: "behavioral-divergence" })]);
    expect(result.repairRounds).toHaveLength(1);
    expect(result.validation.every((record) => record.subjectHash === result.patchHash)).toBe(true);
  });

  it("caps three behavior failures at two chained repairs", async () => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verify: vi.fn(async (input) => validVerificationResult(input, { status: "fail", summary: "fail", issues: [{ id: `issue-${input.round}`, kind: "behavioral-divergence", message: "fail", evidenceArtifactIds: [] }], artifacts: [], strategyReport: {} })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async (_i, _a, _p, previous) => ({ ...previous, generatedContent: previous.generatedContent + "\n# repair" }));
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext);
    expect(providers.translator.repair).toHaveBeenCalledTimes(2);
    expect(result.repairRounds.map((round) => round.round)).toEqual([1, 2]);
    expect(result.repairRounds[1]!.inputPatchHash).toBe(result.repairRounds[0]!.outputPatchHash);
    expect(result.validation.find((record) => record.policyCheckId === "behavior-differential")?.status).toBe("fail");
  });

  it("does not repair when the compiler is unavailable", async () => {
    const fixture = createAdaptationV2TestFixture();
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn();
    const result = await new AdaptationAdapterV2({
      runtimeCapabilities: fixture.serviceRuntime,
      ...providers,
      verifier: behaviorVerifier,
      compiler: { capability: () => undefined, validate: () => ({ status: "unverified", summary: "unavailable" }) },
    }).adapt(fixture.request, fixture.validationContext);
    expect(providers.translator.repair).not.toHaveBeenCalled();
    expect(result.validation.find((record) => record.policyCheckId === "target-compile")).toMatchObject({ status: "unverified", required: true });
  });
  it("does not repair required unverified behavior", async () => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verify: vi.fn(async (input) => ({ ...validVerificationResult(input), status: "unverified" })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn();
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext);
    expect(providers.translator.repair).not.toHaveBeenCalled();
    expect(result.repairRounds).toEqual([]);
  });

  it.each(["pass", "warn"] as const)("does not repair behavior %s", async (status) => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verify: vi.fn(async (input) => validVerificationResult(input, { status, summary: status, issues: [], artifacts: [], strategyReport: {} })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn();
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext);
    expect(providers.translator.repair).not.toHaveBeenCalled();
    expect(result.repairRounds).toEqual([]);
  });

  it("rejects an unchanged repair before another verification", async () => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verify: vi.fn(async (input) => validVerificationResult(input, { status: "fail", summary: "fail", issues: [{ id: "x", kind: "behavioral-divergence", message: "x", evidenceArtifactIds: [] }], artifacts: [], strategyReport: {} })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async () => ({ schemaVersion: "1.0", generatedContent: adaptationV2GeneratedContent, completedSteps: [], unresolved: [] }));
    await expect(new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext)).rejects.toThrow("new patch hash");
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("propagates the original AbortError from repair", async () => {
    const fixture = createAdaptationV2TestFixture();
    const abort = new DOMException("aborted", "AbortError");
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verify: vi.fn(async (input) => validVerificationResult(input, { status: "fail", summary: "fail", issues: [{ id: "x", kind: "behavioral-divergence", message: "x", evidenceArtifactIds: [] }], artifacts: [], strategyReport: {} })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async () => { throw abort; });
    try { await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext); } catch (error) { expect(error).toBe(abort); }
  });

  it("passes exact round, hash, and content to every verifier attempt", async () => {
    const fixture = createAdaptationV2TestFixture();
    const inputs: MigrationBehaviorVerificationInputV2[] = [];
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verify: vi.fn(async (input) => { inputs.push(input); return validVerificationResult(input, { status: input.round < 2 ? "fail" : "pass", summary: "s", issues: input.round < 2 ? [{ id: "x", kind: "behavioral-divergence", message: "x", evidenceArtifactIds: [] }] : [], artifacts: [], strategyReport: {} }); }) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async (_i, _a, _p, previous) => ({ ...previous, generatedContent: previous.generatedContent + "\n# repair" }));
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext);
    expect(inputs.map((input) => input.round)).toEqual([0, 1, 2]);
    expect(inputs.every((input) => input.files[0]?.hunks.length && input.patchHash)).toBe(true);
    expect(result.repairRounds).toHaveLength(2);
  });
});
