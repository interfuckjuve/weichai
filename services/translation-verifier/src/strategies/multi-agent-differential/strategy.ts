import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  BehaviorCaseStatus,
  BehaviorCollectionManifest,
  BehaviorExecutionEvidence,
  BehaviorReport,
  BehaviorRuntime,
  BehaviorSide,
  BehaviorTargetManifest,
  BehaviorExecutionScope,
  ReuseClassification,
  BehaviorAgentResult,
  BehaviorCommandRecord,
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
  captureProjectBaseline,
  assertProjectBaseline,
  type BehaviorProjectBaseline,
  TEST_DIRECTORY,
  readTestFile,
  isProjectTestPath,
} from "./behavior-workspace.js";
import { createBehaviorRuntime } from "./claude-runtime.js";
import { protectedSecrets, redact } from "./behavior-command.js";

export const MULTI_AGENT_DIFFERENTIAL_STRATEGY: VerificationStrategyDescriptor =
  {
    id: "multi-agent-differential",
    version: "3.0.0",
    displayName: "Multi-Agent Differential",
  };
export interface MultiAgentDifferentialOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
  effort?: string;
  runtime?: BehaviorRuntime;
  /** Trusted caller authorization, separate from reference suitability. */
  executionSides?: BehaviorSide[];
  /** Read-only readiness notification for an already-prepared target, not a preparation job.
   * Must not write project files, launch processes, or own resources. The caller joins
   * all preparation before verify(); cancellation may stop waiting for this notification.
   */
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
      schemaVersion: "3.0",
      stage: "eligibility",
      caseStatus: "not-executed",
      cases: [],
      evidence: [],
      repairs: [],
      limitations,
    };
    const artifacts: VerificationArtifact[] = [];
    const measure =
      context.measureStep ??
      (async <T>(_name: string, fn: () => T | Promise<T>) => fn());
    const runtime = this.options.runtime ?? createBehaviorRuntime(this.options);
    let assessment: VerificationAssessment = {
      mode: "target_only",
      referenceDecision: "undetermined",
      referenceReason: "No validated test basis is available.",
      executionStatus: "failed",
      sourceAssessment: "not_checked",
      targetAssessment: "inconclusive",
      problems: [],
    };
    try {
      combined.throwIfAborted();
      report.classification = classifyReuse(input);
      const allowed = this.options.executionSides ?? ["source", "target"];
      if (
        !allowed.includes("target") ||
        (report.classification === "direct" && !allowed.includes("source"))
      )
        throw new BehaviorFailure(
          "context_incomplete",
          "not-executed",
          "Required execution side is not authorized.",
        );
      assertProjectRoots(context);
      const sourceRoot = context.workspace.sourceRoot;
      const targetRoot = context.workspace.targetRoot;
      const sourceBaseline = captureProjectBaseline(sourceRoot);
      const initialTargetBaseline = captureProjectBaseline(targetRoot);
      assertDeclaredSnapshot(input, sourceRoot, "source");
      assertDeclaredSnapshot(input, targetRoot, "target");
      report.stage = "source";
      const sourceTestRoot = prepareTestDirectory(sourceRoot);
      const sourceSandbox = {
        cwd: sourceRoot,
        readRoots: [sourceRoot, targetRoot],
        writeRoots: [sourceTestRoot, sourceRoot],
        baseline: sourceBaseline,
      };
      const collected = await measure("collect-and-replay-source", () =>
        this.authorAndReplay(
          "source",
          input,
          context,
          sourceSandbox,
          runtime,
          report,
          artifacts,
          deadlineAt,
          combined,
          () => {
            assertHash(sourceBaseline);
            assertDeclaredSnapshot(input, sourceRoot, "source");
          },
        ),
      );
      const source = collected.manifest as BehaviorCollectionManifest;
      const observations = collected.observations;
      const hasSource = observations.length > 0;
      assessment = {
        ...assessment,
        mode: hasSource ? "differential" : "target_only",
        referenceDecision: hasSource ? "accepted" : "rejected",
        referenceReason: `Analyzer ${report.classification}; frozen cases use ${hasSource ? "replayed source observations and case-specific expectations" : "requirement-derived expectations only"}.`,
        sourceAssessment: hasSource ? "inconclusive" : "not_checked",
      };
      assertTargetTransition(
        initialTargetBaseline,
        captureProjectBaseline(targetRoot),
        new Set(),
      );
      const handoffFiles = [
        ".forexplore-tests/manifest.json",
        ".forexplore-tests/inputs.json",
        ...source.testFiles,
      ].map((path) => ({ path, content: readTestFile(sourceRoot, path) }));
      const sourceHandoffBaseline = captureProjectBaseline(sourceRoot);
      const checkHandoff = () => {
        assertHash(sourceHandoffBaseline);
        for (const file of handoffFiles)
          if (readTestFile(sourceRoot, file.path) !== file.content)
            throw new BehaviorFailure(
              "workspace_integrity_violation",
              "workspace-integrity-failed",
              "Frozen Agent1 handoff changed.",
            );
      };
      const frozenCases = JSON.stringify(source.cases);
      report.sourceSnapshot = {
        schemaVersion: "3.0",
        subjectHash: sourceBaseline.hash,
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
      report.cases = source.cases.map((item) => ({
        caseId: item.caseId,
        caseStatus: "not-executed",
        expectation: item.expectation,
        source: observations.find((row) => row.caseId === item.caseId) ?? null,
        target: null,
      }));
      report.stage = "waiting-target";
      report.caseStatus = "target-not-ready";
      if (this.options.waitForTarget)
        await measure("wait-target-ready", () =>
          waitForReady(this.options.waitForTarget!, combined),
        );
      combined.throwIfAborted();
      checkHandoff();
      const targetBaseline = captureProjectBaseline(targetRoot);
      assertTargetTransition(initialTargetBaseline, targetBaseline, new Set());
      assertDeclaredSnapshot(input, targetRoot, "target");
      report.targetSubjectHash = targetBaseline.hash;
      report.patchHash = input.translation.patchHash;
      report.stage = "target";
      const targetTestRoot = prepareTestDirectory(targetRoot);
      const targetSandbox = {
        cwd: targetRoot,
        readRoots: [sourceRoot, targetRoot],
        writeRoots: [targetTestRoot, targetRoot],
        baseline: targetBaseline,
      };
      const verified = await measure("author-and-replay-target", () =>
        this.authorAndReplay(
          "target",
          input,
          context,
          targetSandbox,
          runtime,
          report,
          artifacts,
          deadlineAt,
          combined,
          () => {
            checkHandoff();
            assertHash(targetBaseline);
            assertDeclaredSnapshot(input, sourceRoot, "source");
            assertDeclaredSnapshot(input, targetRoot, "target");
          },
        ),
      );
      const targetObservations = verified.observations;
      report.stage = "comparison";
      report.cases = source.cases.map((item) => {
        const sourceCase =
          observations.find((row) => row.caseId === item.caseId) ?? null;
        const targetCase = targetObservations.find(
          (row) => row.caseId === item.caseId,
        )!;
        const expected =
          item.expectation.kind === "requirement"
            ? item.expectation.expected
            : sourceCase!;
        return {
          caseId: item.caseId,
          expectation: item.expectation,
          expected,
          source: sourceCase,
          target: targetCase,
          caseStatus: !isDeepStrictEqual(expected, targetCase)
            ? "translation-divergence"
            : item.expectation.kind === "source"
              ? "verified-equivalent"
              : "requirement-satisfied",
        };
      });
      report.caseStatus = report.cases.some(
        (item) => item.caseStatus === "translation-divergence",
      )
        ? "translation-divergence"
        : report.cases.some(
              (item) => item.caseStatus === "requirement-satisfied",
            )
          ? "requirement-satisfied"
          : "verified-equivalent";
      assessment = {
        ...assessment,
        executionStatus: "completed",
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
      assessment = {
        ...assessment,
        executionStatus: failure.code === "cancelled" ? "cancelled" : "failed",
        targetAssessment: "inconclusive",
        problems: [{ code: failure.code, message: failure.message }],
      };
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
              "Target observation differs from the frozen case-specific expectation. Return this evidence to the upstream translator; no repair was attempted.",
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

  private async authorAndReplay(
    side: BehaviorSide,
    input: VerificationInput,
    context: VerificationStrategyContext,
    sandbox: BehaviorExecutionScope,
    runtime: BehaviorRuntime,
    report: BehaviorReport,
    artifacts: VerificationArtifact[],
    deadlineAt: number,
    signal: AbortSignal,
    checkIntegrity: () => void,
  ) {
    const inputsPath = join(sandbox.cwd, TEST_DIRECTORY, "inputs.json");
    let cases =
      side === "target" ? report.sourceSnapshot!.manifest.cases : undefined;
    let frozenCases = cases ? JSON.stringify(cases) : undefined;
    if (frozenCases !== undefined)
      writeFileSync(inputsPath, frozenCases, { flag: "wx" });
    let feedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      try {
        const authorScope = {
          ...sandbox,
          readOnlyFiles:
            frozenCases === undefined ? [] : [realpathSync(inputsPath)],
        };
        const manifest = await this.author(
          side,
          input,
          context,
          authorScope,
          runtime,
          report,
          artifacts,
          deadlineAt,
          signal,
          attempt,
          feedback,
        );
        checkIntegrity();
        if (side === "source") {
          const collectedCases = (manifest as BehaviorCollectionManifest).cases;
          if (
            collectedCases.some(
              (item) => item.expectation.kind === "unresolved",
            )
          )
            throw new BehaviorFailure(
              "insufficient_test_basis",
              "not-executed",
              "Required case expectations remain unresolved.",
            );
          const hasSource = collectedCases.some(
            (item) => item.expectation.kind === "source",
          );
          if (
            (report.classification === "direct" &&
              collectedCases.some(
                (item) => item.expectation.kind !== "source",
              )) ||
            (report.classification === "not_applicable" && hasSource)
          )
            throw new BehaviorFailure(
              "insufficient_test_basis",
              "not-executed",
              "Case expectation basis contradicts the selected reuse classification.",
            );
          if (!hasSource && report.sourceExecuted)
            throw new BehaviorFailure(
              "report_evidence_invalid",
              "input-invalid",
              "Design-only collection cannot hide source execution.",
            );
          if (
            hasSource &&
            !(this.options.executionSides ?? ["source", "target"]).includes(
              "source",
            )
          )
            throw new BehaviorFailure(
              "context_incomplete",
              "not-executed",
              "Source replay is not authorized.",
            );
          if (
            frozenCases !== undefined &&
            JSON.stringify(collectedCases) !== frozenCases
          )
            throw new BehaviorFailure(
              "workspace_integrity_violation",
              "workspace-integrity-failed",
              "A harness repair changed frozen source cases.",
            );
          cases = collectedCases;
        }
        if (frozenCases === undefined) {
          frozenCases = JSON.stringify(cases!);
          writeFileSync(inputsPath, frozenCases, { flag: "wx" });
        }
        if (
          readTestFile(sandbox.cwd, `${TEST_DIRECTORY}/inputs.json`) !==
          frozenCases
        )
          throw new BehaviorFailure(
            "workspace_integrity_violation",
            "workspace-integrity-failed",
            "Frozen inputs changed.",
          );
        const replayCases =
          side === "source"
            ? cases!.filter((item) => item.expectation.kind === "source")
            : cases!;
        if (!replayCases.length) return { manifest, observations: [] };
        if (side === "source") report.sourceExecuted = true;
        const stdout = await executeManifest(
          manifest,
          side,
          sandbox,
          inputsPath,
          runtime,
          report.evidence,
          deadlineAt,
          signal,
          attempt,
          protectedSecrets(this.options.apiKey ?? process.env.DEEPSEEK_API_KEY),
        );
        checkIntegrity();
        try {
          return {
            manifest,
            observations: parseObservations(
              stdout,
              replayCases.map((item) => item.caseId),
            ),
          };
        } catch (cause) {
          throw new BehaviorFailure(
            "report_evidence_invalid",
            "input-invalid",
            errorText(cause),
          );
        }
      } catch (cause) {
        checkIntegrity();
        if (
          frozenCases !== undefined &&
          existsSync(inputsPath) &&
          readTestFile(sandbox.cwd, `${TEST_DIRECTORY}/inputs.json`) !==
            frozenCases
        )
          throw new BehaviorFailure(
            "workspace_integrity_violation",
            "workspace-integrity-failed",
            "Frozen inputs changed.",
          );
        if (
          attempt !== 0 ||
          signal.aborted ||
          !(cause instanceof BehaviorFailure) ||
          !["report_schema_invalid", "report_evidence_invalid"].includes(
            cause.code,
          )
        )
          throw cause;
        feedback = `Host rejected your test harness: ${cause.message}. Fix only your newly generated tests/manifest, never the implementation or frozen inputs. Run the existing inputs through your harness and validate stdout with a JSON parser before finishing. Prior Host execution evidence: ${JSON.stringify(report.evidence.filter((item) => item.side === side).map(({ command, exitCode, stdout, stderr }) => ({ command, exitCode, stdout, stderr }))).slice(0, 16000)}`;
        report.repairs.push({ side, attempt: 1, reason: cause.message });
      }
    }
    throw new Error("Unreachable harness attempt limit.");
  }

  private async author(
    side: BehaviorSide,
    input: VerificationInput,
    context: VerificationStrategyContext,
    sandbox: BehaviorExecutionScope,
    runtime: BehaviorRuntime,
    report: BehaviorReport,
    artifacts: VerificationArtifact[],
    deadlineAt: number,
    signal: AbortSignal,
    attempt = 0,
    feedback = "",
  ): Promise<BehaviorCollectionManifest | BehaviorTargetManifest> {
    const prompt =
      buildBehaviorPrompt(
        input,
        side,
        side === "target" ? report.sourceSnapshot?.manifest.cases : undefined,
        report.classification,
      ) +
      (side === "target"
        ? `\n<source-collection-context>\n${JSON.stringify({ notes: report.sourceSnapshot?.manifest.notes, testFiles: report.sourceSnapshot?.manifest.testFiles, subjectHash: report.sourceSnapshot?.subjectHash, observations: report.sourceSnapshot?.observations })}\n</source-collection-context>`
        : "") +
      (feedback
        ? `\n<host-repair-feedback>\n${feedback}\n</host-repair-feedback>`
        : "");
    const sessionId = `${side}-agent${attempt ? `-repair-${attempt}` : ""}`;
    let partialOutput = "";
    let result: BehaviorAgentResult | undefined;
    let commandEvidence: BehaviorCommandRecord[] = [];
    let sessionError: string | undefined;
    try {
      result = await runtime.runAgent({
        side,
        sandbox,
        executionSides:
          side === "source"
            ? report.classification === "not_applicable"
              ? []
              : (this.options.executionSides ?? ["source", "target"]).filter(
                  (value) => value === "source",
                )
            : ["target"],
        onEvidence: (records) => {
          commandEvidence = records;
          if (records.some((record) => record.side === "source"))
            report.sourceExecuted = true;
        },
        prompt,
        deadlineAt,
        signal,
        onOutput: (text) => {
          partialOutput = text;
          writeFileSync(
            join(context.workspace.strategyRoot, `${sessionId}-stream.jsonl`),
            text,
            "utf8",
          );
        },
      });
      commandEvidence = result.commandEvidence ?? commandEvidence;
    } catch (cause) {
      sessionError = errorText(cause);
      throw cause;
    } finally {
      artifacts.push(
        await persistBehaviorArtifact(context, `${sessionId}-session`, {
          side,
          prompt,
          ...(result ?? {
            stdout: partialOutput,
            error: sessionError,
            interrupted: true,
          }),
          commandEvidence,
        }),
      );
    }
    if (commandEvidence.some((record) => record.side === "source"))
      report.sourceExecuted = true;
    if (
      side === "source" &&
      report.classification === "not_applicable" &&
      commandEvidence.length
    )
      throw new BehaviorFailure(
        "report_evidence_invalid",
        "input-invalid",
        "Design-only Agent1 executed a command.",
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
      const files = manifest.testFiles.map((path) => {
        if (
          !isProjectTestPath(path) ||
          Object.hasOwn(sandbox.baseline?.files ?? {}, path) ||
          [
            ".forexplore-tests/manifest.json",
            ".forexplore-tests/inputs.json",
          ].includes(path)
        )
          throw new Error(
            "Manifest must identify newly authored project test files.",
          );
        return { path, content: readTestFile(sandbox.cwd, path) };
      });
      artifacts.push(
        await persistBehaviorArtifact(
          context,
          `${side}-test-manifest${attempt ? `-repair-${attempt}` : ""}`,
          {
            manifest,
            files,
          },
        ),
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

function classifyReuse(input: VerificationInput): ReuseClassification {
  const report = input.analysisReport;
  const applicability =
    report && typeof report === "object" && !Array.isArray(report)
      ? report.applicability
      : undefined;
  const level =
    applicability &&
    typeof applicability === "object" &&
    !Array.isArray(applicability)
      ? applicability.level
      : undefined;
  if (level === "direct" || level === "adapt") return level;
  if (level === "reference" || level === "reject") return "not_applicable";
  throw new BehaviorFailure(
    "context_incomplete",
    "not-executed",
    "An explicit analysisReport.applicability.level of direct, adapt, reference, or reject is required. No agent was started.",
  );
}
function assertTargetTransition(
  before: BehaviorProjectBaseline,
  after: BehaviorProjectBaseline,
  patchPaths: Set<string>,
): void {
  for (const path of new Set([
    ...Object.keys(before.files),
    ...Object.keys(after.files),
  ])) {
    if (!patchPaths.has(path) && before.files[path] !== after.files[path])
      throw new BehaviorFailure(
        "workspace_integrity_violation",
        "workspace-integrity-failed",
        `Target readiness contains an unauthorized change: ${path}`,
      );
  }
}

function assertHash(baseline: BehaviorProjectBaseline): void {
  try {
    assertProjectBaseline(baseline);
  } catch (cause) {
    throw new BehaviorFailure(
      "workspace_integrity_violation",
      "workspace-integrity-failed",
      errorText(cause),
    );
  }
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
  manifest: BehaviorTargetManifest | BehaviorCollectionManifest,
  side: BehaviorSide,
  sandbox: BehaviorExecutionScope,
  inputsPath: string,
  runtime: BehaviorRuntime,
  evidence: BehaviorExecutionEvidence[],
  deadlineAt: number,
  signal: AbortSignal,
  attempt = 0,
  secrets = protectedSecrets(),
): Promise<string> {
  if (!manifest.commands)
    throw new BehaviorFailure(
      "insufficient_test_basis",
      "not-executed",
      "Missing executable test commands.",
    );
  const commands = [
    ...manifest.commands.setup,
    {
      ...manifest.commands.run,
      args: [...manifest.commands.run.args, inputsPath],
    },
  ];
  const testRoot = sandbox.cwd;
  const frozenPaths = [
    ...new Set([
      ...manifest.testFiles,
      `${TEST_DIRECTORY}/manifest.json`,
      `${TEST_DIRECTORY}/inputs.json`,
    ]),
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
    if (
      index === commands.length - 1 &&
      manifest.resultFile &&
      existsSync(join(sandbox.cwd, manifest.resultFile))
    ) {
      readTestFile(sandbox.cwd, manifest.resultFile);
      rmSync(join(sandbox.cwd, manifest.resultFile));
    }
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
      commandId: `${side}-${attempt}-${index + 1}`,
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
  if (manifest.resultFile) {
    try {
      stdout = readTestFile(sandbox.cwd, manifest.resultFile);
      if (redact(stdout, secrets) !== stdout)
        throw new Error(
          "Protected credential material in result file; comparison refused.",
        );
      Object.assign(evidence.at(-1)!, {
        resultFile: manifest.resultFile,
        resultText: stdout,
      });
    } catch (cause) {
      throw new BehaviorFailure(
        "report_evidence_invalid",
        "input-invalid",
        `Invalid or missing result file: ${errorText(cause)}`,
      );
    }
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
