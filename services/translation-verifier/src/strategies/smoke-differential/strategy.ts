import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryIngestionJsonValue } from "@forexplore/contracts";
import { measureStep } from "../../run-output/record-run.js";
import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import type { EffortLevel, SpawnClaude } from "./claude-session.js";
import type { SmokeCaseVerdict } from "./differential-test-types.js";
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
import { prepareCallerOwnedWorkspace } from "./prepare-projects.js";
import { prepareSmokeInput } from "./prepare-smoke-input.js";
import {
  runSmoke,
  type SmokeResult,
  type SmokeRunOptions,
} from "./run-smoke-verification.js";

export const DIFFERENTIAL_SMOKE_STRATEGY: VerificationStrategyDescriptor = {
  id: "differential-smoke",
  version: "2.0.0",
  displayName: "Differential Smoke",
};
export type RunSmokeImpl = typeof runSmoke;
export interface DifferentialSmokeStrategyOptions {
  runSmokeImpl?: RunSmokeImpl;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  effort?: EffortLevel;
  spawnClaude?: SpawnClaude;
}

export class DifferentialSmokeStrategy implements VerificationStrategy {
  readonly #options: DifferentialSmokeStrategyOptions;
  constructor(options: DifferentialSmokeStrategyOptions = {}) {
    this.#options = options;
  }

  async verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput> {
    const deadlineAt = Math.min(
      context.deadlineAt,
      this.#options.timeoutMs === undefined
        ? Number.POSITIVE_INFINITY
        : Date.now() + this.#options.timeoutMs,
    );
    const measure = context.measureStep ?? measureStep;
    const preflight = await measure("check-applicability", () => {
      markVerificationPhase("strategy-capability-and-context-preflight");
      return prepareSmokeInput(input, context);
    });
    if (!preflight.applicable) return preflight.output;
    const layout = await measure("prepare-projects-and-baseline", () => {
      markVerificationPhase("workspace-baseline-creation");
      return prepareCallerOwnedWorkspace(
        context,
        preflight.job.verificationPolicy?.referenceDecision === "accepted",
      );
    });
    const options = await measure(
      "build-smoke-input",
      (): SmokeRunOptions => ({
        layout,
        deadlineAt,
        apiKey: this.#options.apiKey,
        model: this.#options.model,
        maxTurns: this.#options.maxTurns,
        effort: this.#options.effort,
        spawnClaude: this.#options.spawnClaude,
      }),
    );
    const run = this.#options.runSmokeImpl ?? runSmoke;
    const smoke = await measure("run-smoke", () =>
      run(preflight.job, options, signal),
    );
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
