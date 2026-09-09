import { existsSync, lstatSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  VerificationPreparation,
  VerificationPreparationInput,
  VerificationInput,
  VerificationStrategyContext,
  VerificationStrategyDescriptor,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
  VerificationArtifact,
  TwoPhaseVerificationStrategy,
} from "../../schemas/verification-types.js";
import type {
  BehaviorAgentTask,
  BehaviorRuntime,
  BehaviorReport,
  BehaviorSourceSnapshot,
  BehaviorTargetManifest,
  BehaviorCaseResult,
  BehaviorExecutionScope,
  BehaviorCommandRecord,
} from "../multi-agent-differential/behavior-types.js";
import {
  MultiAgentDifferentialStrategy,
  BehaviorFailure,
  classifyReuse,
  executeManifest,
  type MultiAgentDifferentialOptions,
} from "../multi-agent-differential/strategy.js";
import { createBehaviorRuntime } from "../multi-agent-differential/claude-runtime.js";
import {
  assertProjectRoots,
  assertProjectBaseline,
  assertDeclaredSnapshot,
  captureProjectBaseline,
  hashContent,
  isProjectTestPath,
  persistBehaviorArtifact,
  prepareTestDirectory,
  readTestFile,
  TEST_DIRECTORY,
  type BehaviorProjectBaseline,
} from "../multi-agent-differential/behavior-workspace.js";
import {
  assertPreparation,
  assertSourceSnapshot,
  assertUntranslatedTarget,
  createPreparation,
  capturePreparationFiles,
  restorePreparationFiles,
  type FrozenPreparationFile,
} from "../multi-agent-differential/preparation.js";
import {
  parseBehaviorJson,
  parseCollectionManifest,
  parseObservations,
  parseTargetManifest,
} from "../multi-agent-differential/behavior-schema.js";
import {
  protectedSecrets,
  redact,
} from "../multi-agent-differential/behavior-command.js";
import { preparationPrompt, diagnosisPrompt } from "./prompt.js";

export const MULTI_AGENT_BLACK_BOX_STRATEGY: VerificationStrategyDescriptor = {
  id: "multi-agent-black-box",
  version: "1.0.0",
  displayName: "Multi-Agent Black Box",
};
export type MultiAgentBlackBoxOptions = MultiAgentDifferentialOptions;
interface BlackBoxPreparation {
  kind: "black-box";
  classification: "direct" | "adapt";
  sourceSnapshot: BehaviorSourceSnapshot;
  sourceChanges: {
    path: string;
    originalHash: string | null;
    content: string | null;
  }[];
  targetBaseline: BehaviorProjectBaseline;
  targetModes: Record<string, number>;
  agent1Evidence: unknown;
  targetManifest: BehaviorTargetManifest;
  targetFiles: FrozenPreparationFile[];
  report: BehaviorReport;
}
const limitations = [
  "Tests were authored before translated implementation access. Agent2 diagnosis may inspect implementation; this is not an entirely black-box workflow.",
  "Source experiments are mutable. Their outputs are exploratory, not original source observations or independent proof of requirement correctness.",
  "Host replay binds actual observations to frozen cases, but does not prove generated test adequacy or oracle correctness. Workflow permissions are not OS isolation.",
  "Upstream parallel scheduling is not integrated. These independent entry points permit, but do not establish, actual Translator overlap. No translation repair is performed.",
];

export class MultiAgentBlackBoxStrategy implements TwoPhaseVerificationStrategy {
  constructor(private readonly options: MultiAgentBlackBoxOptions = {}) {}

  async prepareTests(
    input: VerificationPreparationInput,
    context: VerificationStrategyContext,
    signal?: AbortSignal,
  ): Promise<VerificationPreparation> {
    input = structuredClone({
      request: input.request,
      analysisReport: input.analysisReport,
      migrationPlan: input.migrationPlan,
    });
    const bounded = this.deadline(context, signal);
    bounded.signal.throwIfAborted();
    const classification = classifyReuse(input);
    if (classification === "not_applicable") {
      const preparation = createPreparation(
        MULTI_AGENT_BLACK_BOX_STRATEGY,
        input,
        { kind: "skipped" },
      );
      await persistBehaviorArtifact(
        context,
        "black-box-preparation",
        preparation,
      );
      return preparation;
    }
    assertProjectRoots(context);
    const { sourceRoot, targetRoot } = context.workspace;
    assertSourceSnapshot(input, sourceRoot);
    assertUntranslatedTarget(input, targetRoot);
    const sourceBaseline = captureProjectBaseline(sourceRoot);
    const targetBaseline = captureProjectBaseline(targetRoot);
    const sourceTests = prepareTestDirectory(sourceRoot);
    const targetTests = prepareTestDirectory(targetRoot);
    const report = newReport(classification);
    const runtime = this.options.runtime ?? createBehaviorRuntime(this.options);
    const artifacts: VerificationArtifact[] = [];
    const sourceScope: BehaviorExecutionScope = {
      cwd: sourceRoot,
      readRoots: [sourceRoot, targetRoot],
      writeRoots: [sourceTests, sourceRoot],
      baseline: sourceBaseline,
      projectAccess: "experiment",
    };
    const targetScope: BehaviorExecutionScope = {
      cwd: targetRoot,
      readRoots: [targetRoot],
      writeRoots: [targetTests, targetRoot],
      baseline: targetBaseline,
    };
    try {
      if (
        !(this.options.executionSides ?? ["source", "target"]).includes(
          "target",
        )
      )
        throw new BehaviorFailure(
          "context_incomplete",
          "not-executed",
          "Target execution is not authorized.",
        );
      const agent1Evidence = await this.session(
        runtime,
        {
          side: "source",
          sandbox: sourceScope,
          additionalProjects: { target: targetScope },
          executionSides: (
            this.options.executionSides ?? ["source", "target"]
          ).filter((side) => side === "source"),
          prompt: preparationPrompt(input, context.workspace),
          ...bounded,
        },
        context,
        "black-box-agent1",
        artifacts,
      );
      assertProjectBaseline(targetBaseline);
      assertUntranslatedTarget(input, targetRoot);
      const manifest = parseCollectionManifest(
        readTestFile(sourceRoot, `${TEST_DIRECTORY}/manifest.json`),
      );
      if (manifest.cases.some((item) => item.expectation.kind === "unresolved"))
        throw new BehaviorFailure(
          "insufficient_test_basis",
          "not-executed",
          "Required expectations remain unresolved.",
        );
      const sourceCases = manifest.cases.filter(
        (item) => item.expectation.kind === "source",
      );
      let observations: BehaviorCaseResult[] = [];
      if (sourceCases.length) {
        if (
          !(this.options.executionSides ?? ["source", "target"]).includes(
            "source",
          )
        )
          throw new BehaviorFailure(
            "context_incomplete",
            "not-executed",
            "Source replay is not authorized.",
          );
        // Experiments may change source, but a source oracle must replay the original subject.
        assertProjectBaseline(sourceBaseline);
        assertSourceSnapshot(input, sourceRoot);
        const inputs = join(sourceTests, "inputs.json");
        writeFileSync(inputs, JSON.stringify(manifest.cases), { flag: "wx" });
        const stdout = await executeManifest(
          manifest,
          "source",
          {
            ...sourceScope,
            projectAccess: undefined,
            baseline: captureProjectBaseline(sourceRoot),
          },
          inputs,
          runtime,
          report.evidence,
          bounded.deadlineAt,
          bounded.signal,
        );
        assertProjectBaseline(sourceBaseline);
        observations = parseObservations(
          stdout,
          sourceCases.map((item) => item.caseId),
        );
      }
      assertProjectBaseline(targetBaseline);
      assertUntranslatedTarget(input, targetRoot);
      const sourceAfter = captureProjectBaseline(sourceRoot);
      const sourceChanges = [
        ...new Set([
          ...Object.keys(sourceBaseline.files),
          ...Object.keys(sourceAfter.files),
        ]),
      ]
        .filter(
          (path) => sourceBaseline.files[path] !== sourceAfter.files[path],
        )
        .map((path) => ({
          path,
          originalHash: sourceBaseline.files[path] ?? null,
          content: Object.hasOwn(sourceAfter.files, path)
            ? readTestFile(sourceRoot, path)
            : null,
        }));
      const targetManifest = parseTargetManifest(
        readTestFile(targetRoot, `${TEST_DIRECTORY}/manifest.json`),
      );
      assertNewTests(targetManifest, targetBaseline);
      assertDeclaredNewFiles(
        targetRoot,
        targetBaseline,
        targetManifest.testFiles,
      );
      assertMetadataFiles(targetRoot, targetManifest, false);
      const targetFiles = capturePreparationFiles(targetRoot, [
        `${TEST_DIRECTORY}/manifest.json`,
        ...targetManifest.testFiles,
      ]);
      const sourceSnapshot: BehaviorSourceSnapshot = {
        schemaVersion: "3.0",
        subjectHash: sourceBaseline.hash,
        casesHash: hashContent(JSON.stringify(manifest.cases)),
        manifest,
        observations,
      };
      const targetModes = Object.fromEntries(
        Object.keys(targetBaseline.files).map((path) => [
          path,
          lstatSync(join(targetRoot, path)).mode,
        ]),
      );
      const payload: BlackBoxPreparation = {
        kind: "black-box",
        classification,
        sourceSnapshot,
        sourceChanges,
        targetBaseline,
        targetModes,
        targetManifest,
        targetFiles,
        report,
        agent1Evidence,
      };
      const json = parseBehaviorJson(
        JSON.stringify(payload),
        8 * 1024 * 1024,
        24,
      );
      if (
        redact(JSON.stringify(json), protectedSecrets(this.options.apiKey)) !==
        JSON.stringify(json)
      )
        throw new Error("Preparation contains protected credential material.");
      bounded.signal.throwIfAborted();
      const preparation = createPreparation(
        MULTI_AGENT_BLACK_BOX_STRATEGY,
        input,
        json,
      );
      await persistBehaviorArtifact(
        context,
        "black-box-preparation",
        preparation,
      );
      return preparation;
    } catch (cause) {
      await persistBehaviorArtifact(context, "black-box-preparation-failure", {
        message: errorText(cause),
        report,
      });
      throw cause;
    }
  }

  async verifyTranslation(
    input: VerificationInput,
    context: VerificationStrategyContext,
    preparation?: VerificationPreparation,
    signal?: AbortSignal,
  ): Promise<VerificationStrategyOutput> {
    const bounded = this.deadline(context, signal);
    const report = newReport();
    const artifacts: VerificationArtifact[] = [];
    let sourceChanges: BlackBoxPreparation["sourceChanges"] = [];
    let problem: VerificationStrategyOutput["problems"][number] | undefined;
    let diagnosis: { kind: string; reason: string } | undefined;
    try {
      bounded.signal.throwIfAborted();
      const classification = classifyReuse(input);
      report.classification = classification;
      if (classification === "not_applicable") {
        if (preparation) {
          const payload = assertPreparation(
            preparation,
            MULTI_AGENT_BLACK_BOX_STRATEGY,
            input,
          );
          if (
            !payload ||
            typeof payload !== "object" ||
            Array.isArray(payload) ||
            payload.kind !== "skipped"
          )
            throw new Error(
              "Not-applicable preparation must explicitly skip Agent1.",
            );
        }
        const result = await new MultiAgentDifferentialStrategy(
          this.options,
        ).verifyTranslation(input, context, undefined, bounded.signal);
        return {
          ...result,
          summary: `Target-only branch, not black-box preparation: ${result.summary}`,
        };
      }
      if (
        !(this.options.executionSides ?? ["source", "target"]).includes(
          "target",
        )
      )
        throw new BehaviorFailure(
          "context_incomplete",
          "not-executed",
          "Target execution is not authorized.",
        );
      if (!preparation)
        throw new BehaviorFailure(
          "context_incomplete",
          "not-executed",
          "Pretranslation test preparation is required; Agent1 will not run after translation.",
        );
      const payload = readPreparation(preparation, input);
      sourceChanges = payload.sourceChanges;
      report.sourceSnapshot = payload.sourceSnapshot;
      report.evidence = [...payload.report.evidence];
      report.stage = "target";
      report.patchHash = input.translation.patchHash;
      const { targetRoot } = context.workspace;
      assertProjectRoots(context, false);
      assertDeclaredSnapshot(input, targetRoot, "target");
      assertTranslationTransition(input, payload, targetRoot);
      restorePreparationFiles(targetRoot, payload.targetFiles);
      const inputsPath = join(targetRoot, TEST_DIRECTORY, "inputs.json");
      const casesText = JSON.stringify(payload.sourceSnapshot.manifest.cases);
      if (existsSync(inputsPath)) {
        if (
          readTestFile(targetRoot, `${TEST_DIRECTORY}/inputs.json`) !==
          casesText
        )
          throw new Error("Frozen target inputs changed.");
      } else writeFileSync(inputsPath, casesText, { flag: "wx" });
      artifacts.push(
        await persistBehaviorArtifact(
          context,
          "black-box-handoff",
          preparation,
        ),
      );
      const baseline = captureProjectBaseline(targetRoot);
      report.targetSubjectHash = baseline.hash;
      // Only Agent1's declared generated tests may be repaired; translated files stay protected.
      for (const file of payload.targetManifest.testFiles)
        delete baseline.files[file];
      const scope: BehaviorExecutionScope = {
        cwd: targetRoot,
        readRoots: [targetRoot],
        writeRoots: [join(targetRoot, TEST_DIRECTORY), targetRoot],
        baseline,
        readOnlyFiles: [
          inputsPath,
          join(targetRoot, TEST_DIRECTORY, "manifest.json"),
        ],
      };
      const frozenMetadata = capturePreparationFiles(targetRoot, [
        `${TEST_DIRECTORY}/inputs.json`,
        `${TEST_DIRECTORY}/manifest.json`,
      ]);
      let diagnosticStarted = false;
      const runtime =
        this.options.runtime ?? createBehaviorRuntime(this.options);
      const check = () => {
        assertProjectBaseline(baseline);
        assertDeclaredSnapshot(input, targetRoot, "target");
        assertDeclaredNewFiles(
          targetRoot,
          baseline,
          payload.targetManifest.testFiles,
        );
        assertMetadataFiles(
          targetRoot,
          payload.targetManifest,
          true,
          diagnosticStarted,
        );
        assertFrozenFiles(targetRoot, frozenMetadata);
        if (
          readTestFile(targetRoot, `${TEST_DIRECTORY}/inputs.json`) !==
            casesText ||
          readTestFile(targetRoot, `${TEST_DIRECTORY}/manifest.json`) !==
            payload.targetFiles.find(
              (file) => file.path === `${TEST_DIRECTORY}/manifest.json`,
            )!.content
        )
          throw new BehaviorFailure(
            "workspace_integrity_violation",
            "workspace-integrity-failed",
            "Frozen cases or manifest changed.",
          );
      };
      const replay = async (attempt: number) => {
        check();
        const stdout = await executeManifest(
          payload.targetManifest,
          "target",
          scope,
          inputsPath,
          runtime,
          report.evidence,
          bounded.deadlineAt,
          bounded.signal,
          attempt,
        );
        check();
        const observations = parseObservations(
          stdout,
          payload.sourceSnapshot.manifest.cases.map((item) => item.caseId),
        );
        report.cases = compare(payload.sourceSnapshot, observations);
      };
      let firstFailure: unknown;
      try {
        await replay(0);
      } catch (cause) {
        check();
        firstFailure = cause;
      }
      if (
        firstFailure ||
        report.cases.some(
          (item) => item.caseStatus === "translation-divergence",
        )
      ) {
        bounded.signal.throwIfAborted();
        if (
          firstFailure instanceof BehaviorFailure &&
          [
            "workspace_integrity_violation",
            "command_timeout",
            "agent_timeout",
          ].includes(firstFailure.code)
        )
          throw firstFailure;
        const beforeDiagnosis = capturePreparationFiles(
          targetRoot,
          payload.targetManifest.testFiles,
        );
        diagnosticStarted = true;
        await this.session(
          runtime,
          {
            side: "target",
            sandbox: scope,
            executionSides: ["target"],
            ...bounded,
            prompt: diagnosisPrompt({
              failure: firstFailure ? errorText(firstFailure) : null,
              cases: report.cases,
              evidence: report.evidence,
            }, targetRoot),
          },
          context,
          "black-box-agent2",
          artifacts,
        );
        check();
        diagnosis = readDiagnosis(targetRoot);
        if (diagnosis.kind === "harness") {
          report.repairs.push({
            side: "target",
            attempt: 1,
            reason: diagnosis.reason,
          });
          artifacts.push(
            await persistBehaviorArtifact(context, "black-box-test-repair", {
              before: beforeDiagnosis,
              after: capturePreparationFiles(
                targetRoot,
                payload.targetManifest.testFiles,
              ),
              diagnosis,
            }),
          );
          await replay(1);
        } else {
          assertFrozenFiles(targetRoot, beforeDiagnosis);
          if (firstFailure) throw firstFailure;
          if (diagnosis.kind === "inconclusive")
            throw new BehaviorFailure(
              "insufficient_test_basis",
              "not-executed",
              diagnosis.reason,
            );
        }
      }
      check();
      bounded.signal.throwIfAborted();
      report.stage = "comparison";
      report.caseStatus = report.cases.some(
        (item) => item.caseStatus === "translation-divergence",
      )
        ? "translation-divergence"
        : report.cases.some((item) => item.expectation?.kind === "source")
          ? "verified-equivalent"
          : "requirement-satisfied";
    } catch (cause) {
      const interrupted = bounded.signal.aborted;
      const timeout =
        interrupted &&
        bounded.signal.reason instanceof Error &&
        bounded.signal.reason.name === "TimeoutError";
      problem = {
        code: interrupted
          ? timeout
            ? "agent_timeout"
            : "cancelled"
          : cause instanceof BehaviorFailure
            ? cause.code
            : "workspace_integrity_violation",
        message: errorText(cause),
      };
      report.caseStatus = interrupted
        ? "timeout"
        : cause instanceof BehaviorFailure
          ? cause.caseStatus
          : "workspace-integrity-failed";
    }
    const sourceUsed = !!report.sourceSnapshot?.observations.length;
    const artifact = await persistBehaviorArtifact(
      context,
      "black-box-report",
      { ...report, sourceChanges, diagnosis: diagnosis ?? null },
    );
    artifacts.push(artifact);
    return {
      mode: sourceUsed ? "differential" : "target_only",
      referenceDecision: sourceUsed ? "accepted" : "rejected",
      referenceReason: sourceUsed
        ? "Frozen expectations include original-source Host replay observations."
        : "Requirement-derived expectations, not experimental source outputs.",
      executionStatus: problem
        ? problem.code === "cancelled"
          ? "cancelled"
          : "failed"
        : "completed",
      sourceAssessment: sourceUsed ? "inconclusive" : "not_checked",
      targetAssessment: problem
        ? "inconclusive"
        : report.caseStatus === "translation-divergence"
          ? "bug_found"
          : "no_bug_observed",
      problems: problem ? [problem] : [],
      summary: `${report.stage}: ${report.caseStatus}; ${report.cases.length} black-box cases. No proof of business correctness.`,
      issues: problem
        ? []
        : report.cases
            .filter((item) => item.caseStatus === "translation-divergence")
            .map((item) => ({
              id: `black-box-${item.caseId}`,
              kind: "behavioral-divergence",
              caseId: item.caseId,
              message:
                "Target observation differs from the frozen expectation. Return evidence to the upstream Translator.",
              evidenceArtifactIds: [artifact.id],
            })),
      artifacts,
      strategyReport: parseBehaviorJson(
        JSON.stringify({
          ...report,
          sourceChanges,
          diagnosis: diagnosis ?? null,
        }),
        10 * 1024 * 1024,
        24,
      ),
    };
  }

  private deadline(context: VerificationStrategyContext, signal?: AbortSignal) {
    const deadlineAt = Math.min(
      context.deadlineAt,
      Date.now() + (this.options.timeoutMs ?? 300_000),
    );
    const timeout = AbortSignal.timeout(
      Math.max(0, Math.min(2_147_483_647, Math.floor(deadlineAt - Date.now()))),
    );
    return {
      deadlineAt,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
  }

  private async session(
    runtime: BehaviorRuntime,
    task: BehaviorAgentTask,
    context: VerificationStrategyContext,
    id: string,
    artifacts: VerificationArtifact[],
  ) {
    const callbacks: BehaviorCommandRecord[] = [];
    let persisted = false;
    let evidence: BehaviorCommandRecord[] = [];
    try {
      const result = await runtime.runAgent({
        ...task,
        onEvidence: (records) => {
          callbacks.push(...records);
        },
      });
      evidence = [...callbacks, ...(result.commandEvidence ?? [])];
      const session = {
        prompt: task.prompt,
        result,
        commandEvidence: evidence,
      };
      artifacts.push(await persistBehaviorArtifact(context, id, session));
      persisted = true;
      task.signal?.throwIfAborted();
      if (result.timedOut)
        throw new BehaviorFailure(
          "agent_timeout",
          "timeout",
          `${id} timed out.`,
        );
      if (result.exitCode !== 0)
        throw new BehaviorFailure(
          "agent_error",
          "not-executed",
          `${id} exited with ${result.exitCode}.`,
        );
      if (
        evidence.some(
          (record) =>
            !record.side ||
            !task.executionSides?.includes(record.side) ||
            record.cwd !==
              (record.side === task.side
                ? task.sandbox.cwd
                : task.additionalProjects?.[record.side]?.cwd) ||
            !record.baselineValid ||
            record.credentialHit ||
            record.completed === false ||
            record.timedOut,
        )
      )
        throw new BehaviorFailure(
          "report_evidence_invalid",
          "not-executed",
          "Agent command evidence violates the authorized phase.",
        );
      return session;
    } catch (cause) {
      if (!persisted)
        artifacts.push(
          await persistBehaviorArtifact(context, id, {
            error: errorText(cause),
            commandEvidence: [...callbacks, ...evidence],
          }),
        );
      throw cause;
    }
  }
}

function newReport(
  classification?: BehaviorReport["classification"],
): BehaviorReport {
  return {
    schemaVersion: "3.0",
    ...(classification ? { classification } : {}),
    stage: "eligibility",
    caseStatus: "not-executed",
    cases: [],
    evidence: [],
    repairs: [],
    limitations,
  };
}
function assertNewTests(
  manifest: BehaviorTargetManifest,
  baseline: BehaviorProjectBaseline,
): void {
  for (const path of manifest.testFiles)
    if (
      !isProjectTestPath(path) ||
      Object.hasOwn(baseline.files, path) ||
      [
        "manifest.json",
        "inputs.json",
        "target-plan.json",
        "diagnosis.json",
      ].some((name) => path === `${TEST_DIRECTORY}/${name}`)
    )
      throw new Error(
        "Black-box manifest must identify new test/helper files, not existing implementation or metadata.",
      );
}
function assertDeclaredNewFiles(
  root: string,
  baseline: BehaviorProjectBaseline,
  allowed: string[],
): void {
  for (const path of Object.keys(captureProjectBaseline(root).files))
    if (!Object.hasOwn(baseline.files, path) && !allowed.includes(path))
      throw new Error(`Undeclared target file: ${path}`);
}
function assertTranslationTransition(
  input: VerificationInput,
  payload: BlackBoxPreparation,
  targetRoot: string,
): void {
  const current = captureProjectBaseline(targetRoot);
  const patchPaths = new Set(input.translation.files.map((file) => file.path));
  if (payload.targetFiles.some((file) => patchPaths.has(file.path)))
    throw new Error("Translation patch overlaps prepared tests.");
  for (const patch of input.translation.files) {
    if (
      (patch.status === "created") ===
      Object.hasOwn(payload.targetBaseline.files, patch.path)
    )
      throw new Error(
        "Translation patch does not match the original target baseline.",
      );
    const mode = payload.targetModes[patch.path] ?? 0o100644;
    if (lstatSync(join(targetRoot, patch.path)).mode !== mode)
      throw new Error("Translation changed target file permissions.");
  }
  for (const [path, hash] of Object.entries(payload.targetBaseline.files))
    if (!patchPaths.has(path) && current.files[path] !== hash)
      throw new Error(`Target context changed: ${path}`);
  for (const path of Object.keys(current.files))
    if (
      !Object.hasOwn(payload.targetBaseline.files, path) &&
      !patchPaths.has(path) &&
      !payload.targetManifest.testFiles.includes(path)
    )
      throw new Error(`Unapproved target change: ${path}`);
}
function assertFrozenFiles(root: string, files: FrozenPreparationFile[]): void {
  for (const file of files)
    if (
      readTestFile(root, file.path) !== file.content ||
      lstatSync(join(root, file.path)).mode !== file.mode
    )
      throw new BehaviorFailure(
        "workspace_integrity_violation",
        "workspace-integrity-failed",
        `Frozen test artifact changed: ${file.path}`,
      );
}

function assertMetadataFiles(
  root: string,
  manifest: BehaviorTargetManifest,
  executing: boolean,
  diagnosing = false,
): void {
  const allowed = new Set([
    `${TEST_DIRECTORY}/manifest.json`,
    ...manifest.testFiles,
    ...(executing
      ? [
          `${TEST_DIRECTORY}/inputs.json`,
          ...(manifest.resultFile ? [manifest.resultFile] : []),
        ]
      : []),
    ...(diagnosing ? [`${TEST_DIRECTORY}/diagnosis.json`] : []),
  ]);
  const walk = (relativePath: string): void => {
    for (const entry of readdirSync(join(root, relativePath), {
      withFileTypes: true,
    })) {
      const path = `${relativePath}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`Invalid linked metadata: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (!allowed.has(path))
        throw new Error(`Undeclared target metadata: ${path}`);
      else readTestFile(root, path);
    }
  };
  walk(TEST_DIRECTORY);
}

function readPreparation(
  preparation: VerificationPreparation,
  input: VerificationInput,
): BlackBoxPreparation {
  const json = assertPreparation(
    preparation,
    MULTI_AGENT_BLACK_BOX_STRATEGY,
    input,
  );
  if (
    !json ||
    typeof json !== "object" ||
    Array.isArray(json) ||
    json.kind !== "black-box"
  )
    throw new Error("Invalid black-box preparation payload.");
  // SAFETY: the Host-bound capsule is detached and hash-checked; validate its strategy-specific fields below before use.
  const payload = json as unknown as BlackBoxPreparation;
  if (
    payload.classification !== classifyReuse(input) ||
    !Array.isArray(payload.targetFiles) ||
    !Array.isArray(payload.sourceChanges)
  )
    throw new Error("Invalid preparation classification or files.");
  const manifest = parseCollectionManifest(
    JSON.stringify(payload.sourceSnapshot.manifest),
  );
  if (manifest.cases.some((item) => item.expectation.kind === "unresolved"))
    throw new Error("Unresolved frozen expectation.");
  const sourceIds = manifest.cases
    .filter((item) => item.expectation.kind === "source")
    .map((item) => item.caseId);
  if (sourceIds.length)
    parseObservations(
      JSON.stringify(payload.sourceSnapshot.observations),
      sourceIds,
    );
  else if (payload.sourceSnapshot.observations.length)
    throw new Error("Requirement-only handoff contains source observations.");
  parseTargetManifest(JSON.stringify(payload.targetManifest));
  assertNewTests(payload.targetManifest, payload.targetBaseline);
  const expectedPaths = [
    `${TEST_DIRECTORY}/manifest.json`,
    ...payload.targetManifest.testFiles,
  ];
  if (
    payload.targetFiles.length !== expectedPaths.length ||
    new Set(payload.targetFiles.map((file) => file.path)).size !==
      expectedPaths.length ||
    payload.targetFiles.some((file) => !expectedPaths.includes(file.path))
  )
    throw new Error("Preparation test files do not match manifest.");
  return payload;
}
function compare(
  snapshot: BehaviorSourceSnapshot,
  observations: BehaviorCaseResult[],
): BehaviorReport["cases"] {
  return snapshot.manifest.cases.map((item) => {
    const source =
      snapshot.observations.find((value) => value.caseId === item.caseId) ??
      null;
    const target = observations.find((value) => value.caseId === item.caseId)!;
    const expected =
      item.expectation.kind === "requirement"
        ? item.expectation.expected
        : source!;
    return {
      caseId: item.caseId,
      expectation: item.expectation,
      expected,
      source,
      target,
      caseStatus: !isDeepStrictEqual(expected, target)
        ? "translation-divergence"
        : item.expectation.kind === "source"
          ? "verified-equivalent"
          : "requirement-satisfied",
    };
  });
}
function readDiagnosis(root: string): { kind: string; reason: string } {
  const value = parseBehaviorJson(
    readTestFile(root, `${TEST_DIRECTORY}/diagnosis.json`),
  );
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !["translation", "harness", "inconclusive"].includes(String(value.kind)) ||
    typeof value.reason !== "string" ||
    !value.reason.trim()
  )
    throw new Error("Invalid diagnostic report.");
  return { kind: String(value.kind), reason: value.reason };
}
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
export function createMultiAgentBlackBoxProvider(
  options: MultiAgentBlackBoxOptions = {},
): VerificationStrategyProvider {
  return {
    lifecycle: "two-phase",
    descriptor: MULTI_AGENT_BLACK_BOX_STRATEGY,
    workspaceRequirements: (input, phase) => ({
      source: phase === "prepare-tests" && classifyReuse(input) !== "not_applicable",
    }),
    create: () => new MultiAgentBlackBoxStrategy(options),
  };
}
