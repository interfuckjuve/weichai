#!/usr/bin/env node
/** Real FileUpload VerificationInput requests; one official service call per invocation. */
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createDefaultVerificationService } from "../src/create-default-verifier.js";
import type { VerificationResult } from "../src/schemas/verification-types.js";
import {
  createRunRecorder,
  withRunRecorder,
} from "../src/run-output/record-run.js";
import { writeSmokeTiming } from "./write-smoke-timing.js";
import { DEFAULT_LOG_DIR } from "../src/run-output/verification-logger.js";
import {
  datasetVariants,
  expectedVerificationFields,
  fileUploadInput,
  fileUploadTasks,
  isDatasetVariant,
  isFileUploadTask,
  repositoryRoot,
  type DatasetVariant,
  type ExpectedVerificationFields,
  type FileUploadTaskId,
} from "./fileupload-benchmark-fixture.js";
import { DIFFERENTIAL_SMOKE_STRATEGY } from "../src/strategies/smoke-differential/strategy.js";

export interface SmokeE2EOptions {
  task: FileUploadTaskId;
  variant: DatasetVariant;
  apiKey?: string;
  timeoutMs: number;
  offlineOnly: boolean;
  strategyId: string;
  json: boolean;
  referenceDecision?: "accepted" | "rejected" | "undetermined";
  referenceReason?: string;
  testBasis?: string;
}

export interface VerificationComparison {
  expected: ExpectedVerificationFields;
  actual: ExpectedVerificationFields;
  matched: boolean;
  reportPath: string;
}

export interface SmokeE2EResult {
  scenario: string;
  receipt: { result: VerificationResult; resultArtifact?: unknown };
  comparison: VerificationComparison;
  reportPath: string;
  manifestPath: string;
  keptDir?: string;
}

export function parseArgs(argv: string[]): SmokeE2EOptions | { error: string } {
  const opts: SmokeE2EOptions = {
    task: "multipart-read-body",
    variant: "correct",
    timeoutMs: 300_000,
    offlineOnly: false,
    strategyId: DIFFERENTIAL_SMOKE_STRATEGY.id,
    json: false,
  };
  const valueFlags = new Set([
    "--task",
    "--variant",
    "--api-key",
    "--timeout-ms",
    "--strategy",
    "--reference-decision",
    "--reference-reason",
    "--test-basis",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (valueFlags.has(flag)) {
      const value = argv[++i];
      if (value === undefined || !value.trim() || value.startsWith("--"))
        return { error: `Missing value for ${flag}.` };
      if (flag === "--task") {
        if (!isFileUploadTask(value))
          return {
            error: `Unknown task: ${value}. Available: ${Object.keys(fileUploadTasks).join(", ")}`,
          };
        opts.task = value;
      } else if (flag === "--variant") {
        if (!isDatasetVariant(value))
          return {
            error: `Unknown variant: ${value}. Available: ${datasetVariants.join(", ")}`,
          };
        opts.variant = value;
      } else if (flag === "--api-key") opts.apiKey = value;
      else if (flag === "--strategy") opts.strategyId = value;
      else if (flag === "--reference-decision") {
        if (!["accepted", "rejected", "undetermined"].includes(value))
          return { error: `Invalid --reference-decision: "${value}".` };
        opts.referenceDecision = value as SmokeE2EOptions["referenceDecision"];
      } else if (flag === "--reference-reason") opts.referenceReason = value;
      else if (flag === "--test-basis") opts.testBasis = value;
      else if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) <= 0
      )
        return { error: `Invalid --timeout-ms: "${value}".` };
      else opts.timeoutMs = Number(value);
    } else if (flag === "--json") opts.json = true;
    else if (flag === "--offline-only") opts.offlineOnly = true;
    else if (flag !== "--verify-only")
      return { error: `Unknown option: ${flag}` };
  }
  if (
    (opts.variant === "source-count-plus-one" ||
      opts.variant === "both-count-plus-one" ||
      opts.variant === "target-only-count-plus-one" ||
      opts.variant === "count-plus-one" ||
      opts.variant === "drop-output") &&
    opts.task !== "multipart-read-body"
  )
    return {
      error:
        "Count defect variants are supported only for multipart-read-body.",
    };
  if (!opts.referenceDecision && (opts.referenceReason || opts.testBasis))
    return {
      error:
        "--reference-reason and --test-basis require --reference-decision.",
    };
  if (opts.referenceDecision && !opts.referenceReason)
    return { error: "--reference-decision requires --reference-reason." };
  if (opts.referenceDecision && !opts.testBasis)
    return { error: "--reference-decision requires --test-basis." };
  return opts;
}

export function expectedForOptions(
  opts: SmokeE2EOptions,
): ExpectedVerificationFields {
  const expected = expectedVerificationFields(opts.variant);
  if (!opts.referenceDecision) return expected;

  // An explicit Host policy changes the execution mode. Rebuild the side
  // expectations from the seeded mutation instead of carrying a contradictory
  // target-only/source-only assessment across the override.
  const sourceBug =
    opts.variant === "source-count-plus-one" ||
    opts.variant === "both-count-plus-one";
  const targetBug =
    opts.variant === "count-plus-one" ||
    opts.variant === "drop-output" ||
    opts.variant === "both-count-plus-one" ||
    opts.variant === "target-only-count-plus-one";
  const accepted = opts.referenceDecision === "accepted";
  return {
    ...expected,
    mode: accepted ? "differential" : "target_only",
    referenceDecision: opts.referenceDecision,
    referenceReason: opts.referenceReason!,
    executionStatus: "completed",
    sourceAssessment: accepted
      ? sourceBug
        ? "bug_found"
        : "no_bug_observed"
      : "not_checked",
    targetAssessment: targetBug ? "bug_found" : "no_bug_observed",
    problemCodes: [],
  };
}

function actualFields(result: VerificationResult): ExpectedVerificationFields {
  return {
    mode: result.mode,
    referenceDecision: result.referenceDecision,
    referenceReason: result.referenceReason,
    executionStatus: result.executionStatus,
    sourceAssessment: result.sourceAssessment,
    targetAssessment: result.targetAssessment,
    problemCodes: result.problems.map(({ code }) => code).sort(),
  };
}

export function compareVerificationFields(
  expected: ExpectedVerificationFields,
  result: VerificationResult,
  reportPath: string,
): VerificationComparison {
  const actual = actualFields(result);
  const matched =
    expected.mode === actual.mode &&
    expected.referenceDecision === actual.referenceDecision &&
    expected.referenceReason === actual.referenceReason &&
    expected.executionStatus === actual.executionStatus &&
    expected.sourceAssessment === actual.sourceAssessment &&
    expected.targetAssessment === actual.targetAssessment &&
    JSON.stringify(expected.problemCodes) ===
      JSON.stringify(actual.problemCodes);
  return { expected, actual, matched, reportPath };
}

export async function runSmokeE2E(argv: string[]): Promise<number> {
  if (!process.env.VERIFIER_LOG_DIR)
    process.env.VERIFIER_LOG_DIR = DEFAULT_LOG_DIR;
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`error: ${parsed.error}`);
    return 2;
  }
  if (parsed.json) process.env.VERIFIER_LOG_LEVEL = "ERROR";
  if (parsed.strategyId !== DIFFERENTIAL_SMOKE_STRATEGY.id) {
    console.error(`error: unknown smoke E2E strategy: ${parsed.strategyId}`);
    return 2;
  }
  if (parsed.offlineOnly) {
    if (!parsed.json)
      console.log(
        "跳过 smoke E2E: --offline-only 不执行真实 Agent 会话或行为验证。",
      );
    return 0;
  }
  const apiKey = parsed.apiKey ?? process.env.DEEPSEEK_API_KEY;
  const preflightOnly =
    !parsed.referenceDecision &&
    (parsed.variant === "missing-test-basis" ||
      parsed.variant === "missing-policy");
  if (!apiKey && !preflightOnly) {
    console.error("error: DEEPSEEK_API_KEY (or --api-key) is required.");
    return 2;
  }

  const recorder = createRunRecorder({ runId: randomUUID() });
  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
  const scenario = `${parsed.task}/${parsed.variant}`;
  const resultsRoot = join(
    repositoryRoot,
    "services/translation-verifier/test-results",
    `verification-${randomUUID()}`,
  );
  mkdirSync(resultsRoot, { recursive: true });
  let output: SmokeE2EResult;
  try {
    output = await withRunRecorder(recorder, async () => {
      const originalInput = fileUploadInput(parsed.variant, parsed.task);
      const input = parsed.referenceDecision
        ? {
            ...originalInput,
            verificationPolicy: {
              referenceDecision: parsed.referenceDecision,
              reason: parsed.referenceReason!,
              testBasis: parsed.testBasis!,
            },
          }
        : originalInput;
      const service = createDefaultVerificationService({
        apiKey,
        model,
        timeoutMs: parsed.timeoutMs,
        workspaceRoot: join(resultsRoot, "workspaces"),
        artifactRoot: join(resultsRoot, "artifacts"),
      });
      const receipt = await service.verifyWithReceipt(input, {
        keepWorkspace: true,
      });
      const reportPath = join(resultsRoot, "report.json");
      const manifestPath = join(resultsRoot, "comparison.json");
      writeFileSync(
        reportPath,
        `${JSON.stringify(receipt.result, null, 2)}\n`,
        "utf8",
      );
      const comparison = compareVerificationFields(
        expectedForOptions(parsed),
        receipt.result,
        reportPath,
      );
      const manifest = {
        schemaVersion: "1.0",
        scenario,
        expected: comparison.expected,
        actual: comparison.actual,
        matched: comparison.matched,
        reportPath,
      };
      writeFileSync(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      return {
        scenario,
        receipt,
        comparison,
        reportPath,
        manifestPath,
      };
    });
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  const timingRun = recorder.finish();
  if (parsed.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(
      `${scenario}: matched=${output.comparison.matched} mode=${output.comparison.actual.mode} execution=${output.comparison.actual.executionStatus} target=${output.comparison.actual.targetAssessment}`,
    );
    console.log(`Report: ${output.reportPath}`);
    console.log(`Comparison: ${output.manifestPath}`);
  }
  const timingDirectory = writeSmokeTiming(
    resultsRoot,
    {
      strategy: parsed.strategyId,
      strategyVersion: DIFFERENTIAL_SMOKE_STRATEGY.version,
      model,
      mode: output.comparison.actual.mode,
      fixture: scenario,
    },
    timingRun,
    recorder.events(),
    false,
  );
  if (!timingDirectory)
    console.error("Smoke timing unavailable; report unchanged.");
  return output.comparison.matched ? 0 : 1;
}

function isModuleEntryPoint(): boolean {
  if (typeof process.argv[1] !== "string") return false;
  const entryPath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(entryPath);
  } catch {
    return resolve(process.argv[1]) === resolve(entryPath);
  }
}
if (isModuleEntryPoint())
  process.exitCode = await runSmokeE2E(process.argv.slice(2));
