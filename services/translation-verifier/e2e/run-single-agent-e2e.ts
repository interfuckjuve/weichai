import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import { createVerificationArtifactStore } from "../src/run-output/verification-artifact-store.js";
import { createVerificationResult } from "../src/schemas/materialize-verification-result.js";
import { assertVerificationInput } from "../src/schemas/validate-verification-input.js";
import type {
  VerificationInput,
  VerificationResult,
  VerificationStrategyOutput,
} from "../src/schemas/verification-types.js";
import {
  runManagedProcess,
  sanitizedBuildEnvironment,
} from "../src/strategies/smoke-differential/manage-test-process.js";
import { projectHash } from "../src/strategies/multi-agent-differential/behavior-workspace.js";
import {
  protectedSecrets,
  redact,
} from "../src/strategies/multi-agent-differential/behavior-command.js";
import { createBehaviorRuntime } from "../src/strategies/multi-agent-differential/claude-runtime.js";
import {
  SingleAgentDifferentialStrategy,
  SINGLE_AGENT_DIFFERENTIAL_STRATEGY,
  type SingleAgentDifferentialOptions,
} from "../src/strategies/single-agent-differential/strategy.js";
import {
  repositoryRoot,
  sourceProjectRoot,
  targetProjectRoot,
  sha256,
  isFileUploadTask,
  type FileUploadTaskId,
} from "./fileupload-benchmark-fixture.js";
import {
  fileUploadVerificationInput,
  createE2EDatasetRecord,
  E2E_TARGET_PROJECT_ID,
} from "./fileupload-e2e-dataset.js";
import { createE2EObserver } from "./observe-e2e.js";

const singleAgentVariants = [
  "correct",
  "count-plus-one",
  "drop-output",
  "source-count-plus-one",
  "both-count-plus-one",
] as const;
export interface SingleAgentE2EOptions {
  outputRoot?: string;
  maxTurns?: number;
  task: FileUploadTaskId;
  variant: (typeof singleAgentVariants)[number];
  /** Separate budgets for environment preflight and Agent execution, not a total deadline. */
  timeoutMs: number;
  apiKey?: string;
  model?: string;
  effort?: string;
  analysisReport?: string;
  live: boolean;
  json: boolean;
  offlineOnly: boolean;
}
export function parseSingleAgentArgs(
  argv: string[],
): SingleAgentE2EOptions | { error: string } {
  const options: SingleAgentE2EOptions = {
    maxTurns: 50,
    task: "multipart-read-body",
    variant: "correct",
    timeoutMs: 600_000,
    live: false,
    json: false,
    offlineOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--live") options.live = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--offline-only") options.offlineOnly = true;
    else {
      if (
        ![
          "--task",
          "--variant",
          "--timeout-ms",
          "--api-key",
          "--model",
          "--effort",
          "--analysis-report",
          "--output-root",
          "--max-turns",
        ].includes(flag)
      )
        return { error: `Unknown option: ${flag}` };
      const value = argv[++i];
      if (!value || !value.trim() || value.startsWith("--"))
        return { error: `Missing value for ${flag}.` };
      if (flag === "--task") {
        if (!isFileUploadTask(value))
          return { error: `Unknown task: ${value}` };
        options.task = value;
      } else if (flag === "--variant") {
        const variant = singleAgentVariants.find(
          (candidate) => candidate === value,
        );
        if (!variant)
          return { error: `Unknown single-agent variant: ${value}` };
        options.variant = variant;
      } else if (flag === "--api-key") options.apiKey = value;
      else if (flag === "--model") options.model = value;
      else if (flag === "--analysis-report") options.analysisReport = value;
      else if (flag === "--output-root") options.outputRoot = value;
      else if (flag === "--effort") {
        if (!["low", "medium", "high", "xhigh", "max"].includes(value))
          return { error: `Invalid --effort: ${value}` };
        options.effort = value;
      } else {
        const limit = Number(value);
        if (
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(limit) ||
          limit <= 0 ||
          limit > 2_147_483_647
        )
          return { error: `Invalid ${flag}: ${value}` };
        if (flag === "--max-turns") options.maxTurns = limit;
        else options.timeoutMs = limit;
      }
    }
  }
  if (options.live && options.offlineOnly)
    return { error: "--live and --offline-only are mutually exclusive." };
  return options;
}
export interface ProjectPreparationEvidence {
  side: "source" | "target";
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}
export interface SingleAgentE2EDeps {
  runtime?: SingleAgentDifferentialOptions["runtime"];
  artifactRoot?: string;
  workspaceRoot?: string;
  input?: VerificationInput;
  now?: () => string;
  /** Mandatory for injected runtimes: tests never implicitly restore dependencies. */
  prepareProjects?: (context: {
    sourceRoot: string;
    targetRoot: string;
    deadlineAt: number;
    signal: AbortSignal;
    sides?: ("source" | "target")[];
    /** False keeps generated test compilation inside strategy verification. */
    compileTests?: boolean;
  }) => Promise<ProjectPreparationEvidence[]>;
}
export interface SingleAgentE2EResult {
  executionMode: "live" | "injected-test";
  result: VerificationResult;
  resultPath: string;
  workspaceRoot: string;
  preparationEvidencePath: string;
  timingPath: string;
  eventsPath: string;
  benchmarkPath: string;
  timings: { preparationMs: number; agentMs: number; totalMs: number };
}
async function containedPath(root: string, path: string): Promise<string> {
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (
    isAbsolute(path) ||
    isAbsolute(rel) ||
    !rel ||
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
  return destination;
}
async function overlay(
  root: string,
  files: { path: string; content: string }[],
): Promise<void> {
  for (const file of files) {
    const path = await containedPath(root, file.path);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
}
export async function prepareFileUploadProjects(
  context: Parameters<NonNullable<SingleAgentE2EDeps["prepareProjects"]>>[0],
): Promise<ProjectPreparationEvidence[]> {
  const evidence: ProjectPreparationEvidence[] = [];
  const commands = [
    {
      side: "source" as const,
      cwd: context.sourceRoot,
      command: "python3",
      args: [
        "-c",
        "import sys; assert sys.version_info >= (3, 11); sys.path.insert(0, 'src'); import commons_fileupload.core; import commons_fileupload.compat",
      ],
    },
    {
      side: "target" as const,
      cwd: context.targetRoot,
      command: "mvn",
      args: [
        "-B",
        "-ntp",
        "-DskipTests",
        "clean",
        context.compileTests === false ? "compile" : "test-compile",
      ],
    },
  ];
  for (const task of commands) {
    if (context.sides && !context.sides.includes(task.side)) continue;
    const startedAt = Date.now();
    let stdout = "";
    try {
      context.signal.throwIfAborted();
      const result = await runManagedProcess(
        {
          command: task.command,
          args: task.args,
          cwd: task.cwd,
          deadlineAt: context.deadlineAt,
          env: sanitizedBuildEnvironment(),
          onStdoutChunk: (chunk) => {
            stdout = (stdout + chunk.toString()).slice(-1024 * 1024);
          },
        },
        context.signal,
      );
      evidence.push({
        side: task.side,
        cwd: task.cwd,
        command: [task.command, ...task.args].join(" "),
        ...result,
      });
    } catch (error) {
      evidence.push({
        side: task.side,
        cwd: task.cwd,
        command: [task.command, ...task.args].join(" "),
        durationMs: Date.now() - startedAt,
        exitCode: null,
        timedOut: context.signal.aborted,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    }
    if (evidence.at(-1)!.exitCode !== 0 || evidence.at(-1)!.timedOut) break;
  }
  return evidence;
}

export async function executeSingleAgentE2E(
  options: SingleAgentE2EOptions,
  deps: SingleAgentE2EDeps = {},
): Promise<SingleAgentE2EResult> {
  if (options.offlineOnly)
    throw new Error("offline-only skips execution; use runSingleAgentE2E.");
  if (!options.live && !deps.runtime)
    throw new Error(
      "Use --live for real Claude execution; no mock fallback is installed.",
    );
  if (deps.runtime && !deps.prepareProjects)
    throw new Error(
      "Injected runtimes require explicit prepareProjects; tests never implicitly restore dependencies.",
    );
  if (!deps.runtime && deps.prepareProjects)
    throw new Error(
      "Live execution requires real project preparation, not an injected preflight.",
    );
  const startedAt = Date.now();
  const secrets = protectedSecrets(options.apiKey);
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
        `Cannot read Analyzer report: ${redact(error instanceof Error ? error.message : String(error), secrets)}`,
      );
    }
  }
  assertVerificationInput(input);
  const timeoutMs = Math.min(options.timeoutMs, 600_000);
  const maxTurns = Math.min(options.maxTurns ?? 50, 50);
  const model =
    options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const executionMode = deps.runtime
    ? ("injected-test" as const)
    : ("live" as const);
  const descriptor = SINGLE_AGENT_DIFFERENTIAL_STRATEGY;
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
  const store = createVerificationArtifactStore({
    artifactRoot: deps.artifactRoot ?? join(root, "artifacts"),
    durablePrefix: `attempt-e2e-${runId}`,
    agentRoot: strategyRoot,
  });
  const preparationEvidencePath = join(root, "preparation.json");
  let evidence: ProjectPreparationEvidence[] = [];
  let preparationError: string | undefined;
  let preparationMs = 0,
    agentMs = 0;
  let originalsUnchanged = false;
  let output: VerificationStrategyOutput | undefined;
  let telemetry = {
    timingPath: join(root, "timing.json"),
    eventsPath: join(root, "events.jsonl"),
  };
  const failure = (
    message: string,
    integrity = false,
  ): VerificationStrategyOutput => ({
    mode: "target_only",
    referenceDecision: "undetermined",
    referenceReason:
      "Project preparation or execution failed; inspect the recorded phase evidence.",
    executionStatus: "failed",
    sourceAssessment: "not_checked",
    targetAssessment: "not_checked",
    problems: [
      {
        code: integrity
          ? "workspace_integrity_violation"
          : "environment_unavailable",
        message: redact(message, secrets),
      },
    ],
    summary: redact(message, secrets),
    issues: [],
    artifacts: [],
    strategyReport: { stage: "e2e", evidencePath: preparationEvidencePath },
  });
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
    await observer.measureStep("apply-fixed-translation", async () => {
      for (const patch of input.translation.files) {
        const path = await containedPath(targetRoot, patch.path);
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
    });
    const controller = new AbortController();
    const abort = () =>
      controller.abort(
        new DOMException(
          "Project preparation deadline exceeded",
          "TimeoutError",
        ),
      );
    const timer = setTimeout(abort, Math.max(0, timeoutMs));
    if (timeoutMs <= 0) abort();
    try {
      await observer.measureStep("project-preflight", async () => {
        controller.signal.throwIfAborted();
        evidence = await (deps.prepareProjects ?? prepareFileUploadProjects)({
          sourceRoot,
          targetRoot,
          signal: controller.signal,
          deadlineAt: Date.now() + timeoutMs,
        });
        controller.signal.throwIfAborted();
        if (
          evidence.length !== 2 ||
          !["source", "target"].every(
            (side) =>
              evidence.filter((item) => item.side === side).length === 1,
          ) ||
          evidence.some(
            (item) =>
              item.exitCode !== 0 ||
              item.timedOut ||
              item.cwd !== (item.side === "source" ? sourceRoot : targetRoot),
          )
        )
          throw new Error(
            "Both source and target project preparation must succeed.",
          );
      });
    } catch (error) {
      preparationError = redact(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
    } finally {
      clearTimeout(timer);
      observer.recordPreparation(evidence);
    }
    preparationMs = Date.now() - startedAt;
    if (preparationError) {
      observer.skip(
        "single-agent-validation",
        "Project preflight failed; no Agent session started.",
      );
      output = failure(preparationError);
    } else {
      const runtimeOptions = {
        apiKey: options.apiKey,
        model,
        effort: options.effort ?? "low",
        timeoutMs,
        maxTurns,
      };
      const runtime = observer.wrapRuntime(
        deps.runtime ?? createBehaviorRuntime(runtimeOptions),
      );
      const agentStartedAt = Date.now();
      try {
        output = await observer.measureStep("single-agent-validation", () =>
          new SingleAgentDifferentialStrategy({
            ...runtimeOptions,
            runtime,
          }).verify(input, {
            workspace: {
              root,
              sourceRoot,
              targetRoot,
              strategyRoot,
              evidenceRoot: strategyRoot,
              projectOwnership: "caller",
            },
            deadlineAt: Date.now() + timeoutMs,
            writeArtifact: store.writeArtifact,
            measureStep: (name, work) =>
              observer.measureStep(name, async () => work()),
          }),
        );
      } finally {
        agentMs = Date.now() - agentStartedAt;
      }
    }
  } catch (cause) {
    const message = redact(
      cause instanceof Error ? cause.message : String(cause),
      secrets,
    );
    if (!preparationMs) {
      preparationMs = Date.now() - startedAt;
      preparationError = message;
      observer.skip(
        "single-agent-validation",
        "Fixture setup failed; no Agent session started.",
      );
    }
    output = failure(message);
    await writeFile(
      join(root, "failure.json"),
      `${JSON.stringify({ message }, null, 2)}\n`,
      { flag: "wx" },
    ).catch(() => {});
  } finally {
    try {
      originalsUnchanged =
        projectHash(sourceProjectRoot) === originals.source &&
        projectHash(targetProjectRoot) === originals.target;
      if (!originalsUnchanged)
        output = failure(
          "Original FileUpload fixtures changed during the run; benchmark is invalid.",
          true,
        );
    } catch (cause) {
      output = failure(
        cause instanceof Error ? cause.message : String(cause),
        true,
      );
    }
    try {
      telemetry = await observer.finish();
    } catch {
      /* Telemetry is best effort. */
    }
  }
  const preparationText = `${redact(JSON.stringify({ status: preparationError ? "failed" : "completed", evidence, error: preparationError }, null, 2), secrets)}\n`;
  let result: VerificationResult;
  try {
    await writeFile(preparationEvidencePath, preparationText, { flag: "wx" });
    await writeFile(
      join(strategyRoot, "e2e-preparation.json"),
      preparationText,
      { flag: "wx" },
    );
    output!.artifacts.push(
      await store.writeArtifact({
        id: "e2e-preparation",
        kind: "environment-preparation",
        path: "e2e-preparation.json",
        contentHash: sha256(preparationText),
        mediaType: "application/json",
      }),
    );
    result = createVerificationResult(input, descriptor, output!, deps.now);
    store.writeFrameworkResult(
      new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`),
    );
  } catch (cause) {
    const failed = failure(
      cause instanceof Error ? cause.message : String(cause),
    );
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
  const timings = { preparationMs, agentMs, totalMs: Date.now() - startedAt };
  await writeFile(resultPath, text, { flag: "wx" });
  // Preserve the legacy API timings field without replacing unified timing.json.
  await writeFile(
    benchmarkPath,
    `${JSON.stringify({ dataset, strategy: descriptor.id, strategyVersion: descriptor.version, model, effort: options.effort ?? "low", task: options.task, variant: options.variant, executionMode, budget: { timeoutMs, maxTurns, scope: "per-preflight-and-phase", nativeSessionTimeoutMs: timeoutMs, nativeSessionMaxTurns: maxTurns }, originals, originalsUnchanged, preparationEvidencePath, resultPath, timings, ...telemetry }, null, 2)}\n`,
    { flag: "wx" },
  );
  return {
    executionMode,
    result,
    resultPath,
    workspaceRoot: root,
    preparationEvidencePath,
    benchmarkPath,
    timings,
    ...telemetry,
  };
}
export async function runSingleAgentE2E(
  argv: string[],
  deps: SingleAgentE2EDeps = {},
): Promise<number> {
  const parsed = parseSingleAgentArgs(argv);
  if ("error" in parsed) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  if (parsed.offlineOnly) {
    const output = { executionMode: "skipped", reason: "offline-only" };
    console.log(
      parsed.json
        ? JSON.stringify(output)
        : "Skipped: offline-only does not execute agents or verify behavior.",
    );
    return 0;
  }
  try {
    const output = await executeSingleAgentE2E(parsed, deps);
    console.log(
      parsed.json
        ? JSON.stringify(output, null, 2)
        : `${output.executionMode}: ${parsed.task}/${parsed.variant}: ${output.result.executionStatus} target=${output.result.targetAssessment}\nReport: ${output.resultPath}`,
    );
    return output.result.executionStatus === "completed" ? 0 : 1;
  } catch (error) {
    console.error(
      `error: ${redact(error instanceof Error ? error.message : String(error), protectedSecrets(parsed.apiKey))}`,
    );
    return 2;
  }
}
if (process.argv[1]?.endsWith("run-single-agent-e2e.ts"))
  process.exitCode = await runSingleAgentE2E(process.argv.slice(2));
