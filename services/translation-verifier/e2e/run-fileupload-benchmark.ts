#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { VerificationService } from "../src/verification-service.js";
import { VerificationStrategyFactory } from "../src/verification-strategy-factory.js";
import { measureVerification } from "../src/verification-timing.js";
import { createDifferentialSmokeProvider } from "../src/strategies/differential-smoke/strategy.js";
import { spawnClaudeProcess } from "../src/strategies/differential-smoke/claude-client.js";
import {
  readCommandEvidence,
  runSmoke,
  type SmokeResult,
} from "../src/strategies/differential-smoke/runner.js";
import {
  fileUploadInput,
  repositoryRoot,
  sha256,
  variants,
  type Variant,
} from "./fileupload-benchmark-fixture.js";

const { values } = parseArgs({
  options: {
    variant: { type: "string", default: "count-plus-one" },
    "timeout-ms": { type: "string", default: "600000" },
    output: { type: "string" },
  },
});
if (!variants.includes(values.variant as Variant))
  throw new Error(`Unknown variant: ${values.variant}`);
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
const input = fileUploadInput(values.variant as Variant);
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
        agentCwd = options?.workspaceDir;
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
const report = smoke?.report;
const claimedBugCases =
  report?.cases?.filter((item) => item.decision === "translation-bug") ?? [];
const summary = {
  schemaVersion: "1.0",
  reportReadyAt,
  variant: values.variant,
  boundary:
    "VerificationService.verifyWithReceipt entry to promise resolution after receipt persistence and keepWorkspace cleanup policy",
  configuration: {
    strategy: "differential-smoke@1.0.0",
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
      ({ path, contentHash }) => ({ path, contentHash }),
    ),
    targetFiles: input.request.targetContext.sourceFiles.map(
      ({ path, contentHash }) => ({ path, contentHash }),
    ),
    requirementHash: sha256(input.request.requirement),
  },
  detection: {
    expectedTargetDefect: values.variant !== "correct",
    reportGenerated: !!report?.cases,
    serviceStatus: measured.value.result.status,
    agentClaimedBug: report?.cases ? claimedBugCases.length > 0 : null,
    claimedCaseIds: claimedBugCases.map((item) => item.caseId),
    independentlyConfirmed: null,
    classification:
      measured.value.result.status === "unverified"
        ? "unverified"
        : "pending-independent-replay",
    note: "Report status and matching command IDs alone do not prove the seeded defect was exposed. Replay generated tests against mutant and corrected control before crediting detection.",
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
process.exitCode = measured.value.result.status === "unverified" ? 1 : 0;
