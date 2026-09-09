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
import type { SingleAgentDifferentialOptions } from "../src/strategies/single-agent-differential/strategy.js";
import {
  fileUploadInput,
  repositoryRoot,
  sourceProjectRoot,
  targetProjectRoot,
  sha256,
  isFileUploadTask,
  type FileUploadTaskId,
} from "./fileupload-benchmark-fixture.js";

const singleAgentVariants = [
  "correct",
  "count-plus-one",
  "drop-output",
  "source-count-plus-one",
  "both-count-plus-one",
] as const;

export interface SingleAgentE2EOptions {
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
        ].includes(flag)
      )
        return { error: `Unknown option: ${flag}` };
      const value = argv[++i];
      if (!value || value.startsWith("--"))
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
      else if (flag === "--effort") {
        if (!["low", "medium", "high", "xhigh", "max"].includes(value))
          return { error: `Invalid --effort: ${value}` };
        options.effort = value;
      } else {
        const timeout = Number(value);
        if (
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(timeout) ||
          timeout <= 0 ||
          timeout > 2_147_483_647
        )
          return { error: `Invalid --timeout-ms: ${value}` };
        options.timeoutMs = timeout;
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
  }) => Promise<ProjectPreparationEvidence[]>;
}

export interface SingleAgentE2EResult {
  executionMode: "live" | "injected-test";
  result: VerificationResult;
  resultPath: string;
  workspaceRoot: string;
  preparationEvidencePath: string;
  timingPath: string;
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
      args: ["-B", "-ntp", "-DskipTests", "clean", "test-compile"],
    },
  ];
  for (const task of commands) {
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
    deps.input ?? fileUploadInput(options.variant, options.task),
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
  } else if (!deps.input)
    input.analysisReport = {
      scope: `Selected FileUpload task ${options.task} and class prerequisites`,
      provenance:
        "Simulated Analyzer report; no live upstream analysis was executed.",
      notes:
        "Assess reference suitability from the requirement and actual project evidence. Python materializes input while Java streams it; representation and exception timing may differ.",
    };
  assertVerificationInput(input);
  const originals = {
    source: projectHash(sourceProjectRoot),
    target: projectHash(targetProjectRoot),
  };
  const requestedRoot = resolve(
    deps.workspaceRoot ??
      join(repositoryRoot, "services/translation-verifier/test-results"),
    `single-agent-${randomUUID()}`,
  );
  await mkdir(requestedRoot, { recursive: true });
  const root = await realpath(requestedRoot);
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const strategyRoot = join(root, "agent");
  await mkdir(strategyRoot, { recursive: true });
  // FICLONE falls back to an independent ordinary copy, never a hard link.
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
      await writeFile(path, applyHunksStrict(original, patch.hunks), "utf8");
    }
  }
  const preparationEvidencePath = join(root, "preparation.json");
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "Project preparation deadline exceeded",
          "TimeoutError",
        ),
      ),
    options.timeoutMs,
  );
  let evidence: ProjectPreparationEvidence[] = [];
  let preparationError: string | undefined;
  try {
    evidence = await (deps.prepareProjects ?? prepareFileUploadProjects)({
      sourceRoot,
      targetRoot,
      signal: controller.signal,
      deadlineAt: Date.now() + options.timeoutMs,
    });
    controller.signal.throwIfAborted();
    if (
      evidence.length !== 2 ||
      !["source", "target"].every(
        (side) => evidence.filter((item) => item.side === side).length === 1,
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
  } catch (error) {
    preparationError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
  if (preparationError) preparationError = redact(preparationError, secrets);
  const preparationText = `${redact(JSON.stringify({ status: preparationError ? "failed" : "completed", evidence, error: preparationError }, null, 2), secrets)}\n`;
  await writeFile(preparationEvidencePath, preparationText);
  const preparationMs = Date.now() - startedAt;
  const artifactRoot = deps.artifactRoot ?? join(root, "artifacts");
  const store = createVerificationArtifactStore({
    artifactRoot,
    durablePrefix: `attempt-e2e-${randomUUID()}`,
    agentRoot: strategyRoot,
  });
  const {
    SingleAgentDifferentialStrategy,
    SINGLE_AGENT_DIFFERENTIAL_STRATEGY,
  } = await import("../src/strategies/single-agent-differential/strategy.js");
  let output: VerificationStrategyOutput;
  const agentStartedAt = Date.now();
  if (preparationError)
    output = {
      mode: "target_only",
      referenceDecision: "undetermined",
      referenceReason:
        "Project preparation failed before the Agent could assess reference suitability.",
      executionStatus: "failed",
      sourceAssessment: "not_checked",
      targetAssessment: "not_checked",
      problems: [
        { code: "environment_unavailable", message: preparationError },
      ],
      summary: "Environment preflight failed; no Agent session was started.",
      issues: [],
      artifacts: [],
      strategyReport: {
        stage: "preparation",
        evidencePath: preparationEvidencePath,
      },
    };
  else
    output = await new SingleAgentDifferentialStrategy({
      runtime: deps.runtime,
      apiKey: options.apiKey,
      model: options.model,
      effort: options.effort,
      timeoutMs: options.timeoutMs,
    }).verify(input, {
      workspace: {
        root,
        sourceRoot,
        targetRoot,
        strategyRoot,
        evidenceRoot: strategyRoot,
        projectOwnership: "caller",
      },
      deadlineAt: Date.now() + options.timeoutMs,
      writeArtifact: store.writeArtifact,
    });
  const agentMs = preparationError ? 0 : Date.now() - agentStartedAt;
  if (
    projectHash(sourceProjectRoot) !== originals.source ||
    projectHash(targetProjectRoot) !== originals.target
  )
    throw new Error(
      "Original FileUpload fixtures changed during the run; benchmark is invalid.",
    );
  await writeFile(join(strategyRoot, "e2e-preparation.json"), preparationText, {
    flag: "wx",
  });
  output.artifacts.push(
    await store.writeArtifact({
      id: "e2e-preparation",
      kind: "environment-preparation",
      path: "e2e-preparation.json",
      contentHash: sha256(preparationText),
      mediaType: "application/json",
    }),
  );
  const result = createVerificationResult(
    input,
    SINGLE_AGENT_DIFFERENTIAL_STRATEGY,
    output,
    deps.now,
  );
  const artifact = store.writeFrameworkResult(
    new TextEncoder().encode(`${JSON.stringify(result, null, 2)}\n`),
  );
  const timings = { preparationMs, agentMs, totalMs: Date.now() - startedAt };
  const timingPath = join(root, "timing.json");
  await writeFile(timingPath, `${JSON.stringify(timings, null, 2)}\n`);
  // Dataset labels stay in the Host summary, not the Agent's input or prompt.
  await writeFile(
    join(root, "benchmark.json"),
    `${JSON.stringify({ task: options.task, variant: options.variant, originals, preparationEvidencePath, timingPath, resultPath: join(artifactRoot, artifact.path) }, null, 2)}\n`,
  );
  return {
    executionMode: deps.runtime ? "injected-test" : "live",
    result,
    resultPath: join(artifactRoot, artifact.path),
    workspaceRoot: root,
    preparationEvidencePath,
    timingPath,
    timings,
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
