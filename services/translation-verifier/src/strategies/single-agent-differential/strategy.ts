import { realpathSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  VerificationArtifact,
  VerificationAssessment,
  VerificationInput,
  VerificationProblem,
  VerificationStrategy,
  VerificationStrategyContext,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
} from "../../schemas/verification-types.js";
import type {
  BehaviorAgentResult,
  BehaviorCommandRecord,
  BehaviorRuntime,
  BehaviorSide,
} from "../multi-agent-differential/behavior-types.js";
import {
  BehaviorEnvironmentError,
  createBehaviorRuntime,
} from "../multi-agent-differential/claude-runtime.js";
import {
  parseBehaviorJson,
  parseObservations,
} from "../multi-agent-differential/behavior-schema.js";
import {
  assertDeclaredSnapshot,
  assertProjectRoots,
  assertProjectBaseline,
  captureProjectBaseline,
  isProjectTestPath,
  persistBehaviorArtifact,
  prepareTestDirectory,
  readTestFile,
  TEST_DIRECTORY,
} from "../multi-agent-differential/behavior-workspace.js";
import {
  protectedSecrets,
  redact,
} from "../multi-agent-differential/behavior-command.js";
import { buildSingleAgentPrompt } from "./prompt.js";
import {
  parseSingleAgentManifest,
  parseSingleAgentPlan,
  type SingleAgentPlan,
} from "./report.js";

export const SINGLE_AGENT_DIFFERENTIAL_STRATEGY: VerificationStrategyDescriptor =
  {
    id: "single-agent-differential",
    version: "1.0.0",
    displayName: "Single-Agent Differential",
  };
export interface SingleAgentDifferentialOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  effort?: string;
  runtime?: BehaviorRuntime;
  /** Trusted caller execution authorization. Available directories alone do not grant extra permissions. */
  executionSides?: BehaviorSide[];
}
class SingleAgentFailure extends Error {
  constructor(
    readonly code: VerificationProblem["code"],
    message: string,
  ) {
    super(message);
  }
}
const limitations = [
  "One agent derives expectations and test harnesses. Host execution checks do not prove the basis, harness correctness, coverage, or business correctness.",
  "Matching source and target observations cannot detect shared defects. Only the frozen cases and modeled observable effects are checked.",
  "Project baselines and fixed command controls are workflow checks, not OS isolation. Supplied projects and build scripts must be trusted for execution.",
];
export class SingleAgentDifferentialStrategy implements VerificationStrategy {
  constructor(private readonly options: SingleAgentDifferentialOptions = {}) {}
  async verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput> {
    const timeoutMs = this.options.timeoutMs ?? 300000;
    const deadlineAt = Math.min(context.deadlineAt, Date.now() + timeoutMs);
    const timeout = AbortSignal.timeout(
      Math.max(
        0,
        Math.min(
          2147483647,
          Math.floor(Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : 0),
        ),
      ),
    );
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const artifacts: VerificationArtifact[] = [];
    let evidence: BehaviorCommandRecord[] = [];
    let frozenPlan: string | undefined;
    let plan: SingleAgentPlan | undefined;
    let stage = "preparation";
    let cases: {
      caseId: string;
      source: unknown;
      target: unknown;
      expected: unknown;
      matches: boolean;
    }[] = [];
    let assessment: VerificationAssessment = {
      mode: "target_only",
      referenceDecision: "undetermined",
      referenceReason: "No validated Agent reference decision is available.",
      executionStatus: "failed",
      sourceAssessment: "not_checked",
      targetAssessment: "inconclusive",
      problems: [],
    };
    let checkIntegrity = () => {};
    const secrets = protectedSecrets(
      this.options.apiKey ?? process.env.DEEPSEEK_API_KEY,
    );
    const recordArtifact = async (id: string, value: unknown) => {
      const artifact = await persistBehaviorArtifact(
        context,
        id,
        parseBehaviorJson(
          redact(JSON.stringify(value), secrets),
          10 * 1024 * 1024,
          24,
        ),
      );
      artifacts.push(artifact);
      return artifact;
    };
    try {
      if (
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        !Number.isFinite(deadlineAt)
      )
        throw new SingleAgentFailure(
          "context_incomplete",
          "Invalid single-agent deadline.",
        );
      combined.throwIfAborted();
      if (deadlineAt <= Date.now())
        throw new SingleAgentFailure(
          "agent_timeout",
          "Verification deadline expired.",
        );
      const executionSides = this.options.executionSides ?? [
        "source",
        "target",
      ];
      if (
        !executionSides.includes("target") ||
        executionSides.some((side) => !["source", "target"].includes(side))
      )
        throw new SingleAgentFailure(
          "context_incomplete",
          "Target execution is not authorized.",
        );
      assertProjectRoots(context);
      const { sourceRoot, targetRoot } = context.workspace;
      const baselines = [
        captureProjectBaseline(sourceRoot),
        captureProjectBaseline(targetRoot),
      ];
      checkIntegrity = () => {
        for (const baseline of baselines) assertProjectBaseline(baseline);
      };
      assertDeclaredSnapshot(input, sourceRoot, "source");
      assertDeclaredSnapshot(input, targetRoot, "target");
      const roots = { source: sourceRoot, target: targetRoot };
      const scopes = Object.fromEntries(
        (["source", "target"] as const).map((side, index) => [
          side,
          {
            cwd: roots[side],
            readRoots: [sourceRoot, targetRoot],
            writeRoots: [prepareTestDirectory(roots[side]), roots[side]],
            baseline: baselines[index],
          },
        ]),
      );
      const expectationFile = join(targetRoot, TEST_DIRECTORY, "plan.json");
      const runtime =
        this.options.runtime ?? createBehaviorRuntime(this.options);
      stage = "agent";
      let agent: BehaviorAgentResult | undefined;
      let partialOutput = "";
      const prompt = buildSingleAgentPrompt(input);
      await recordArtifact("single-agent-prompt", { prompt });
      // The managed runtime must finish process-group cleanup before resolving or rejecting.
      const invoke = () =>
        runtime.runAgent({
          side: "target",
          sandbox: scopes.target!,
          additionalProjects: { source: scopes.source! },
          executionSides,
          sessionRole: "single-agent",
          expectationFile,
          prompt,
          deadlineAt,
          signal: combined,
          onOutput: (text) => {
            partialOutput = redact(text, secrets).slice(0, 1024 * 1024);
          },
          onEvidence: (records, frozen) => {
            evidence = records;
            frozenPlan = frozen;
          },
        });
      try {
        agent = await (context.measureStep
          ? context.measureStep("single-agent-session", invoke)
          : invoke());
        evidence = agent.commandEvidence ?? evidence;
        frozenPlan = agent.frozenPlan ?? frozenPlan;
      } finally {
        await recordArtifact("single-agent-session", {
          ...(agent ?? {}),
          partialOutput,
          commandEvidence: evidence,
          frozenPlan: frozenPlan ?? null,
        });
        checkIntegrity();
      }
      combined.throwIfAborted();
      if (agent.timedOut)
        throw new SingleAgentFailure(
          "agent_timeout",
          "Single-agent session timed out.",
        );
      if (agent.exitCode !== 0)
        throw new SingleAgentFailure(
          "agent_error",
          "Single-agent session failed; no repair session is started.",
        );
      stage = "evidence";
      if (!frozenPlan)
        throw new SingleAgentFailure(
          "insufficient_test_basis",
          "Missing Host-frozen Agent test basis before target execution.",
        );
      if (
        readTestFile(targetRoot, `${TEST_DIRECTORY}/plan.json`) !== frozenPlan
      )
        throw new SingleAgentFailure(
          "workspace_integrity_violation",
          "Frozen test plan changed after target execution.",
        );
      try {
        plan = parseSingleAgentPlan(frozenPlan);
      } catch (cause) {
        throw new SingleAgentFailure("insufficient_test_basis", String(cause));
      }
      assessment = {
        ...assessment,
        mode: plan.mode,
        referenceDecision:
          plan.mode === "differential" ? "accepted" : "rejected",
        referenceReason: plan.referenceReason,
        sourceAssessment:
          plan.mode === "differential" ? "inconclusive" : "not_checked",
      };
      const manifest = parseSingleAgentManifest(
        readTestFile(targetRoot, `${TEST_DIRECTORY}/report.json`),
      );
      const ids = new Set<string>();
      for (const record of evidence) {
        if (
          !record.commandId ||
          ids.has(record.commandId) ||
          !record.side ||
          !executionSides.includes(record.side) ||
          record.cwd !== realpathSync(roots[record.side]) ||
          !record.baselineValid ||
          record.credentialHit
        )
          throw new SingleAgentFailure(
            "report_evidence_invalid",
            "Invalid, unauthorized, or duplicate Host command evidence.",
          );
        if (record.completed === false)
          throw new SingleAgentFailure(
            "report_evidence_invalid",
            "A command has no completion record; execution cannot be certified.",
          );
        ids.add(record.commandId);
        if (record.timedOut)
          throw new SingleAgentFailure(
            "command_timeout",
            "A recorded command timed out.",
          );
      }
      if (
        plan.mode === "target_only" &&
        evidence.some((record) => record.side === "source")
      )
        throw new SingleAgentFailure(
          "report_evidence_invalid",
          "Target-only verification must not execute source commands.",
        );
      const target = evidence.find(
        (record) => record.commandId === manifest.targetCommandId,
      );
      if (!target || target.side !== "target" || target.exitCode !== 0)
        throw new SingleAgentFailure(
          "report_evidence_invalid",
          "No successful Host target command matches the report.",
        );
      const caseIds = plan.cases.map((item) => item.caseId);
      const targetResults = parseObservations(target.stdout, caseIds);
      const firstTarget = evidence.findIndex(
        (record) => record.side === "target",
      );
      cases = plan.cases.map((item) => {
        let source = null;
        if (plan!.mode === "differential") {
          const record = evidence.find(
            (row) => row.commandId === item.sourceCommandId,
          );
          if (
            !record ||
            record.side !== "source" ||
            record.exitCode !== 0 ||
            evidence.indexOf(record) >= firstTarget
          )
            throw new SingleAgentFailure(
              "report_evidence_invalid",
              "Source reference must be a successful command before target execution.",
            );
          const observations = parseBehaviorJson(record.stdout);
          if (!Array.isArray(observations))
            throw new SingleAgentFailure(
              "report_evidence_invalid",
              "Source command stdout must be observations.",
            );
          const sourceIds = observations.map(
            (row) => (row as { caseId: string }).caseId,
          );
          source =
            parseObservations(record.stdout, sourceIds).find(
              (row) => row.caseId === item.caseId,
            ) ?? null;
          if (
            !source ||
            (item.expectationBasis === "source_observation" &&
              !isDeepStrictEqual(source, item.expected))
          )
            throw new SingleAgentFailure(
              "report_evidence_invalid",
              "Frozen expected value does not match actual source evidence.",
            );
        }
        const observed = targetResults.find(
          (row) => row.caseId === item.caseId,
        )!;
        return {
          caseId: item.caseId,
          source,
          target: observed,
          expected: item.expected,
          matches: isDeepStrictEqual(item.expected, observed),
        };
      });
      for (const side of ["source", "target"] as const) {
        if (
          side === "source" &&
          plan.mode === "target_only" &&
          manifest.testFiles.source.length
        )
          throw new SingleAgentFailure(
            "report_evidence_invalid",
            "Target-only report must not claim source test execution.",
          );
        if (plan.mode === "differential" && !manifest.testFiles[side].length)
          throw new SingleAgentFailure(
            "report_evidence_invalid",
            "Differential verification requires both test harnesses.",
          );
        for (const path of manifest.testFiles[side]) {
          if (
            !isProjectTestPath(path) ||
            Object.hasOwn(baselines[side === "source" ? 0 : 1]!.files, path) ||
            [
              ".forexplore-tests/plan.json",
              ".forexplore-tests/report.json",
            ].includes(path)
          )
            throw new SingleAgentFailure(
              "report_evidence_invalid",
              "Report must identify newly authored project test files.",
            );
          const content = readTestFile(roots[side], path);
          const executed =
            side === "target"
              ? [target]
              : evidence.filter(
                  (row) =>
                    row.side === "source" &&
                    plan!.cases.some(
                      (item) => item.sourceCommandId === row.commandId,
                    ),
                );
          if (!executed.some((row) => row.testFiles?.[path] === content))
            throw new SingleAgentFailure(
              "report_evidence_invalid",
              "Test file is absent from execution evidence or changed after execution.",
            );
          await recordArtifact(
            `single-agent-${side}-test-${artifacts.length}`,
            { side, path, content },
          );
        }
      }
      checkIntegrity();
      stage = "comparison";
      assessment = {
        ...assessment,
        executionStatus: "completed",
        targetAssessment: cases.some((item) => !item.matches)
          ? "bug_found"
          : "no_bug_observed",
        problems: [],
      };
    } catch (cause) {
      try {
        checkIntegrity();
      } catch (integrity) {
        cause = new SingleAgentFailure(
          "workspace_integrity_violation",
          String(integrity),
        );
      }
      const message = redact(
        cause instanceof Error ? cause.message : String(cause),
        secrets,
      );
      const code: VerificationProblem["code"] =
        cause instanceof SingleAgentFailure
          ? cause.code
          : signal?.aborted
            ? "cancelled"
            : combined.aborted
              ? "agent_timeout"
              : /baseline|integrity|outside project|Hard-linked|linked test|snapshot/.test(
                    message,
                  )
                ? "workspace_integrity_violation"
                : cause instanceof BehaviorEnvironmentError
                  ? "environment_unavailable"
                  : stage === "preparation"
                    ? "context_incomplete"
                    : stage === "agent"
                      ? "agent_error"
                      : "report_evidence_invalid";
      assessment = {
        ...assessment,
        executionStatus: code === "cancelled" ? "cancelled" : "failed",
        targetAssessment: "inconclusive",
        sourceAssessment:
          assessment.mode === "differential" ? "inconclusive" : "not_checked",
        problems: [{ code, message }],
      };
    }
    const report = {
      schemaVersion: "1.0",
      stage,
      ...(plan ? { plan } : {}),
      cases,
      evidence,
      limitations,
    };
    const reportArtifact = await recordArtifact("single-agent-report", report);
    return {
      ...assessment,
      summary: `${stage}: ${assessment.executionStatus}; ${cases.length} recorded cases. Agent-derived test evidence, not proof of business correctness.`,
      artifacts,
      strategyReport: parseBehaviorJson(
        redact(JSON.stringify(report), secrets),
        10 * 1024 * 1024,
        24,
      ),
      issues:
        assessment.executionStatus === "completed"
          ? cases
              .filter((item) => !item.matches)
              .map((item) => ({
                id: `single-agent-${item.caseId}`,
                kind: "behavioral-divergence",
                caseId: item.caseId,
                message:
                  "Target observation differs from the frozen expected outcome.",
                targetObservation: parseBehaviorJson(
                  JSON.stringify(item.target),
                ),
                evidenceArtifactIds: [reportArtifact.id],
              }))
          : assessment.problems.map((problem, index) => ({
              id: `single-agent-problem-${index}`,
              kind: problem.code,
              message: problem.message,
              evidenceArtifactIds: [reportArtifact.id],
            })),
    };
  }
}
export function createSingleAgentDifferentialProvider(
  options: SingleAgentDifferentialOptions = {},
): VerificationStrategyProvider {
  return {
    descriptor: SINGLE_AGENT_DIFFERENTIAL_STRATEGY,
    workspaceRequirements: () => ({ source: true }),
    create: () => new SingleAgentDifferentialStrategy(options),
  };
}
