import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import {
  prepareFileUploadProjects,
  type ProjectPreparationEvidence,
} from "./run-single-agent-e2e.js";
import {
  protectedSecrets,
  redact,
} from "../src/strategies/multi-agent-differential/behavior-command.js";
import {
  persistBehaviorArtifact,
  projectHash,
} from "../src/strategies/multi-agent-differential/behavior-workspace.js";
import { createBehaviorRuntime } from "../src/strategies/multi-agent-differential/claude-runtime.js";
import { createVerificationArtifactStore } from "../src/run-output/verification-artifact-store.js";
import { createVerificationResult } from "../src/schemas/materialize-verification-result.js";
import { assertVerificationInput } from "../src/schemas/validate-verification-input.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
  VerificationResult,
  VerificationStrategyOutput,
  VerificationPreparation,
} from "../src/schemas/verification-types.js";
import {
  MULTI_AGENT_DIFFERENTIAL_STRATEGY,
  MultiAgentDifferentialStrategy,
  BehaviorFailure,
  classifyReuse,
} from "../src/strategies/multi-agent-differential/strategy.js";
import {
  MULTI_AGENT_BLACK_BOX_STRATEGY,
  MultiAgentBlackBoxStrategy,
} from "../src/strategies/multi-agent-black-box/strategy.js";
import type { BehaviorRuntime } from "../src/strategies/multi-agent-differential/behavior-types.js";
import {
  repositoryRoot,
  sourceProjectRoot,
  targetProjectRoot,
  sha256,
  isDatasetVariant,
  isFileUploadTask,
  type DatasetVariant,
  type FileUploadTaskId,
} from "./fileupload-benchmark-fixture.js";
import {
  fileUploadVerificationInput,
  createE2EDatasetRecord,
  E2E_TARGET_PROJECT_ID,
} from "./fileupload-e2e-dataset.js";
import { createE2EObserver } from "./observe-e2e.js";

export interface MultiAgentE2EDeps {
  runtime?: BehaviorRuntime;
  artifactRoot?: string;
  workspaceRoot?: string;
  now?: () => string;
  input?: VerificationInput;
  /** Explicit test seam; live runs default to the real Maven preflight. */
  prepareProjects?: (input: {
    sourceRoot: string;
    targetRoot: string;
    deadlineAt: number;
    signal: AbortSignal;
    sides?: ("source" | "target")[];
    compileTests?: boolean;
  }) => Promise<Omit<ProjectPreparationEvidence, "side">>;
}
export interface MultiAgentE2EOptions {
  strategyId?: "multi-agent-differential" | "multi-agent-black-box";
  outputRoot?: string;
  maxTurns?: number;
  analysisReport?: string;
  task: FileUploadTaskId;
  variant: DatasetVariant;
  /** Independent preflight and per-phase budgets, not a total run deadline. */
  timeoutMs: number;
  apiKey?: string;
  model?: string;
  effort?: string;
  live: boolean;
  json: boolean;
}
export interface MultiAgentE2EResult {
  executionMode: "live" | "injected-test";
  result: VerificationResult;
  resultPath: string;
  workspaceRoot: string;
  targetReady: boolean;
  preparationEvidencePath?: string;
  preparationEvidencePaths: string[];
  timingPath: string;
  eventsPath: string;
  benchmarkPath: string;
}

const valueFlags = new Set([
  "--task",
  "--variant",
  "--timeout-ms",
  "--api-key",
  "--model",
  "--effort",
  "--output-root",
  "--max-turns",
  "--analysis-report",
]);
export function parseMultiAgentArgs(
  argv: string[],
): MultiAgentE2EOptions | { error: string } {
  const options: MultiAgentE2EOptions = {
    strategyId: "multi-agent-differential",
    maxTurns: 50,
    task: "multipart-read-body",
    variant: "correct",
    timeoutMs: 600_000,
    live: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--strategy") {
      const strategy = argv[++i];
      if (
        strategy !== "multi-agent-differential" &&
        strategy !== "multi-agent-black-box"
      )
        return { error: "Invalid multi-agent strategy." };
      options.strategyId = strategy;
      continue;
    }
    if (flag === "--live") {
      options.live = true;
      continue;
    }
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    if (flag === "--offline-only" || flag === "--verify-only") continue;
    if (!valueFlags.has(flag)) return { error: `Unknown option: ${flag}` };
    const value = argv[++i];
    if (!value || !value.trim() || value.startsWith("--"))
      return { error: `Missing value for ${flag}.` };
    if (flag === "--task") {
      if (!isFileUploadTask(value)) return { error: `Unknown task: ${value}` };
      options.task = value;
    } else if (flag === "--variant") {
      if (!isDatasetVariant(value))
        return { error: `Unknown variant: ${value}` };
      options.variant = value;
    } else if (flag === "--api-key") options.apiKey = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--output-root") options.outputRoot = value;
    else if (flag === "--analysis-report") options.analysisReport = value;
    else if (flag === "--effort") {
      if (!["low", "medium", "high", "xhigh", "max"].includes(value))
        return { error: `Invalid --effort: ${value}` };
      options.effort = value;
    } else if (
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) <= 0 ||
      Number(value) > 2_147_483_647
    )
      return { error: `Invalid ${flag}: "${value}".` };
    else if (flag === "--max-turns") options.maxTurns = Number(value);
    else options.timeoutMs = Number(value);
  }
  if (options.live && argv.includes("--offline-only"))
    return { error: "--live and --offline-only are mutually exclusive." };
  return options;
}

async function assertContained(root: string, path: string): Promise<string> {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (
    isAbsolute(path) ||
    isAbsolute(rel) ||
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`)
  )
    throw new Error(`Unsafe fixture path: ${path}`);
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (entry?.isSymbolicLink())
      throw new Error(`Symlink fixture path: ${path}`);
  }
  return resolved;
}
async function overlay(
  root: string,
  files: { path: string; content: string }[],
): Promise<void> {
  for (const file of files) {
    const destination = await assertContained(root, file.path);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await writeFile(destination, file.content, "utf8");
  }
}

export async function runMultiAgentE2E(
  argv: string[],
  deps: MultiAgentE2EDeps = {},
): Promise<number> {
  const parsed = parseMultiAgentArgs(argv);
  if ("error" in parsed) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  if (!parsed.live && argv.includes("--offline-only")) {
    console.log(
      "Skipped: offline-only does not execute agents or verify behavior.",
    );
    return 0;
  }
  try {
    const output = await executeMultiAgentE2E(parsed, deps);
    if (parsed.json) console.log(JSON.stringify(output, null, 2));
    else
      console.log(
        `${output.executionMode}: ${parsed.task}/${parsed.variant}: ${output.result.executionStatus} target=${output.result.targetAssessment}\nReport: ${output.resultPath}`,
      );
    return output.result.executionStatus === "completed" ? 0 : 1;
  } catch (error) {
    console.error(
      `error: ${redact(error instanceof Error ? error.message : String(error), protectedSecrets(parsed.apiKey))}`,
    );
    return 2;
  }
}

export async function executeMultiAgentE2E(
  options: MultiAgentE2EOptions,
  deps: MultiAgentE2EDeps = {},
): Promise<MultiAgentE2EResult> {
  if (!options.live && !deps.runtime)
    throw new Error(
      "Use --live for real Claude execution. Test runtimes must be explicitly injected; no mock fallback is installed.",
    );
  if (options.live && deps.runtime && !deps.prepareProjects)
    throw new Error(
      "Live injected runtimes require an explicit prepareProjects seam; real Maven is never hidden behind injected-test mode.",
    );
  if (!deps.runtime && deps.prepareProjects)
    throw new Error(
      "Live execution requires real project preparation, not an injected preflight.",
    );
  const input = structuredClone(
    deps.input ?? fileUploadVerificationInput(options.variant, options.task),
  );
  delete input.verificationPolicy;
  if (
    input.migrationPlan &&
    typeof input.migrationPlan === "object" &&
    !Array.isArray(input.migrationPlan)
  )
    delete input.migrationPlan.outputProvenance;
  if (options.analysisReport) {
    try {
      input.analysisReport = JSON.parse(
        await readFile(resolve(options.analysisReport), "utf8"),
      );
    } catch (error) {
      throw new Error(
        `Cannot read Analyzer report: ${redact(error instanceof Error ? error.message : String(error), protectedSecrets(options.apiKey))}`,
      );
    }
  }
  assertVerificationInput(input);
  const descriptor =
    options.strategyId === "multi-agent-black-box"
      ? MULTI_AGENT_BLACK_BOX_STRATEGY
      : MULTI_AGENT_DIFFERENTIAL_STRATEGY;
  const timeoutMs = Math.min(options.timeoutMs, 600_000);
  const maxTurns = Math.min(options.maxTurns ?? 50, 50);
  const model =
    options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const executionMode = deps.runtime
    ? ("injected-test" as const)
    : ("live" as const);
  const runId = randomUUID();
  const requestedRoot = resolve(
    options.outputRoot ??
      deps.workspaceRoot ??
      join(repositoryRoot, "e2e-runs"),
    descriptor.id,
    E2E_TARGET_PROJECT_ID,
    runId,
  );
  await mkdir(resolve(requestedRoot, ".."), { recursive: true });
  await mkdir(requestedRoot);
  const root = await realpath(requestedRoot);
  const sourceRoot = join(root, "source"),
    targetRoot = join(root, "target"),
    strategyRoot = join(root, "agent");
  await mkdir(strategyRoot);
  const secrets = protectedSecrets(options.apiKey);
  const observer = createE2EObserver({
    root,
    strategy: descriptor.id,
    model,
    task: options.task,
    variant: options.variant,
    secrets,
  });
  const originals = {
    source: projectHash(sourceProjectRoot),
    target: projectHash(targetProjectRoot),
  };
  const dataset = createE2EDatasetRecord(input, options.task, options.variant);
  const artifactRoot = deps.artifactRoot ?? join(root, "artifacts");
  const store = createVerificationArtifactStore({
    artifactRoot,
    durablePrefix: `attempt-e2e-${runId}`,
    agentRoot: strategyRoot,
  });
  const context: VerificationStrategyContext = {
    workspace: {
      root,
      sourceRoot,
      targetRoot,
      strategyRoot,
      evidenceRoot: strategyRoot,
    },
    deadlineAt: Date.now() + timeoutMs,
    writeArtifact: store.writeArtifact,
    measureStep: (name, work) => observer.measureStep(name, async () => work()),
  };
  const preparationEvidencePaths: string[] = [];
  let preparation: VerificationPreparation | undefined;
  let targetReady = false;
  let targetOnly = false;
  let blackBoxAgent2Started = false;
  let originalsUnchanged = false;
  let output: VerificationStrategyOutput | undefined;
  let telemetry = {
    timingPath: join(root, "timing.json"),
    eventsPath: join(root, "events.jsonl"),
  };
  const phase = async <T>(
    name: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const abort = () =>
      controller.abort(
        new DOMException(`${name} deadline exceeded`, "TimeoutError"),
      );
    const timer = setTimeout(abort, Math.max(0, timeoutMs));
    if (timeoutMs <= 0) abort();
    context.deadlineAt = Date.now() + timeoutMs;
    try {
      return await observer.measureStep(name, async () => {
        controller.signal.throwIfAborted();
        const value = await work(controller.signal);
        controller.signal.throwIfAborted();
        return value;
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const preflight = async (name: "original" | "translated") => {
    if (!options.live) {
      observer.skip(
        `${name}-preflight`,
        "Injected offline orchestration; no project preflight.",
      );
      return;
    }
    let evidence:
      | (Omit<ProjectPreparationEvidence, "side"> & {
          commands?: ProjectPreparationEvidence[];
        })
      | undefined;
    const startedAt = Date.now();
    try {
      evidence = await phase(`${name}-preflight`, async (signal) => {
        const sides: ("source" | "target")[] =
          name === "translated" &&
          descriptor.id === MULTI_AGENT_BLACK_BOX_STRATEGY.id
            ? ["target"]
            : ["source", "target"];
        const compileTests = !(
          name === "translated" &&
          descriptor.id === MULTI_AGENT_BLACK_BOX_STRATEGY.id
        );
        if (deps.prepareProjects)
          evidence = await deps.prepareProjects({
            sourceRoot,
            targetRoot,
            deadlineAt: context.deadlineAt,
            signal,
            sides,
            compileTests,
          });
        else {
          const commands = await prepareFileUploadProjects({
            sourceRoot,
            targetRoot,
            deadlineAt: context.deadlineAt,
            signal,
            sides,
            compileTests,
          });
          evidence = { ...commands.at(-1)!, commands };
        }
        return evidence;
      });
    } catch (error) {
      evidence = evidence
        ? { ...evidence, timedOut: true }
        : {
            command: deps.prepareProjects
              ? "injected prepareProjects"
              : "project preflight",
            cwd: targetRoot,
            durationMs: Date.now() - startedAt,
            exitCode: null,
            timedOut: error instanceof Error && error.name === "TimeoutError",
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
          };
    }
    const evidencePath = join(strategyRoot, `${name}-preparation.json`);
    await writeFile(
      evidencePath,
      `${redact(JSON.stringify(evidence, null, 2), secrets)}\n`,
      { flag: "wx" },
    );
    preparationEvidencePaths.push(evidencePath);
    observer.recordPreparation(
      evidence.commands ?? [{ ...evidence, side: "target" }],
    );
    if (evidence.exitCode !== 0 || evidence.timedOut)
      throw new Error(
        `Target project preparation failed (exit ${evidence.exitCode ?? "unknown"}).`,
      );
  };
  const fail = async (cause: unknown): Promise<VerificationStrategyOutput> => {
    const message = redact(
      cause instanceof Error ? cause.message : String(cause),
      secrets,
    );
    const artifacts = [];
    try {
      artifacts.push(
        await persistBehaviorArtifact(context, "project-preparation-failure", {
          message,
        }),
      );
      if (preparation)
        artifacts.push(
          await persistBehaviorArtifact(
            context,
            "fixture-verification-preparation",
            preparation,
          ),
        );
    } catch {
      /* Keep the verifier failure even when artifact storage is unavailable. */
    }
    if (cause instanceof BehaviorFailure && cause.output)
      return {
        ...cause.output,
        artifacts: [...cause.output.artifacts, ...artifacts],
      };
    return {
      mode: "target_only",
      referenceDecision: "undetermined",
      referenceReason:
        "Fixture preparation or translation application failed; inspect phase evidence for completed source work.",
      executionStatus: "failed",
      sourceAssessment: "not_checked",
      targetAssessment: "not_checked",
      problems: [
        {
          code:
            cause instanceof BehaviorFailure
              ? cause.code
              : cause instanceof Error && cause.name === "TimeoutError"
                ? "agent_timeout"
                : "environment_unavailable",
          message,
        },
      ],
      summary: message,
      issues: [],
      artifacts,
      strategyReport: { stage: "preparation", message },
    };
  };
  try {
    await observer.measureStep("copy-projects", async () => {
      // FICLONE falls back to independent ordinary copies, never hard links.
      await Promise.all([
        cp(sourceProjectRoot, sourceRoot, {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          dereference: true,
        }),
        cp(targetProjectRoot, targetRoot, {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          dereference: true,
        }),
      ]);
      await overlay(sourceRoot, input.request.sourceBundle.files);
      await overlay(
        targetRoot,
        input.request.targetContext.sourceFiles.flatMap((file) =>
          typeof file.path === "string" && typeof file.content === "string"
            ? [{ path: file.path, content: file.content }]
            : [],
        ),
      );
    });
    // Compile the skeleton before Agent1 can create target tests.
    await preflight("original");
    const runtimeOptions = {
      apiKey: options.apiKey,
      model,
      effort: options.effort ?? "low",
      timeoutMs,
      maxTurns,
    };
    const observedRuntime = observer.wrapRuntime(
      deps.runtime ?? createBehaviorRuntime(runtimeOptions),
    );
    const runtime: BehaviorRuntime = {
      ...observedRuntime,
      runAgent: (task) => {
        if (!targetOnly && task.side === "target") blackBoxAgent2Started = true;
        return observedRuntime.runAgent(task);
      },
    };
    const strategy =
      descriptor.id === MULTI_AGENT_BLACK_BOX_STRATEGY.id
        ? new MultiAgentBlackBoxStrategy({ ...runtimeOptions, runtime })
        : new MultiAgentDifferentialStrategy({ ...runtimeOptions, runtime });
    const { request, analysisReport, migrationPlan } = input;
    targetOnly = classifyReuse(input) === "not_applicable";
    if (targetOnly)
      observer.skip(
        "prepare-tests",
        "Not-applicable target-only branch; not black-box coverage.",
      );
    else
      preparation = await phase("prepare-tests", (signal) =>
        strategy.prepareTests(
          { request, analysisReport, migrationPlan },
          context,
          signal,
        ),
      );
    await phase("apply-fixed-translation", async (signal) => {
      for (const patch of input.translation.files) {
        signal.throwIfAborted();
        const path = await assertContained(targetRoot, patch.path);
        if (patch.status === "created") {
          await mkdir(resolve(path, ".."), { recursive: true });
          await writeFile(path, newFileContent(patch.hunks), { flag: "wx" });
        } else {
          const original = await readFile(path, "utf8");
          if (sha256(original) !== patch.expectedOriginalSha256)
            throw new Error(
              "Target fixture hash changed before translation application.",
            );
          await writeFile(
            path,
            applyHunksStrict(original, patch.hunks),
            "utf8",
          );
        }
      }
      targetReady = true;
    });
    await preflight("translated");
    output = await phase("verify-translation", async (signal) => {
      output = await strategy.verifyTranslation(
        input,
        context,
        preparation,
        signal,
      );
      return output;
    });
  } catch (cause) {
    // Keep the verifier's structured timeout/cancellation evidence after cleanup.
    if (!output || output.executionStatus === "completed")
      output = await fail(cause);
  } finally {
    try {
      originalsUnchanged =
        projectHash(sourceProjectRoot) === originals.source &&
        projectHash(targetProjectRoot) === originals.target;
      if (!originalsUnchanged)
        output = await fail(
          new BehaviorFailure(
            "workspace_integrity_violation",
            "workspace-integrity-failed",
            "Original FileUpload fixtures changed during the run; benchmark is invalid.",
          ),
        );
    } catch (cause) {
      output = await fail(cause);
    }
    if (
      descriptor.id === MULTI_AGENT_BLACK_BOX_STRATEGY.id &&
      !blackBoxAgent2Started
    )
      observer.skip(
        "black-box-agent2",
        targetOnly
          ? "Not-applicable target-only branch; not black-box coverage."
          : "No diagnostic session started; inspect verification status and phase evidence.",
      );
    try {
      telemetry = await observer.finish();
    } catch {
      /* Telemetry is best effort. */
    }
  }
  let result = createVerificationResult(input, descriptor, output!, deps.now);
  try {
    store.writeFrameworkResult(
      new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`),
    );
  } catch (cause) {
    const failed = await fail(cause);
    result = createVerificationResult(
      input,
      descriptor,
      { ...failed, artifacts: output!.artifacts },
      deps.now,
    );
    await writeFile(
      join(root, "persistence-failure.json"),
      `${JSON.stringify({ message: failed.summary }, null, 2)}\n`,
      { flag: "wx" },
    ).catch(() => {});
  }
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const resultPath = join(root, "report.json");
  const benchmarkPath = join(root, "benchmark.json");
  await writeFile(resultPath, text, { flag: "wx" });
  await writeFile(
    benchmarkPath,
    `${JSON.stringify({ dataset, strategy: descriptor.id, strategyVersion: descriptor.version, model, effort: options.effort ?? "low", task: options.task, variant: options.variant, executionMode, budget: { timeoutMs, maxTurns, scope: "per-preflight-and-phase", nativeSessionTimeoutMs: timeoutMs, nativeSessionMaxTurns: maxTurns }, originals, originalsUnchanged, preparationEvidencePaths, resultPath, ...telemetry }, null, 2)}\n`,
    { flag: "wx" },
  );
  return {
    executionMode,
    result,
    resultPath,
    workspaceRoot: root,
    targetReady,
    preparationEvidencePath: preparationEvidencePaths.at(-1),
    preparationEvidencePaths,
    benchmarkPath,
    ...telemetry,
  };
}

if (process.argv[1]?.endsWith("run-multi-agent-e2e.ts"))
  process.exitCode = await runMultiAgentE2E(process.argv.slice(2));
