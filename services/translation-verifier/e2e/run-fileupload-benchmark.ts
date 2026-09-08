#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { VerificationService } from "../src/verification-service.js";
import { VerificationStrategyFactory } from "../src/workflow/select-strategy.js";
import { measureVerification } from "../src/run-output/measure-legacy-run.js";
import { createDifferentialSmokeProvider } from "../src/strategies/smoke-differential/strategy.js";
import { spawnClaudeProcess } from "../src/strategies/smoke-differential/claude-session.js";
import {
  readCommandEvidence,
  runSmoke,
  type SmokeResult,
} from "../src/strategies/smoke-differential/run-smoke-verification.js";
import { compareVerificationFields } from "./run-smoke-e2e.js";
import {
  expectedVerificationFields,
  fileUploadInput,
  repositoryRoot,
  sha256,
  variants,
  fileUploadTasks,
  isFileUploadTask,
  type Variant,
} from "./fileupload-benchmark-fixture.js";

const { values } = parseArgs({
  options: {
    task: { type: "string", default: "multipart-read-body" },
    variant: { type: "string", default: "correct" },
    "timeout-ms": { type: "string", default: "600000" },
    output: { type: "string" },
  },
});
if (!variants.includes(values.variant as Variant))
  throw new Error(`Unknown variant: ${values.variant}`);
if (!isFileUploadTask(values.task))
  throw new Error(`Unknown task: ${values.task}`);
if (values.task !== "multipart-read-body" && values.variant !== "correct")
  throw new Error(
    "Defect variants are supported only for multipart-read-body.",
  );
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
  throw new Error("Invalid timeout-ms");
if (!process.env.DEEPSEEK_API_KEY)
  throw new Error("DEEPSEEK_API_KEY is required");
process.env.VERIFIER_LOG_LEVEL = "ERROR";
const output = resolve(
  values.output ??
    join(
      repositoryRoot,
      "services/translation-verifier/test-results",
      `fileupload-${Date.now()}`,
    ),
);
mkdirSync(output, { recursive: true });
const preparedAt = performance.now();
const input = fileUploadInput(values.variant as Variant, values.task);
const inputPreparationMs = performance.now() - preparedAt;
let smoke: SmokeResult | undefined;
let commands: ReturnType<typeof readCommandEvidence> = [];
let hooks = "";
let effortObserved: string | undefined;
let agentCwd: string | undefined;
const service = new VerificationService({
  factory: new VerificationStrategyFactory([
    createDifferentialSmokeProvider({
      effort: "high",
      timeoutMs,
      maxTurns: 40,
      spawnClaude: (args, env, timeout, options) => {
        effortObserved = options?.effort;
        if (effortObserved !== "high")
          throw new Error("Benchmark requires explicit effort=high");
        return spawnClaudeProcess(args, env, timeout, options);
      },
      runSmokeImpl: async (job, options, signal) => {
        agentCwd = options.layout.agentDir;
        smoke = await runSmoke(job, options, signal);
        return smoke;
      },
    }),
  ]),
  defaultStrategyId: "differential-smoke",
  workspaceRoot: join(output, "workspaces"),
  artifactRoot: join(output, "artifacts"),
  timeoutMs: timeoutMs + 10000,
});
// Retain this diagnostic workspace; keepWorkspace policy is part of the recorded boundary.
const measured = await measureVerification(() =>
  service.verifyWithReceipt(input, { keepWorkspace: true }),
);
const reportReadyAt = new Date().toISOString();
if (agentCwd) {
  commands = readCommandEvidence(join(agentCwd, "commands.jsonl"));
  try {
    hooks = readFileSync(join(agentCwd, "claude-steps.jsonl"), "utf8");
  } catch {
    /* No successful tools on early failure. */
  }
}
const reportPath = join(output, "report.json");
writeFileSync(
  reportPath,
  `${JSON.stringify(measured.value.result, null, 2)}\n`,
);
const comparison = compareVerificationFields(
  expectedVerificationFields(values.variant as Variant),
  measured.value.result,
  reportPath,
);
writeFileSync(
  join(output, "comparison.json"),
  `${JSON.stringify(
    {
      schemaVersion: "1.0",
      scenario: `${values.task}/${values.variant}`,
      expected: comparison.expected,
      actual: comparison.actual,
      matched: comparison.matched,
      reportPath,
    },
    null,
    2,
  )}\n`,
);
const summary = {
  schemaVersion: "1.0",
  reportReadyAt,
  task: values.task,
  symbol: `${fileUploadTasks[values.task].container}.${fileUploadTasks[values.task].method}`,
  variant: values.variant,
  boundary:
    "VerificationService.verifyWithReceipt entry to promise resolution after receipt persistence and keepWorkspace cleanup policy",
  configuration: {
    strategy: "differential-smoke@2.0.0",
    mode: "verify-only",
    effortRequested: "high",
    effortObserved,
    providerEffortAcknowledged: false,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
    maxTurns: 40,
    timeoutMs,
    keepWorkspace: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cacheState: "uncontrolled-warm; no cache cleared",
    route: "python -> java",
  },
  inputPreparationMs,
  timing: measured.timing,
  identity: {
    patchHash: input.translation.patchHash,
    sourceFiles: input.request.sourceBundle.files.map(
      ({ path, contentHash }) => ({
        path,
        contentHash,
      }),
    ),
    targetFiles: input.request.targetContext.sourceFiles.map(
      ({ path, contentHash }) => ({
        path,
        contentHash,
      }),
    ),
    requirementHash: sha256(input.request.requirement),
  },
  detection: {
    expected: comparison.expected,
    actual: comparison.actual,
    matched: comparison.matched,
    reportPath,
    note: "Only fixed report fields are compared automatically. Human review must assess findings, attribution and execution evidence in report.json.",
  },
  commands,
  receipt: measured.value,
  smoke,
  agentCwd,
};
writeFileSync(
  join(output, "measurement.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
writeFileSync(join(output, "claude-steps.jsonl"), hooks);
console.log(
  JSON.stringify(
    {
      output,
      ...summary.detection,
      totalMs: measured.timing.totalMs,
      phases: measured.timing.phases,
    },
    null,
    2,
  ),
);
process.exitCode = comparison.matched ? 0 : 1;
