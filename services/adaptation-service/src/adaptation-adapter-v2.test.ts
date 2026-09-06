import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import {
  createVerificationResult,
  VerificationService,
  VerificationStrategyFactory,
  DIFFERENTIAL_SMOKE_STRATEGY,
  type VerificationReceipt,
  type VerificationResult,
  type VerificationStrategyDescriptor,
} from "@forexplore/translation-verifier";
import {
  evaluateValidationPolicyGate,
  canonicalJson,
  materializeMigrationRuntimeCapabilitySnapshot,
  materializeMigrationRunManifestV2,
  validateMigrationRunManifestV2,
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
  type MigrationTranslationV2,
} from "./adaptation-adapter-v2";
import { TranslationVerifierV2Adapter } from "./translation-verifier-v2-adapter";
import { createAdaptationRuntimeCapabilitySnapshot } from "./runtime-capability-snapshot";
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
  const translator = {
    providerId: "forexplore.translator.deepseek",
    providerVersion: "1.0.0",
    strategy: "translate" as const,
    translate: vi.fn(async () => ({
      schemaVersion: "1.0" as const,
      generatedContent: adaptationV2GeneratedContent,
      completedSteps: ["Mapped the reviewed behavior."],
      unresolved: [],
    })),
    repair: vi.fn<MigrationTranslatorV2["repair"]>(async () => ({
      schemaVersion: "1.0" as const,
      generatedContent: adaptationV2GeneratedContent,
      completedSteps: [],
      unresolved: [],
    })),
  } satisfies MigrationTranslatorV2;
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
  async verifyWithReceipt(input) {
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
): VerificationReceipt {
  const result = createVerificationResult({
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
  const path = "verification-result.json";
  const bytes = Buffer.from(canonicalJson(result), "utf8");
  return { result, resultArtifact: { id: `verification-result:${path}`, kind: "verification-result", path, contentHash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mediaType: "application/json" } };
}

type VerificationResultMutation = (input: MigrationBehaviorVerificationInputV2) => VerificationResult;

describe("AdaptationAdapterV2", () => {
  it.each(["source", "oversized-result", "abort"])("preserves real verification-service %s failure semantics through the adaptation gate", async (failure) => {
    const root = mkdtempSync(join(tmpdir(), "adaptation-receipt-failure-"));
    const fixture = createAdaptationV2TestFixture();
    const providers = deterministicProviders();
    const abort = new DOMException("cancelled", "AbortError");
    const artifactRoot = join(root, "artifacts");
    const service = new VerificationService({
      workspaceRoot: join(root, "workspaces"), artifactRoot,
      defaultStrategyId: DIFFERENTIAL_SMOKE_STRATEGY.id,
      factory: new VerificationStrategyFactory([{
        descriptor: DIFFERENTIAL_SMOKE_STRATEGY,
        create: () => ({ async verify(input, context) {
          writeFileSync(join(context.workspace.evidenceRoot, "report.json"), "{}");
          const artifact = await context.writeArtifact({ id: "report", kind: "report", path: "report.json", contentHash: "0".repeat(64), mediaType: "application/json" });
          if (failure === "source") await context.writeArtifact({ ...artifact, id: "missing", path: "missing.json" });
          if (failure === "abort") throw abort;
          return createVerificationResult(input, DIFFERENTIAL_SMOKE_STRATEGY, {
            status: "pass", summary: "verified", issues: [], artifacts: [artifact],
            strategyReport: { output: "x".repeat(10 * 1024 * 1024) },
          });
        } }),
      }]),
    });
    try {
      const adapter = new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier: new TranslationVerifierV2Adapter(service) });
      if (failure === "abort") {
        await expect(adapter.adapt(fixture.request, fixture.validationContext)).rejects.toBe(abort);
      } else {
        const result = await adapter.adapt(fixture.request, fixture.validationContext);
        const behavior = result.validation.find((record) => record.policyCheckId === "behavior-differential")!;
        expect(behavior).toMatchObject({ status: "unverified", failureReason: "artifact-persistence-failed" });
        expect(behavior.artifact).toBeUndefined();
        expect(behavior.artifactPath).toBeUndefined();
        expect(result.repairRounds).toEqual([]);
        expect(evaluateValidationPolicyGate(result.validationPolicy, result.validation, { subjectHash: result.patchHash }).allowed).toBe(false);
      }
      expect(providers.translator.repair).not.toHaveBeenCalled();
      expect(readdirSync(artifactRoot)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds real artifacts from two repair rounds into a canonical manifest without ID collisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "adaptation-repair-artifacts-"));
    const fixture = createAdaptationV2TestFixture();
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async (_i, _a, _p, previous) => ({ ...previous, generatedContent: previous.generatedContent + "\n# repair" }));
    const artifactRoot = join(root, "artifacts");
    const service = new VerificationService({
      workspaceRoot: join(root, "workspaces"), artifactRoot,
      defaultStrategyId: DIFFERENTIAL_SMOKE_STRATEGY.id,
      factory: new VerificationStrategyFactory([{
        descriptor: DIFFERENTIAL_SMOKE_STRATEGY,
        create: () => ({ async verify(input, context) {
          writeFileSync(join(context.workspace.evidenceRoot, "report.json"), JSON.stringify({ round: input.translation.round }));
          const artifact = await context.writeArtifact({ id: "report", kind: "report", path: "report.json", contentHash: "0".repeat(64), mediaType: "application/json" });
          return createVerificationResult(input, DIFFERENTIAL_SMOKE_STRATEGY, {
            status: "fail", summary: "Mismatch", issues: [{ id: "mismatch", kind: "behavioral-divergence", message: "Mismatch", evidenceArtifactIds: [artifact.id] }],
            artifacts: [artifact], strategyReport: {},
          });
        } }),
      }]),
    });
    try {
      const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier: new TranslationVerifierV2Adapter(service) }).adapt(fixture.request, fixture.validationContext);
      expect(result.repairRounds).toHaveLength(2);
      const artifacts = [
        ...result.validation.flatMap((record) => record.artifact ? [record.artifact] : []),
        ...result.repairRounds.flatMap((round) => round.verifierArtifacts),
      ];
      expect(new Set(artifacts.map((artifact) => artifact.id)).size).toBe(5);
      for (const artifact of artifacts) {
        expect(createHash("sha256").update(readFileSync(join(artifactRoot, artifact.path))).digest("hex")).toBe(artifact.contentHash);
      }
      const route = fixture.validationContext.runtimeCapabilities.routes.find((route) => route.id === result.route.routeId)!;
      const manifest = materializeMigrationRunManifestV2({
        status: "planned", request: fixture.request, result,
        providers: route.stages.map((stage) => ({ stage: stage.stage, providerId: stage.providerId, providerVersion: stage.providerVersion, status: "completed", startedAt: adaptationV2TestNow, artifactRefs: [] })),
        validators: result.validation.map((record) => ({
          providerId: record.verifierId!, providerVersion: record.verifierVersion!, policyCheckId: record.policyCheckId!,
          validationRecordId: record.id, subjectHash: result.patchHash, status: record.status,
          artifactRefs: record.artifact ? [{ id: record.artifact.id, contentHash: record.artifact.contentHash }] : [],
        })),
        artifactPaths: Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact.path])),
        createdAt: adaptationV2TestNow, updatedAt: adaptationV2TestNow,
      }, fixture.validationContext);
      expect(validateMigrationRunManifestV2(manifest, fixture.request, result, fixture.validationContext)).toBe(manifest);
      expect(readdirSync(artifactRoot)).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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
        artifactPath: "verification-result.json",
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
    ["stale subjectHash", (input) => ({ ...validVerificationResult(input).result, subjectHash: "f".repeat(64) })],
    ["wrong round", (input) => {
      const result = validVerificationResult(input).result;
      return { ...result, round: result.round + 1 };
    }],
    ["invalid contentHash", (input) => ({ ...validVerificationResult(input).result, contentHash: "f".repeat(64) })],
    ["wrong strategyId", (input) => validVerificationResult(input, undefined, { ...behaviorStrategyDescriptor, id: "unexpected-strategy" }).result],
    ["wrong strategyVersion", (input) => validVerificationResult(input, undefined, { ...behaviorStrategyDescriptor, version: "9.9.9" }).result],
  ])("fails closed when the behavior verifier returns a %s", async (_name, mutate) => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = {
      providerId: "forexplore.translation-verifier.differential",
      providerVersion: "1.0.0",
      strategyDescriptor: behaviorStrategyDescriptor,
  verifyWithReceipt: vi.fn(async (input) => ({ result: mutate(input), resultArtifact: { id: "verification-result:test", kind: "verification-result" as const, path: "verification-result.json", contentHash: "c".repeat(64), size: 2, mediaType: "application/json" as const } })),
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
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verifyWithReceipt: vi.fn()
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
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verifyWithReceipt: vi.fn(async (input) => validVerificationResult(input, { status: "fail", summary: "fail", issues: [{ id: `issue-${input.round}`, kind: "behavioral-divergence", message: "fail", evidenceArtifactIds: [] }], artifacts: [], strategyReport: {} })) };
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
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verifyWithReceipt: vi.fn(async (input) => validVerificationResult(input, {
      status: "unverified",
      summary: "Required behavior evidence is unavailable.",
      issues: [],
      artifacts: [],
      strategyReport: {},
    })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn();
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext);
    expect(providers.translator.repair).not.toHaveBeenCalled();
    expect(result.repairRounds).toEqual([]);
  });

  it.each(["pass", "warn"] as const)("does not repair behavior %s", async (status) => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verifyWithReceipt: vi.fn(async (input) => validVerificationResult(input, { status, summary: status, issues: [], artifacts: [], strategyReport: {} })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn();
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext);
    expect(providers.translator.repair).not.toHaveBeenCalled();
    expect(result.repairRounds).toEqual([]);
  });

  it("rejects an unchanged repair before another verification", async () => {
    const fixture = createAdaptationV2TestFixture();
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verifyWithReceipt: vi.fn(async (input) => validVerificationResult(input, { status: "fail", summary: "fail", issues: [{ id: "x", kind: "behavioral-divergence", message: "x", evidenceArtifactIds: [] }], artifacts: [], strategyReport: {} })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async () => ({ schemaVersion: "1.0", generatedContent: adaptationV2GeneratedContent, completedSteps: [], unresolved: [] }));
    await expect(new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext)).rejects.toThrow("new patch hash");
    expect(verifier.verifyWithReceipt).toHaveBeenCalledTimes(1);
  });

  it("propagates the original AbortError from repair", async () => {
    const fixture = createAdaptationV2TestFixture();
    const abort = new DOMException("aborted", "AbortError");
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verifyWithReceipt: vi.fn(async (input) => validVerificationResult(input, { status: "fail", summary: "fail", issues: [{ id: "x", kind: "behavioral-divergence", message: "x", evidenceArtifactIds: [] }], artifacts: [], strategyReport: {} })) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async () => { throw abort; });
    try { await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext); } catch (error) { expect(error).toBe(abort); }
  });

  it("repairs an available compiler failure with normalized feedback", async () => {
    const fixture = createAdaptationV2TestFixture();
    const route = fixture.serviceRuntime.routes.find((candidate) => candidate.id === fixture.request.route.routeId)!;
    const compilerStage = route.stages.find((stage) => stage.stage === "compile-validation")!;
    const compilerCalls: string[] = [];
    const callOrder: string[] = [];
    const compiler = {
      capability: () => ({ providerId: compilerStage.providerId, providerVersion: compilerStage.providerVersion }),
      validate: () => {
        compilerCalls.push("validate");
        callOrder.push("compile");
        return compilerCalls.length === 1
          ? { status: "fail" as const, summary: "syntax error", failureReason: "compiler-failed" }
          : { status: "pass" as const, summary: "compiled" };
      },
    };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async (_input, _analysis, _plan, previous) => ({
      ...previous,
      generatedContent: previous.generatedContent + "\n# repaired",
    }));
    const verifier: MigrationBehaviorVerifierV2 = {
      ...behaviorVerifier,
      verifyWithReceipt: vi.fn(async (input) => { callOrder.push("verify"); return validVerificationResult(input); }),
    };
    const result = await new AdaptationAdapterV2({
      runtimeCapabilities: fixture.serviceRuntime,
      ...providers,
      verifier,
      compiler,
      now: () => adaptationV2TestNow,
    }).adapt(fixture.request, fixture.validationContext);

    expect(callOrder).toEqual(["compile", "verify", "compile", "verify"]);
    expect(providers.translator.repair).toHaveBeenCalledOnce();
    const feedback = providers.translator.repair.mock.calls[0]![4];
    expect(feedback.issues).toEqual([expect.objectContaining({
      kind: "compile-failure",
      message: "syntax error",
      evidenceArtifactIds: [],
    })]);
    expect(feedback.validationRecordIds).toEqual(["validation:target-compile"]);
    expect(feedback.inputPatchHash).toBe(result.repairRounds[0]!.inputPatchHash);
    expect(JSON.stringify(feedback)).not.toContain("strategyReport");
    expect(result.validation.find((record) => record.policyCheckId === "target-compile")).toMatchObject({
      status: "pass",
      subjectHash: result.patchHash,
    });
    expect(result.repairRounds[0]).toMatchObject({
      triggerValidationRecords: expect.arrayContaining([expect.objectContaining({ policyCheckId: "target-compile", status: "fail" })]),
      inputPatchHash: expect.any(String),
      outputPatchHash: result.patchHash,
    });
  });
  it("uses the linked custom compiler identity for repair feedback without fabricating compiler artifacts", async () => {
    const customProvider = { providerId: "acme.syntax-proof", providerVersion: "7.0.0" };
    const serviceBaseline = createAdaptationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      analysisExecution: "disabled",
      verifierExecution: "local-process",
      workspaceMutationExecution: "disabled",
    });
    const executionBaseline = createAdaptationRuntimeCapabilitySnapshot({
      createdAt: adaptationV2TestNow,
      analysisExecution: "trusted-host",
      verifierExecution: "local-process",
      workspaceMutationExecution: "trusted-host",
    });
    const customize = (snapshot: typeof serviceBaseline) => materializeMigrationRuntimeCapabilitySnapshot({
      createdAt: snapshot.createdAt,
      routes: snapshot.routes.map((route) => ({
        ...route,
        stages: route.stages.map((stage) => stage.stage === "compile-validation"
          ? { ...stage, providerId: customProvider.providerId, providerVersion: customProvider.providerVersion }
          : stage),
        validationPolicy: {
          ...route.validationPolicy,
          checks: route.validationPolicy.checks.map((check) => check.id === "target-compile"
            ? { ...check, id: "syntax-proof", verifierId: customProvider.providerId, verifierVersion: customProvider.providerVersion }
            : check),
        },
      })),
    });
    const fixture = createAdaptationV2TestFixture({
      serviceRuntime: customize(serviceBaseline),
      executionRuntime: customize(executionBaseline),
    });
    const compilerCalls: string[] = [];
    const compiler = {
      capability: () => customProvider,
      validate: vi.fn(() => {
        compilerCalls.push("validate");
        return compilerCalls.length === 1
          ? { status: "fail" as const, summary: "syntax error", failureReason: "compiler-failed" }
          : { status: "pass" as const, summary: "compiled" };
      }),
    };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async (_input, _analysis, _plan, previous) => ({
      ...previous,
      generatedContent: previous.generatedContent + "\n# repaired",
    }));
    const verifier: MigrationBehaviorVerifierV2 = {
      ...behaviorVerifier,
      verifyWithReceipt: vi.fn(async (input) => validVerificationResult(input)),
    };
    const result = await new AdaptationAdapterV2({
      runtimeCapabilities: fixture.serviceRuntime,
      ...providers,
      verifier,
      compiler,
      now: () => adaptationV2TestNow,
    }).adapt(fixture.request, fixture.validationContext);

    expect(providers.translator.repair).toHaveBeenCalledOnce();
    const feedback = providers.translator.repair.mock.calls[0]![4];
    expect(feedback.issues).toEqual([expect.objectContaining({
      id: "compile-failure:validation:syntax-proof",
      kind: "compile-failure",
      evidenceArtifactIds: [],
    })]);
    expect(feedback.validationRecordIds).toEqual(["validation:syntax-proof"]);
    expect(result.repairRounds[0]).toMatchObject({
      triggerValidationRecords: expect.arrayContaining([expect.objectContaining({ policyCheckId: "syntax-proof", status: "fail" })]),
    });
    expect(result.repairRounds[0]).not.toHaveProperty("compilerArtifact");
  });
  it("passes exact round, hash, and content to every verifier attempt", async () => {
    const fixture = createAdaptationV2TestFixture();
    const inputs: MigrationBehaviorVerificationInputV2[] = [];
    const verifier: MigrationBehaviorVerifierV2 = { ...behaviorVerifier, verifyWithReceipt: vi.fn(async (input) => { inputs.push(input); return validVerificationResult(input, { status: input.round < 2 ? "fail" : "pass", summary: "s", issues: input.round < 2 ? [{ id: "x", kind: "behavioral-divergence", message: "x", evidenceArtifactIds: [] }] : [], artifacts: [], strategyReport: {} }); }) };
    const providers = deterministicProviders();
    providers.translator.repair = vi.fn(async (_i, _a, _p, previous) => ({ ...previous, generatedContent: previous.generatedContent + "\n# repair" }));
    const result = await new AdaptationAdapterV2({ runtimeCapabilities: fixture.serviceRuntime, ...providers, verifier }).adapt(fixture.request, fixture.validationContext);
    expect(inputs.map((input) => input.round)).toEqual([0, 1, 2]);
    expect(inputs.every((input) => input.files[0]?.hunks.length && input.patchHash)).toBe(true);
    expect(result.repairRounds).toHaveLength(2);
  });
});
