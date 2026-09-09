import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyHunksStrict, newFileContent } from "@forexplore/workflow-core";
import { prepareFileUploadProjects } from "./run-single-agent-e2e.js";
import {
  protectedSecrets,
  redact,
} from "../src/strategies/multi-agent-differential/behavior-command.js";
import { persistBehaviorArtifact } from "../src/strategies/multi-agent-differential/behavior-workspace.js";
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
  type MultiAgentDifferentialOptions,
  BehaviorFailure,
  classifyReuse,
} from "../src/strategies/multi-agent-differential/strategy.js";
import type { BehaviorRuntime } from "../src/strategies/multi-agent-differential/behavior-types.js";
import {
  fileUploadInput,
  repositoryRoot,
  sourceProjectRoot,
  targetProjectRoot,
  sha256,
  isDatasetVariant,
  isFileUploadTask,
  type DatasetVariant,
  type FileUploadTaskId,
} from "./fileupload-benchmark-fixture.js";

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
  }) => Promise<{
    command: string;
    cwd: string;
    durationMs: number;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>;
}
export interface MultiAgentE2EOptions {
  task: FileUploadTaskId;
  variant: DatasetVariant;
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
}

const valueFlags = new Set([
  "--task",
  "--variant",
  "--timeout-ms",
  "--api-key",
  "--model",
  "--effort",
]);
export function parseMultiAgentArgs(
  argv: string[],
): MultiAgentE2EOptions | { error: string } {
  const options: MultiAgentE2EOptions = {
    task: "multipart-read-body",
    variant: "correct",
    timeoutMs: 600_000,
    live: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--strategy") {
      if (argv[++i] !== MULTI_AGENT_DIFFERENTIAL_STRATEGY.id)
        return { error: "Invalid multi-agent strategy." };
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
    if (!value || value.startsWith("--"))
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
      return { error: `Invalid --timeout-ms: "${value}".` };
    else options.timeoutMs = Number(value);
  }
  if (options.live && argv.includes("--offline-only"))
    return { error: "--live and --offline-only are mutually exclusive." };
  return options;
}

async function copyFixture(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
}
function assertContained(root: string, path: string): string {
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
  return resolved;
}
async function overlay(
  root: string,
  files: { path: string; content: string }[],
): Promise<void> {
  for (const file of files) {
    const destination = assertContained(root, file.path);
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
      `error: ${error instanceof Error ? error.message : String(error)}`,
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
  const input = structuredClone(
    deps.input ?? fileUploadInput(options.variant, options.task),
  );
  if (!deps.input) {
    const analysis = input.analysisReport;
    input.analysisReport = {
      ...(analysis && typeof analysis === "object" && !Array.isArray(analysis)
        ? analysis
        : {}),
      applicability: { level: "direct" },
    };
  }
  delete input.verificationPolicy;
  assertVerificationInput(input);
  const root = resolve(
    deps.workspaceRoot ??
      join(repositoryRoot, "services/translation-verifier/test-results"),
    `multi-agent-${randomUUID()}`,
  );
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const strategyRoot = join(root, "agent");
  await mkdir(strategyRoot, { recursive: true });
  await Promise.all([
    copyFixture(sourceProjectRoot, sourceRoot),
    copyFixture(targetProjectRoot, targetRoot),
  ]);
  await overlay(sourceRoot, input.request.sourceBundle.files);
  await overlay(
    targetRoot,
    input.request.targetContext.sourceFiles
      .filter(
        (file) =>
          typeof file.path === "string" && typeof file.content === "string",
      )
      .map((file) => ({ path: file.path!, content: file.content! })),
  );
  let targetReady = false;
  let preparationEvidencePath: string | undefined;
  let preparationPromise: Promise<void> | undefined;
  const prepareTarget = async (signal: AbortSignal): Promise<void> => {
    if (!options.live) return;
    const startedAt = Date.now();
    let evidence: {
      commands?: Awaited<ReturnType<typeof prepareFileUploadProjects>>;
      command: string;
      cwd: string;
      durationMs: number;
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    };
    try {
      signal.throwIfAborted();
      const deadlineAt = context.deadlineAt;
      if (deps.prepareProjects) {
        evidence = await deps.prepareProjects({
          sourceRoot,
          targetRoot,
          deadlineAt,
          signal,
        });
      } else {
        const commands = await prepareFileUploadProjects({
          sourceRoot,
          targetRoot,
          deadlineAt,
          signal,
        });
        evidence = { ...commands.at(-1)!, commands };
      }
    } catch (error) {
      evidence = {
        command: deps.prepareProjects
          ? "injected prepareProjects"
          : "mvn -B -ntp -DskipTests test-compile",
        cwd: targetRoot,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        timedOut:
          signal.reason instanceof Error &&
          signal.reason.name === "TimeoutError",
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    const evidencePath = join(strategyRoot, "target-preparation.json");
    await writeFile(
      evidencePath,
      `${redact(JSON.stringify(evidence, null, 2), protectedSecrets(options.apiKey))}\n`,
      "utf8",
    );
    preparationEvidencePath = evidencePath;
    if (evidence.exitCode !== 0 || evidence.timedOut)
      throw new Error(
        `Target project preparation failed (exit ${evidence.exitCode ?? "unknown"}).`,
      );
  };
  const applyTarget = async (signal: AbortSignal) => {
    if (targetReady) return;
    for (const patch of input.translation.files) {
      signal.throwIfAborted();
      const path = assertContained(targetRoot, patch.path);
      if (patch.status === "created") {
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, newFileContent(patch.hunks), { flag: "wx" });
      } else {
        const original = await readFile(path, "utf8");
        if (sha256(original) !== patch.expectedOriginalSha256)
          throw new Error(
            "Target fixture hash changed before translation application.",
          );
        signal.throwIfAborted();
        await writeFile(path, applyHunksStrict(original, patch.hunks), "utf8");
      }
    }
    targetReady = true;
    preparationPromise = prepareTarget(signal);
    await preparationPromise;
  };
  const store = createVerificationArtifactStore({
    artifactRoot: deps.artifactRoot ?? join(root, "artifacts"),
    durablePrefix: "attempt-e2e",
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
    deadlineAt: Date.now() + options.timeoutMs,
    writeArtifact: store.writeArtifact,
  };
  const strategyOptions: MultiAgentDifferentialOptions = {
    runtime: deps.runtime,
    apiKey: options.apiKey,
    model: options.model,
    effort: options.effort,
    timeoutMs: options.timeoutMs,
  };
  const strategy = new MultiAgentDifferentialStrategy(strategyOptions);
  const signal = AbortSignal.timeout(options.timeoutMs);
  let output: VerificationStrategyOutput | undefined;
  let preparation: VerificationPreparation | undefined;
  try {
    // Fixture scheduling only: no Translator model is executed by this runner.
    preparationPromise = prepareTarget(signal);
    await preparationPromise;
    const { request, analysisReport, migrationPlan } = input;
    preparation =
      classifyReuse(input) === "not_applicable"
        ? undefined
        : await strategy.prepareTests(
            { request, analysisReport, migrationPlan },
            context,
            signal,
          );
    await applyTarget(signal);
    output = await strategy.verifyTranslation(
      input,
      context,
      preparation,
      signal,
    );
  } catch (cause) {
    const message = redact(
      cause instanceof Error ? cause.message : String(cause),
      protectedSecrets(options.apiKey),
    );
    const artifact = await persistBehaviorArtifact(
      context,
      "project-preparation-failure",
      { message },
    );
    const artifacts = [artifact];
    if (preparation)
      artifacts.push(
        await persistBehaviorArtifact(
          context,
          "fixture-verification-preparation",
          preparation,
        ),
      );
    output =
      cause instanceof BehaviorFailure && cause.output
        ? cause.output
        : {
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
                    : "environment_unavailable",
                message,
              },
            ],
            summary: message,
            issues: [],
            artifacts,
            strategyReport: { stage: "preparation", message },
          };
  } finally {
    await preparationPromise?.catch(() => {});
  }
  const result = createVerificationResult(
    input,
    MULTI_AGENT_DIFFERENTIAL_STRATEGY,
    output,
    deps.now,
  );
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(result, null, 2)}\n`,
  );
  const artifact = store.writeFrameworkResult(bytes);
  const resultPath = join(
    deps.artifactRoot ?? join(root, "artifacts"),
    artifact.path,
  );
  return {
    executionMode: deps.runtime ? "injected-test" : "live",
    result,
    resultPath,
    workspaceRoot: root,
    targetReady,
    preparationEvidencePath,
  };
}

if (process.argv[1]?.endsWith("run-multi-agent-e2e.ts"))
  process.exitCode = await runMultiAgentE2E(process.argv.slice(2));
