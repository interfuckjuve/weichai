import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  failureAssessment,
  resolveVerificationPolicy,
} from "../../schemas/verification-assessment.js";
import type {
  VerificationArtifact,
  VerificationInput,
  VerificationProblem,
  VerificationStrategy,
  VerificationStrategyContext,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
} from "../../schemas/verification-types.js";
import type {
  BehaviorCaseStatus,
  BehaviorCollectionManifest,
  BehaviorExecutionEvidence,
  BehaviorReport,
  BehaviorRuntime,
  BehaviorSide,
  BehaviorTargetManifest,
  BehaviorSandbox,
} from "./behavior-types.js";
import {
  parseBehaviorJson,
  parseCollectionManifest,
  parseObservations,
  parseTargetManifest,
} from "./behavior-schema.js";
import { buildBehaviorPrompt } from "./behavior-prompt.js";
import {
  assertDeclaredSnapshot,
  assertProjectRoots,
  hashContent,
  persistBehaviorArtifact,
  prepareTestDirectory,
  projectHash,
  readTestFile,
} from "./behavior-workspace.js";
import { createBehaviorRuntime } from "./claude-runtime.js";

export const MULTI_AGENT_DIFFERENTIAL_STRATEGY: VerificationStrategyDescriptor =
  {
    id: "multi-agent-differential",
    version: "1.0.0",
    displayName: "Multi-Agent Differential",
  };
export interface MultiAgentDifferentialOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  effort?: string;
  runtime?: BehaviorRuntime;
  /** Supplied by the caller, never a model poll loop. Absent means input.translation is already materialized. */
  waitForTarget?: (signal: AbortSignal) => Promise<void>;
}
class BehaviorFailure extends Error {
  constructor(
    readonly code: VerificationProblem["code"],
    readonly caseStatus: BehaviorCaseStatus,
    message: string,
  ) {
    super(message);
  }
}
const limitations = [
  "Source observations are an accepted reference, not an independent proof of source correctness. Matching defects in both implementations may remain undetected.",
  "Host replays generated harnesses and captures actual output; harness correctness and coverage still require review. No translation repair is performed.",
  "Only explicit JSON cases are compared. Nondeterministic behavior and unmodeled side effects remain outside this evidence.",
];

export class MultiAgentDifferentialStrategy implements VerificationStrategy {
  constructor(private readonly options: MultiAgentDifferentialOptions = {}) {}

  async verify(
    input: VerificationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput> {
    const deadlineAt = Math.min(
      context.deadlineAt,
      Date.now() + (this.options.timeoutMs ?? 300_000),
    );
    const timeout = AbortSignal.timeout(
      Math.max(0, Math.min(2_147_483_647, Math.floor(deadlineAt - Date.now()))),
    );
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const report: BehaviorReport = {
      schemaVersion: "1.0",
      stage: "eligibility",
      caseStatus: "not-executed",
      cases: [],
      evidence: [],
      limitations,
    };
    const artifacts: VerificationArtifact[] = [];
    const policy = resolveVerificationPolicy(input);
    const measure =
      context.measureStep ??
      (async <T>(_name: string, fn: () => T | Promise<T>) => fn());
    const runtime = this.options.runtime ?? createBehaviorRuntime(this.options);
    let assessment = failureAssessment(
      input,
      "context_incomplete",
      "Verification has not started.",
    );
    try {
      combined.throwIfAborted();
      assertEligibility(input);
      assertProjectRoots(context);
      const sourceRoot = context.workspace.sourceRoot;
      const targetRoot = context.workspace.targetRoot;
      const sourceHash = projectHash(sourceRoot);
      assertDeclaredSnapshot(input, sourceRoot, "source");
      report.stage = "source";
      const sourceTestRoot = prepareTestDirectory(sourceRoot);
      const sourceSandbox = {
        cwd: sourceRoot,
        readRoots: [sourceRoot, targetRoot],
        writeRoots: [sourceTestRoot],
      };
      const source = (await measure("collect-source-tests", () =>
        this.author(
          "source",
          input,
          context,
          sourceSandbox,
          runtime,
          report,
          artifacts,
          deadlineAt,
          combined,
        ),
      )) as BehaviorCollectionManifest;
      assertHash(sourceRoot, sourceHash);
      const frozenCases = JSON.stringify(source.cases);
      const inputsPath = join(sourceTestRoot, "inputs.json");
      writeFileSync(inputsPath, frozenCases, { flag: "wx" });
      const sourceOutput = await measure("replay-source-tests", () =>
        executeManifest(
          source,
          "source",
          sourceSandbox,
          inputsPath,
          runtime,
          report.evidence,
          deadlineAt,
          combined,
        ),
      );
      assertHash(sourceRoot, sourceHash);
      if (readTestFile(sourceTestRoot, "inputs.json") !== frozenCases)
        throw new BehaviorFailure(
          "workspace_integrity_violation",
          "workspace-integrity-failed",
          "Source harness modified frozen input cases.",
        );
      let observations;
      try {
        observations = parseObservations(
          sourceOutput,
          source.cases.map((item) => item.caseId),
        );
      } catch (cause) {
        throw new BehaviorFailure(
          "report_evidence_invalid",
          "input-invalid",
          errorText(cause),
        );
      }
      report.sourceSnapshot = {
        schemaVersion: "1.0",
        subjectHash: sourceHash,
        casesHash: hashContent(frozenCases),
        manifest: source,
        observations,
      };
      artifacts.push(
        await persistBehaviorArtifact(
          context,
          "source-behavior-snapshot",
          report.sourceSnapshot,
        ),
      );
      report.cases = observations.map((item) => ({
        caseId: item.caseId,
        caseStatus: "not-executed",
        source: item,
        target: null,
      }));
      report.stage = "waiting-target";
      report.caseStatus = "target-not-ready";
      if (this.options.waitForTarget)
        await measure("wait-target-ready", () =>
          waitForReady(this.options.waitForTarget!, combined),
        );
      combined.throwIfAborted();
      assertHash(sourceRoot, sourceHash);
      const targetHash = projectHash(targetRoot);
      assertDeclaredSnapshot(input, targetRoot, "target");
      report.targetSubjectHash = targetHash;
      report.patchHash = input.translation.patchHash;
      report.stage = "target";
      const targetTestRoot = prepareTestDirectory(targetRoot);
      const targetSandbox = {
        cwd: targetRoot,
        readRoots: [sourceRoot, targetRoot],
        writeRoots: [targetTestRoot],
      };
      const target = await measure("author-target-tests", () =>
        this.author(
          "target",
          input,
          context,
          targetSandbox,
          runtime,
          report,
          artifacts,
          deadlineAt,
          combined,
        ),
      );
      assertHash(sourceRoot, sourceHash);
      assertHash(targetRoot, targetHash);
      const targetInputs = join(targetTestRoot, "inputs.json");
      writeFileSync(targetInputs, frozenCases, { flag: "wx" });
      const targetOutput = await measure("replay-target-tests", () =>
        executeManifest(
          target,
          "target",
          targetSandbox,
          targetInputs,
          runtime,
          report.evidence,
          deadlineAt,
          combined,
        ),
      );
      assertHash(sourceRoot, sourceHash);
      assertHash(targetRoot, targetHash);
      if (readTestFile(targetTestRoot, "inputs.json") !== frozenCases)
        throw new BehaviorFailure(
          "workspace_integrity_violation",
          "workspace-integrity-failed",
          "Target harness modified frozen input cases.",
        );
      let targetObservations;
      try {
        targetObservations = parseObservations(
          targetOutput,
          source.cases.map((item) => item.caseId),
        );
      } catch (cause) {
        throw new BehaviorFailure(
          "report_evidence_invalid",
          "input-invalid",
          errorText(cause),
        );
      }
      report.stage = "comparison";
      report.cases = observations.map((item) => {
        const targetCase = targetObservations.find(
          (other) => other.caseId === item.caseId,
        )!;
        return {
          caseId: item.caseId,
          source: item,
          target: targetCase,
          caseStatus: isDeepStrictEqual(item, targetCase)
            ? "verified-equivalent"
            : "translation-divergence",
        };
      });
      report.caseStatus = report.cases.some(
        (item) => item.caseStatus === "translation-divergence",
      )
        ? "translation-divergence"
        : "verified-equivalent";
      const { testBasis: _testBasis, ...policyFields } = policy;
      assessment = {
        ...policyFields,
        executionStatus: "completed",
        sourceAssessment: "inconclusive",
        targetAssessment:
          report.caseStatus === "translation-divergence"
            ? "bug_found"
            : "no_bug_observed",
        problems: [],
      };
    } catch (cause) {
      const failure = asFailure(cause, combined, report);
      report.caseStatus = failure.caseStatus;
      for (const item of report.cases)
        if (item.target === null) item.caseStatus = failure.caseStatus;
      assessment = failureAssessment(input, failure.code, failure.message);
    }
    const artifact = await persistBehaviorArtifact(
      context,
      "behavior-report",
      report,
    );
    artifacts.push(artifact);
    return {
      ...assessment,
      summary: `${report.stage}: ${report.caseStatus}; ${report.cases.length} recorded cases. Differential evidence only, not a proof of business correctness.`,
      issues: [
        ...report.cases
          .filter((item) => item.caseStatus === "translation-divergence")
          .map((item) => ({
            id: `behavior-${item.caseId}`,
            kind: "behavioral-divergence",
            caseId: item.caseId,
            message:
              "Target observation differs from the accepted source record. Return this evidence to the upstream translator; no repair was attempted.",
            sourceObservation: parseBehaviorJson(JSON.stringify(item.source)),
            targetObservation: parseBehaviorJson(JSON.stringify(item.target)),
            evidenceArtifactIds: artifacts.map(({ id }) => id),
          })),
        ...assessment.problems.map((problem, index) => ({
          id: `behavior-problem-${index}`,
          kind: problem.code,
          message: problem.message,
          evidenceArtifactIds: [artifact.id],
        })),
      ],
      artifacts,
      strategyReport: parseBehaviorJson(
        JSON.stringify(report),
        10 * 1024 * 1024,
        24,
      ),
    };
  }

  private async author(
    side: BehaviorSide,
    input: VerificationInput,
    context: VerificationStrategyContext,
    sandbox: BehaviorSandbox,
    runtime: BehaviorRuntime,
    report: BehaviorReport,
    artifacts: VerificationArtifact[],
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<BehaviorCollectionManifest | BehaviorTargetManifest> {
    const prompt =
      buildBehaviorPrompt(
        input,
        side,
        side === "target" ? report.sourceSnapshot?.manifest.cases : undefined,
      ) +
      (side === "target"
        ? `\n<source-collection-context>\n${JSON.stringify({ notes: report.sourceSnapshot?.manifest.notes, testFiles: report.sourceSnapshot?.manifest.testFiles, subjectHash: report.sourceSnapshot?.subjectHash, observations: report.sourceSnapshot?.observations })}\n</source-collection-context>`
        : "");
    let partialOutput = "";
    let result;
    try {
      result = await runtime.runAgent({
        side,
        sandbox,
        prompt,
        deadlineAt,
        signal,
        onOutput: (text) => {
          partialOutput = text;
          writeFileSync(
            join(context.workspace.strategyRoot, `${side}-agent-stream.jsonl`),
            text,
            "utf8",
          );
        },
      });
    } catch (cause) {
      artifacts.push(
        await persistBehaviorArtifact(context, `${side}-agent-session`, {
          side,
          prompt,
          stdout: partialOutput,
          error: errorText(cause),
          interrupted: true,
        }),
      );
      throw cause;
    }
    artifacts.push(
      await persistBehaviorArtifact(context, `${side}-agent-session`, {
        side,
        prompt,
        ...result,
      }),
    );
    signal.throwIfAborted();
    if (result.timedOut)
      throw new BehaviorFailure(
        "agent_timeout",
        "timeout",
        `${side} agent timed out.`,
      );
    if (result.exitCode !== 0)
      throw new BehaviorFailure(
        "agent_error",
        `${side}-test-generation-failed`,
        `${side} agent exited with ${result.exitCode}: ${agentFailureSummary(result.stdout, result.stderr)}`,
      );
    try {
      const root = sandbox.writeRoots[0];
      const text = readTestFile(root, "manifest.json");
      const manifest =
        side === "source"
          ? parseCollectionManifest(text)
          : parseTargetManifest(text);
      const files = manifest.testFiles.map((path) => ({
        path,
        content: readTestFile(root, path),
      }));
      artifacts.push(
        await persistBehaviorArtifact(context, `${side}-test-manifest`, {
          manifest,
          files,
        }),
      );
      return manifest;
    } catch (cause) {
      throw new BehaviorFailure(
        "report_schema_invalid",
        `${side}-test-generation-failed`,
        errorText(cause),
      );
    }
  }
}

function agentFailureSummary(stdout: string, stderr: string): string {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const event = parseBehaviorJson(line);
      if (
        event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        event.type === "result"
      ) {
        const errors = Array.isArray(event.errors)
          ? event.errors.filter((item) => typeof item === "string")
          : [];
        return `${event.subtype ?? "agent_error"}: ${errors.join("; ") || event.result || "No result"}`.slice(
          0,
          2000,
        );
      }
    } catch {
      /* Ignore incomplete diagnostic lines; never use them as behavior evidence. */
    }
  }
  return stderr.slice(-2000);
}

function assertEligibility(input: VerificationInput): void {
  const analysis = input.analysisReport;
  const eligibility =
    analysis && typeof analysis === "object" && !Array.isArray(analysis)
      ? analysis.migrationEligibility
      : null;
  if (
    !eligibility ||
    typeof eligibility !== "object" ||
    Array.isArray(eligibility) ||
    eligibility.decision !== "eligible"
  )
    throw new BehaviorFailure(
      "context_incomplete",
      "not-executed",
      "An explicit upstream migrationEligibility.decision=eligible is required. No agent was started.",
    );
  const policy = resolveVerificationPolicy(input);
  if (policy.referenceDecision !== "accepted" || !policy.testBasis?.trim())
    throw new BehaviorFailure(
      "insufficient_test_basis",
      "not-executed",
      "An accepted reference and explicit test basis are required. This strategy does not perform target-only validation.",
    );
}
function assertHash(root: string, expected: string): void {
  if (projectHash(root) !== expected)
    throw new BehaviorFailure(
      "workspace_integrity_violation",
      "workspace-integrity-failed",
      "An implementation snapshot changed during verification.",
    );
}
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
function asFailure(
  cause: unknown,
  signal: AbortSignal,
  report: BehaviorReport,
): BehaviorFailure {
  if (signal.aborted) {
    const timedOut =
      signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    return new BehaviorFailure(
      timedOut ? "agent_timeout" : "cancelled",
      timedOut
        ? report.stage === "waiting-target"
          ? "target-not-ready"
          : "timeout"
        : "not-executed",
      timedOut ? "Verification deadline exceeded." : "Verification cancelled.",
    );
  }
  return cause instanceof BehaviorFailure
    ? cause
    : new BehaviorFailure(
        "environment_unavailable",
        "environment-unverified",
        errorText(cause),
      );
}
async function waitForReady(
  wait: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    await Promise.race([
      Promise.resolve().then(() => wait(signal)),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function executeManifest(
  manifest: BehaviorTargetManifest,
  side: BehaviorSide,
  sandbox: BehaviorSandbox,
  inputsPath: string,
  runtime: BehaviorRuntime,
  evidence: BehaviorExecutionEvidence[],
  deadlineAt: number,
  signal: AbortSignal,
): Promise<string> {
  const commands = [
    ...manifest.commands.setup,
    {
      ...manifest.commands.run,
      args: [...manifest.commands.run.args, inputsPath],
    },
  ];
  const testRoot = sandbox.writeRoots[0];
  const frozenPaths = [
    ...new Set([...manifest.testFiles, "manifest.json", "inputs.json"]),
  ];
  const frozen = frozenPaths.map((path) => ({
    path,
    content: readTestFile(testRoot, path),
  }));
  const executionSandbox = {
    ...sandbox,
    readOnlyFiles: frozenPaths.map((path) =>
      realpathSync(join(testRoot, path)),
    ),
  };
  let stdout = "";
  for (const [index, command] of commands.entries()) {
    signal.throwIfAborted();
    const result = await runtime.runCommand({
      command,
      sandbox: executionSandbox,
      deadlineAt,
      signal,
    });
    for (const file of frozen) {
      if (readTestFile(testRoot, file.path) !== file.content)
        throw new BehaviorFailure(
          "workspace_integrity_violation",
          "workspace-integrity-failed",
          `Frozen test artifact changed: ${file.path}`,
        );
    }
    evidence.push({
      commandId: `${side}-${index + 1}`,
      side,
      phase: index === commands.length - 1 ? "run" : "setup",
      command,
      cwd: sandbox.cwd,
      ...result,
    });
    if (result.timedOut)
      throw new BehaviorFailure(
        "command_timeout",
        "timeout",
        `${side} command timed out.`,
      );
    if (result.exitCode !== 0)
      throw new BehaviorFailure(
        "environment_unavailable",
        "command-failed",
        `${side} command exited with ${result.exitCode}: ${result.stderr.slice(-2000)}`,
      );
    stdout = result.stdout;
  }
  return stdout;
}
export function createMultiAgentDifferentialProvider(
  options: MultiAgentDifferentialOptions = {},
): VerificationStrategyProvider {
  return {
    descriptor: MULTI_AGENT_DIFFERENTIAL_STRATEGY,
    create: () => new MultiAgentDifferentialStrategy(options),
  };
}
