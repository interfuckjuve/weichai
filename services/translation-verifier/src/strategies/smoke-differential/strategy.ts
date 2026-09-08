import {
  failureAssessment,
  resolveVerificationPolicy,
} from "../../schemas/verification-assessment.js";
import { measureStep } from "../../run-output/record-run.js";
import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import type { EffortLevel, SpawnClaude } from "./claude-session.js";
import type {
  SmokeCaseVerdict,
  VerifierLanguage,
} from "./differential-test-types.js";
import type {
  VerificationArtifact,
  VerificationInput,
  VerificationIssue,
  VerificationStrategy,
  VerificationStrategyContext,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
} from "../../schemas/verification-types.js";
import {
  prepareCallerOwnedWorkspace,
  smokeRunnerRoots as runnerRoots,
} from "./prepare-projects.js";
import {
  runSmoke,
  type SmokeResult,
  type SmokeRunOptions,
} from "./run-smoke-verification.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";

export const DIFFERENTIAL_SMOKE_STRATEGY: VerificationStrategyDescriptor = {
  id: "differential-smoke",
  version: "2.0.0",
  displayName: "Differential Smoke",
};

export type RunSmokeImpl = typeof runSmoke;

export interface DifferentialSmokeStrategyOptions {
  runSmoke?: RunSmokeImpl;
  runSmokeImpl?: RunSmokeImpl;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  effort?: EffortLevel;
  spawnClaude?: SpawnClaude;
}

const verifierLanguage: ReadonlyMap<string, VerifierLanguage> = new Map([
  ["java", "Java"],
  ["csharp", "C#"],
  ["python", "Python"],
  ["typescript", "TypeScript"],
]);

export class DifferentialSmokeStrategy implements VerificationStrategy {
  readonly #options: DifferentialSmokeStrategyOptions;

  constructor(options: DifferentialSmokeStrategyOptions = {}) {
    this.#options = options;
  }

  #checkApplicability(
    input: VerificationInput,
  ): VerificationStrategyOutput | undefined {
    markVerificationPhase("strategy-capability-and-context-preflight");
    const policy = resolveVerificationPolicy(input);
    if (!policy.testBasis?.trim()) {
      const summary = "Independent Host-confirmed test basis is missing.";
      return {
        ...failureAssessment(input, "insufficient_test_basis", summary),
        summary,
        issues: [],
        artifacts: [],
        strategyReport: null,
      };
    }
    const sourceLanguageId =
      input.request.route?.sourceLanguageId ??
      input.request.candidate.entity.languageId;
    const targetLanguageId =
      input.request.route?.targetLanguageId ??
      input.request.target.entity.languageId;
    const sourceLanguage = languageFor(sourceLanguageId);
    const targetLanguage = languageFor(targetLanguageId);
    if (
      (policy.mode === "differential" && sourceLanguage === undefined) ||
      targetLanguage === undefined
    ) {
      return {
        ...failureAssessment(
          input,
          "unsupported_language",
          `Unsupported language route: ${sourceLanguageId} -> ${targetLanguageId}`,
        ),
        summary: `Unsupported differential smoke language route: ${sourceLanguageId} -> ${targetLanguageId}`,
        issues: [
          {
            id: "unsupported-language-route",
            kind: "unsupported-language",
            message: `differential-smoke@2.0.0 does not support ${sourceLanguageId} -> ${targetLanguageId}`,
            evidenceArtifactIds: [],
          },
        ],
        artifacts: [],
        strategyReport: {
          unsupportedLanguages: { sourceLanguageId, targetLanguageId },
        },
      };
    }

    const insufficientContext = insufficientContextReason(input);
    if (insufficientContext !== undefined) {
      return {
        ...failureAssessment(
          input,
          "context_incomplete",
          insufficientContext.message,
        ),
        summary:
          "Differential smoke verification requires additional migration context.",
        issues: [
          {
            id: "insufficient-context",
            kind: "insufficient-context",
            message: insufficientContext.message,
            evidenceArtifactIds: [],
          },
        ],
        artifacts: [],
        strategyReport: { preflight: insufficientContext.details },
      };
    }

    return undefined;
  }

  async verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput> {
    const measure = context.measureStep ?? measureStep;
    const early = await measure("check-applicability", () =>
      this.#checkApplicability(input),
    );
    if (early !== undefined) return early;
    await measure("prepare-projects-and-baseline", () => {
      markVerificationPhase("workspace-baseline-creation");
      prepareCallerOwnedWorkspace(
        context,
        resolveVerificationPolicy(input).mode === "differential",
      );
    });
    const targetLanguage = languageFor(
      input.request.route?.targetLanguageId ??
        input.request.target.entity.languageId,
    )!;
    // The source language is unused in target_only prompts and execution.
    const sourceLanguage =
      languageFor(
        input.request.route?.sourceLanguageId ??
          input.request.candidate.entity.languageId,
      ) ?? targetLanguage;
    const run =
      this.#options.runSmokeImpl ?? this.#options.runSmoke ?? runSmoke;
    const { job, options } = await measure("build-smoke-input", () => ({
      job: smokeInput(input, context, sourceLanguage, targetLanguage),
      options: smokeOptions(context, this.#options),
    }));
    const smoke = await measure("run-smoke", () => run(job, options, signal));
    const artifact = await measure("persist-strategy-report", () => {
      markVerificationPhase("strategy-report-persistence");
      return writeSmokeReportArtifact(context, smoke);
    });
    return measure("map-strategy-result", (): VerificationStrategyOutput => {
      markVerificationPhase("strategy-result-mapping");
      return {
        mode: smoke.mode,
        referenceDecision: smoke.referenceDecision,
        referenceReason: smoke.referenceReason,
        executionStatus: smoke.executionStatus,
        sourceAssessment: smoke.sourceAssessment,
        targetAssessment: smoke.targetAssessment,
        problems: smoke.problems,
        summary: smoke.summary,
        issues: smokeIssues(smoke, artifact.id),
        artifacts: [artifact],
        // SAFETY: SmokeReport contains JSON data; the framework validates it before persistence.
        strategyReport: smoke.report as unknown as RepositoryIngestionJsonValue,
      };
    });
  }
}

export function createDifferentialSmokeProvider(
  options: DifferentialSmokeStrategyOptions = {},
): VerificationStrategyProvider {
  return {
    descriptor: DIFFERENTIAL_SMOKE_STRATEGY,
    create: () => new DifferentialSmokeStrategy(options),
  };
}

function smokeInput(
  input: VerificationInput,
  context: VerificationStrategyContext,
  sourceLanguage: VerifierLanguage,
  targetLanguage: VerifierLanguage,
): SmokeTaskInput {
  const targetEntity = input.request.target.entity;
  const declaration =
    input.request.targetContext.declarations.find(
      (fact) =>
        fact.entityId === targetEntity.entityId ||
        fact.path === targetEntity.path,
    ) ?? input.request.targetContext.declarations[0];
  return {
    verificationPolicy: input.verificationPolicy,
    requirement: input.request.requirement,
    analysisReport: JSON.stringify(input.analysisReport),
    source: {
      language: sourceLanguage,
      root: context.workspace.sourceRoot,
      candidatePath:
        input.request.candidate.entity.path ??
        input.request.sourceBundle.files[0]?.path,
    },
    target: {
      language: targetLanguage,
      className:
        stringAttribute(declaration?.attributes, "containerName") ??
        targetEntity.qualifiedName ??
        targetEntity.name,
      method: targetEntity.name,
      isStatic: booleanAttribute(declaration?.attributes, "isStatic") ?? false,
      root: context.workspace.targetRoot,
      file: targetEntity.path,
    },
  };
}

function smokeOptions(
  context: VerificationStrategyContext,
  options: DifferentialSmokeStrategyOptions,
): SmokeRunOptions {
  return {
    mode: "verify-only",
    workspaceDir: context.workspace.strategyRoot,
    executionRoot: context.workspace.root,
    baselinePath: join(context.workspace.root, "baseline.json"),
    commandEvidencePath: join(context.workspace.strategyRoot, "commands.jsonl"),
    runnerRoots,
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs: options.timeoutMs,
    maxTurns: options.maxTurns,
    effort: options.effort,
    spawnClaude: options.spawnClaude,
  };
}

async function writeSmokeReportArtifact(
  context: VerificationStrategyContext,
  smoke: SmokeResult,
): Promise<VerificationArtifact> {
  const path = "reports/differential-smoke-report.json";
  mkdirSync(join(context.workspace.strategyRoot, "reports"), {
    recursive: true,
  });
  writeFileSync(
    join(context.workspace.strategyRoot, path),
    `${JSON.stringify(
      smoke.report ?? {
        executionStatus: smoke.executionStatus,
        sourceAssessment: smoke.sourceAssessment,
        targetAssessment: smoke.targetAssessment,
        problems: smoke.problems,
        summary: smoke.summary,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return context.writeArtifact({
    id: "differential-smoke-report",
    kind: "strategy-report",
    path,
    contentHash: "0".repeat(64),
    mediaType: "application/json",
  });
}

function smokeIssues(
  smoke: SmokeResult,
  artifactId: string,
): VerificationIssue[] {
  const sourceBugs =
    smoke.sourceAssessment === "bug_found"
      ? (smoke.report?.cases ?? []).filter(
          (item) => item.sourceAssessment === "bug_found",
        )
      : [];
  const sourceIssues = sourceBugs.map((item, index) => ({
    ...caseIssue(item, artifactId, index),
    id: `source-bug-${index + 1}-${item.caseId}`,
    kind: "source-bug",
  }));
  const targetIssues =
    smoke.targetAssessment === "bug_found"
      ? smoke.bugCases?.length
        ? smoke.bugCases.map((item, index) =>
            caseIssue(item, artifactId, index),
          )
        : [
            issue(
              "smoke-finding",
              "behavioral-divergence",
              smoke.summary,
              artifactId,
            ),
          ]
      : [];
  return [
    ...sourceIssues,
    ...targetIssues,
    ...smoke.problems.map((problem, index) =>
      issue(
        `smoke-problem-${index + 1}`,
        problem.code,
        problem.message,
        artifactId,
      ),
    ),
  ];
}

function caseIssue(
  caseVerdict: SmokeCaseVerdict,
  artifactId: string,
  index: number,
): VerificationIssue {
  return {
    id: `smoke-case-${index + 1}-${caseVerdict.caseId}`,
    kind: "behavioral-divergence",
    message:
      caseVerdict.reasoning ||
      "Differential smoke found a translation behavior divergence.",
    caseId: caseVerdict.caseId,
    sourceObservation: caseVerdict.source as RepositoryIngestionJsonValue,
    targetObservation: caseVerdict.target as RepositoryIngestionJsonValue,
    evidenceArtifactIds: [artifactId],
  };
}

function issue(
  id: string,
  kind: string,
  message: string,
  artifactId: string,
): VerificationIssue {
  return { id, kind, message, evidenceArtifactIds: [artifactId] };
}

function languageFor(languageId: string): VerifierLanguage | undefined {
  return verifierLanguage.get(languageId) as VerifierLanguage | undefined;
}

function insufficientContextReason(
  input: VerificationInput,
): { message: string; details: RepositoryIngestionJsonValue } | undefined {
  const unresolvedFields = [
    ["analysisReport", input.analysisReport],
    ["migrationPlan", input.migrationPlan],
  ].flatMap(([field, value]) =>
    isNonEmptyStringArray(recordValue(value, "unresolved")) ? [field] : [],
  );
  const sourceDependencies =
    resolveVerificationPolicy(input).mode === "differential"
      ? (input.request.sourceBundle.dependencyIds ?? [])
      : [];
  const targetDependencies = input.request.targetContext.dependencies ?? [];
  const missingBuildFacts =
    (sourceDependencies.length > 0 || targetDependencies.length > 0) &&
    (input.request.targetContext.buildFacts?.length ?? 0) === 0;
  if (unresolvedFields.length === 0 && !missingBuildFacts) return undefined;
  const reasons: RepositoryIngestionJsonValue[] = [];
  if (unresolvedFields.length > 0)
    reasons.push({ code: "unresolved", fields: unresolvedFields });
  if (missingBuildFacts)
    reasons.push({
      code: "dependencies-without-build-facts",
      sourceDependencyCount: sourceDependencies.length,
      targetDependencyCount: targetDependencies.length,
    });
  return {
    message: "Required migration context is unresolved or incomplete.",
    details: { status: "insufficient-context", reasons },
  };
}

function recordValue(
  value: RepositoryIngestionJsonValue,
  key: string,
): RepositoryIngestionJsonValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, RepositoryIngestionJsonValue>)[key]
    : undefined;
}

function isNonEmptyStringArray(
  value: RepositoryIngestionJsonValue | undefined,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string")
  );
}

function stringAttribute(
  attributes: Record<string, RepositoryIngestionJsonValue> | undefined,
  name: string,
): string | undefined {
  const value = attributes?.[name];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function booleanAttribute(
  attributes: Record<string, RepositoryIngestionJsonValue> | undefined,
  name: string,
): boolean | undefined {
  const value = attributes?.[name];
  return typeof value === "boolean" ? value : undefined;
}
