import { currentRunRecorder } from "../../record-run-events.js";
import { markVerificationPhase } from "../../verification-timing.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import type { EffortLevel, SpawnClaude } from "./claude-client.js";
import type { SmokeCaseVerdict, VerifierLanguage } from "./types.js";
import type {
  VerificationArtifact,
  VerificationInput,
  VerificationIssue,
  VerificationStrategy,
  VerificationStrategyContext,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
} from "../../verification-types.js";
import {
  createWorkspaceBaseline,
  writeWorkspaceBaseline,
} from "./workspace-baseline.js";
import { runSmoke, type SmokeResult, type SmokeRunOptions } from "./runner.js";
import type { SmokeTaskInput } from "./prompts/task.js";

export const DIFFERENTIAL_SMOKE_STRATEGY: VerificationStrategyDescriptor = {
  id: "differential-smoke",
  version: "1.0.0",
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

const runnerRoots = [
  "source/.forexplore-tests",
  "target/.forexplore-tests",
] as const;
const mutableFiles = [
  "agent/report.json",
  "agent/claude-steps.jsonl",
  "agent/commands.jsonl",
] as const;

export class DifferentialSmokeStrategy implements VerificationStrategy {
  readonly recordsExecutionStages = true;
  readonly #prepared = new WeakSet<VerificationStrategyContext>();
  readonly #options: DifferentialSmokeStrategyOptions;

  constructor(options: DifferentialSmokeStrategyOptions = {}) {
    this.#options = options;
  }

  preflight(input: VerificationInput): VerificationStrategyOutput | undefined {
    markVerificationPhase("strategy-capability-and-context-preflight");
    const sourceLanguageId =
      input.request.route?.sourceLanguageId ??
      input.request.candidate.entity.languageId;
    const targetLanguageId =
      input.request.route?.targetLanguageId ??
      input.request.target.entity.languageId;
    const sourceLanguage = languageFor(sourceLanguageId);
    const targetLanguage = languageFor(targetLanguageId);
    if (sourceLanguage === undefined || targetLanguage === undefined) {
      return {
        status: "unverified",
        summary: `Unsupported differential smoke language route: ${sourceLanguageId} -> ${targetLanguageId}`,
        issues: [
          {
            id: "unsupported-language-route",
            kind: "unsupported-language",
            message: `differential-smoke@1.0.0 does not support ${sourceLanguageId} -> ${targetLanguageId}`,
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
        status: "unverified",
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

  prepareWorkspace(_input: VerificationInput, context: VerificationStrategyContext): void {
    markVerificationPhase("workspace-baseline-creation");
    prepareCallerOwnedWorkspace(context);
    this.#prepared.add(context);
  }

  async verify(input: VerificationInput, context: VerificationStrategyContext, signal?: AbortSignal): Promise<VerificationStrategyOutput> {
    // Direct strategy callers retain preflight/baseline behavior. Host-prepared contexts must not be re-baselined.
    if (!this.#prepared.has(context)) {
      const early = this.preflight(input);
      if (early !== undefined) return early;
      this.prepareWorkspace(input, context);
    }
    this.#prepared.delete(context);
    const sourceLanguage = languageFor(input.request.route?.sourceLanguageId ?? input.request.candidate.entity.languageId)!;
    const targetLanguage = languageFor(input.request.route?.targetLanguageId ?? input.request.target.entity.languageId)!;
    const run = this.#options.runSmokeImpl ?? this.#options.runSmoke ?? runSmoke;
    const recorder = currentRunRecorder();
    const stages = recorder?.snapshot().stages;
    const injected = run !== runSmoke && stages?.[1].state === "completed" && stages[2].state === "not-started";
    if (injected) recorder!.startStage("prepare-agent-task");
    const job = smokeInput(input, context, sourceLanguage, targetLanguage);
    const options = smokeOptions(context, this.#options);
    if (injected) {
      recorder!.endStage("prepare-agent-task", "completed");
      recorder!.startStage("run-agent-tests");
    }
    const smoke = await run(job, options, signal);
    if (injected) {
      recorder!.endStage("run-agent-tests", "completed");
      recorder!.startStage("evaluate-evidence");
    }
    markVerificationPhase("strategy-report-persistence");
    const artifact = await writeSmokeReportArtifact(context, smoke);
    markVerificationPhase("strategy-result-mapping");

    const output: VerificationStrategyOutput = {
      status: smokeStatus(smoke),
      summary: smoke.summary,
      issues: smokeIssues(smoke, artifact.id),
      artifacts: [artifact],
      // SAFETY: SmokeReport contains JSON data; createVerificationResult validates it before persistence.
      strategyReport: smoke.report as unknown as RepositoryIngestionJsonValue,
    };
    if (injected) recorder!.endStage("evaluate-evidence", "completed");
    return output;
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

function prepareCallerOwnedWorkspace(
  context: VerificationStrategyContext,
): void {
  mkdirSync(context.workspace.strategyRoot, { recursive: true });
  for (const root of runnerRoots)
    mkdirSync(join(context.workspace.root, root), { recursive: true });
  writeWorkspaceBaseline(
    join(context.workspace.root, "baseline.json"),
    createWorkspaceBaseline(context.workspace.root, runnerRoots, mutableFiles),
  );
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
    `${JSON.stringify(smoke.report, null, 2)}\n`,
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

function smokeStatus(smoke: SmokeResult): VerificationStrategyOutput["status"] {
  if (smoke.status === "pass") return "pass";
  if (smoke.status === "fail") return "fail";
  return "unverified";
}

function smokeIssues(
  smoke: SmokeResult,
  artifactId: string,
): VerificationIssue[] {
  if (smoke.status === "pass") return [];
  if (smoke.status === "fail") {
    const bugCases = smoke.evaluation?.bugCases ?? [];
    if (bugCases.length === 0) {
      return [
        issue(
          "smoke-fail",
          smoke.evaluation?.reason ?? "behavioral-divergence",
          smoke.summary,
          artifactId,
        ),
      ];
    }
    return bugCases.map((caseVerdict, index) =>
      caseIssue(caseVerdict, artifactId, index),
    );
  }
  return [
    issue(
      "smoke-error",
      smoke.errorReason ?? "smoke-error",
      smoke.summary,
      artifactId,
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
  const sourceDependencies = input.request.sourceBundle.dependencyIds ?? [];
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
