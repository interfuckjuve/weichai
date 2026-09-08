import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunRecorder,
  currentRunRecorder,
} from "../src/run-output/record-run.js";
import { createVerificationResult } from "../src/run-output/create-verification-result.js";
import { DIFFERENTIAL_SMOKE_STRATEGY } from "../src/strategies/smoke-differential/strategy.js";
import { writeSmokeTiming } from "./write-smoke-timing.js";
import {
  compareVerificationFields,
  expectedForOptions,
  parseArgs,
  runSmokeE2E,
} from "./run-smoke-e2e.js";
import {
  expectedVerificationFields,
  fileUploadInput,
  fileUploadTasks,
  type FileUploadTaskId,
  type ExpectedVerificationFields,
} from "./fileupload-benchmark-fixture.js";
import type {
  VerificationInput,
  VerificationResult,
  VerificationStrategyOutput,
} from "../src/schemas/verification-types.js";

const { verifyWithReceipt, createDefaultVerificationService } = vi.hoisted(
  () => ({
    verifyWithReceipt: vi.fn(),
    createDefaultVerificationService: vi.fn(),
  }),
);
const resultDirectories: string[] = [];
createDefaultVerificationService.mockImplementation(
  (options?: { workspaceRoot?: string }) => {
    if (options?.workspaceRoot)
      resultDirectories.push(dirname(options.workspaceRoot));
    return { verifyWithReceipt };
  },
);
vi.mock("../src/create-default-verifier.js", () => ({
  createDefaultVerificationService,
}));

const identifiers = {
  strategy: "differential-smoke",
  strategyVersion: "2.0.0",
  model: "fake-model",
  mode: "differential" as const,
  fixture: "multipart-read-body/correct",
};
const directories: string[] = [];
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "tv-e2e-timing-"));
  directories.push(dir);
  return dir;
}
function result(
  input: VerificationInput,
  fields: ExpectedVerificationFields,
): VerificationResult {
  const { problemCodes, ...assessment } = fields;
  const output: VerificationStrategyOutput = {
    ...assessment,
    summary: "mock",
    problems: problemCodes.map((code) => ({
      code: code as VerificationStrategyOutput["problems"][number]["code"],
      message: code,
    })),
    issues:
      fields.targetAssessment === "bug_found"
        ? [
            {
              id: "target-bug",
              kind: "behavioral-divergence",
              message: "Independent target finding",
              evidenceArtifactIds: [],
            },
          ]
        : [],
    artifacts: [],
    strategyReport: {},
  };
  return createVerificationResult(
    input,
    DIFFERENTIAL_SMOKE_STRATEGY,
    output,
    () => "2026-09-05T00:00:00.000Z",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  verifyWithReceipt.mockReset();
  createDefaultVerificationService.mockClear();
  for (const dir of [...directories.splice(0), ...resultDirectories.splice(0)])
    rmSync(dir, { recursive: true, force: true });
});

describe("FileUpload VerificationInput E2E", () => {
  it.each(Object.keys(fileUploadTasks) as FileUploadTaskId[])(
    "sends the realistic %s request through VerificationService",
    async (taskId) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      verifyWithReceipt.mockImplementationOnce(
        async (input: VerificationInput) => {
          expect(input.request.target.entity.name).toBe(
            fileUploadTasks[taskId].method,
          );
          expect(
            input.request.sourceBundle.files.some((file) =>
              file.path?.endsWith("core.py"),
            ),
          ).toBe(true);
          expect(
            input.request.targetContext.sourceFiles.some((file) =>
              file.path?.endsWith("pom.xml"),
            ),
          ).toBe(true);
          const policy = input.verificationPolicy;
          expect(policy).toBeDefined();
          expect(policy!.referenceDecision).toBe("accepted");
          expect(policy!.testBasis).toContain("Independent task requirement");
          return {
            result: result(input, expectedVerificationFields("correct")),
          };
        },
      );
      expect(
        await runSmokeE2E(["--task", taskId, "--api-key", "fake-key"]),
      ).toBe(0);
      expect(verifyWithReceipt).toHaveBeenCalledTimes(1);
    },
  );

  it("supports explicit target-only policy and compares fixed fields", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const targetOnly = {
      ...expectedVerificationFields("target-only-correct"),
      referenceReason: "manual rejection",
    };
    const targetOnlyInput = {
      ...fileUploadInput("target-only-correct"),
      verificationPolicy: {
        referenceDecision: "rejected" as const,
        reason: "manual rejection",
        testBasis: "independent requirement",
      },
    };
    verifyWithReceipt.mockResolvedValueOnce({
      result: result(targetOnlyInput, targetOnly),
    });
    expect(
      await runSmokeE2E([
        "--variant",
        "target-only-correct",
        "--reference-decision",
        "rejected",
        "--reference-reason",
        "manual rejection",
        "--test-basis",
        "independent requirement",
        "--api-key",
        "fake-key",
      ]),
    ).toBe(0);
  });

  it.each([
    ["target-only-correct", "accepted", "accepted reference"],
    ["source-count-plus-one", "accepted", "accepted source mutation"],
    ["source-count-plus-one", "rejected", "untrusted reference"],
    ["target-only-count-plus-one", "accepted", "accepted reference"],
  ] as const)(
    "rebuilds expected side assessments for %s policy overrides",
    (variant, referenceDecision, referenceReason) => {
      const parsed = parseArgs([
        "--variant",
        variant,
        "--reference-decision",
        referenceDecision,
        "--reference-reason",
        referenceReason,
        "--test-basis",
        "independent requirement",
      ]);
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      const expected = expectedForOptions(parsed);
      expect(expected.referenceDecision).toBe(referenceDecision);
      expect(expected.mode).toBe(
        referenceDecision === "accepted" ? "differential" : "target_only",
      );
      expect(expected.sourceAssessment).toBe(
        referenceDecision === "accepted"
          ? variant === "source-count-plus-one"
            ? "bug_found"
            : "no_bug_observed"
          : "not_checked",
      );
      expect(expected.targetAssessment).toBe(
        variant === "target-only-count-plus-one"
          ? "bug_found"
          : "no_bug_observed",
      );
    },
  );

  it.each(["missing-test-basis", "missing-policy"] as const)(
    "runs %s preflight without an API key",
    async (variant) => {
      vi.stubEnv("DEEPSEEK_API_KEY", "");
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      verifyWithReceipt.mockImplementationOnce(
        async (input: VerificationInput) => ({
          result: result(input, expectedVerificationFields(variant)),
        }),
      );
      expect(await runSmokeE2E(["--variant", variant])).toBe(0);
      expect(verifyWithReceipt).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects stale fixture paths and unsupported CLI combinations", () => {
    for (const args of [
      ["--fixture-dir", "old"],
      ["--task", "missing"],
      ["--task", "disk-get", "--variant", "drop-output"],
      ["--task", "disk-get", "--variant", "target-only-count-plus-one"],
      ["--reference-decision", "rejected"],
      ["--timeout-ms", "0"],
    ])
      expect(parseArgs(args)).toHaveProperty("error");
    expect(parseArgs([])).toMatchObject({
      task: "multipart-read-body",
      variant: "correct",
    });
  });

  it("rejects an unsupported strategy before requiring credentials", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runSmokeE2E(["--strategy", "unsupported"])).toBe(2);
    expect(verifyWithReceipt).not.toHaveBeenCalled();
  });
  it("requires credentials after a preflight variant gains a valid policy", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await runSmokeE2E([
        "--variant",
        "missing-policy",
        "--reference-decision",
        "rejected",
        "--reference-reason",
        "manual rejection",
        "--test-basis",
        "independent requirement",
      ]),
    ).toBe(2);
    expect(verifyWithReceipt).not.toHaveBeenCalled();
  });

  it.each(["missing-test-basis", "missing-policy"] as const)(
    "recomputes %s expectations when an explicit policy supplies the missing basis",
    (variant) => {
      const parsed = parseArgs([
        "--variant",
        variant,
        "--reference-decision",
        "accepted",
        "--reference-reason",
        "Reviewed",
        "--test-basis",
        "Independent examples",
      ]);
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) return;
      expect(expectedForOptions(parsed)).toMatchObject({
        mode: "differential",
        executionStatus: "completed",
        problemCodes: [],
        sourceAssessment: "no_bug_observed",
        targetAssessment: "no_bug_observed",
      });
    },
  );

  it("rejects orphaned policy flags and blank policy values", () => {
    for (const args of [
      ["--reference-reason", "reason"],
      ["--test-basis", "basis"],
      [
        "--reference-decision",
        "rejected",
        "--reference-reason",
        " ",
        "--test-basis",
        "basis",
      ],
      [
        "--reference-decision",
        "rejected",
        "--reference-reason",
        "reason",
        "--test-basis",
        "\t",
      ],
    ])
      expect(parseArgs(args)).toHaveProperty("error");
  });

  it("writes wrapper timing beside the report in the outer resultsRoot", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    verifyWithReceipt.mockImplementationOnce(
      async (input: VerificationInput) => ({
        result: result(input, expectedVerificationFields("correct")),
      }),
    );
    expect(await runSmokeE2E(["--api-key", "fake-key"])).toBe(0);
    const root = resultDirectories.at(-1)!;
    expect(existsSync(join(root, "report.json"))).toBe(true);
    expect(existsSync(join(root, "comparison.json"))).toBe(true);
    expect(existsSync(join(root, "timing.json"))).toBe(true);
    expect(existsSync(join(root, "timing.md"))).toBe(true);
    expect(existsSync(join(root, "workspaces", "timing.json"))).toBe(false);
  });

  it("does not treat a mismatched report as a successful comparison", () => {
    const compared = compareVerificationFields(
      expectedVerificationFields("correct"),
      result(
        fileUploadInput("target-only-correct"),
        expectedVerificationFields("target-only-correct"),
      ),
      "/tmp/report.json",
    );
    expect(compared.matched).toBe(false);
  });
});

describe("metadata-only smoke E2E timing", () => {
  it("writes dynamic Host spans and separately sourced command durations", () => {
    let clock = 100;
    const recorder = createRunRecorder({
      runId: "e2e",
      monotonicNow: () => clock,
    });
    const outer = recorder.startStep("host-wrapper", { scope: "strategy" });
    const inner = recorder.startStep("arbitrary-step", {
      scope: "strategy",
      parentId: outer!.id,
    });
    recorder.observe({
      kind: "agent-step-approximate",
      source: "host-performance",
      name: "explore",
      event: "start",
      operationId: "a1",
    });
    clock += 4;
    recorder.observe({
      kind: "agent-step-approximate",
      source: "host-performance",
      name: "explore",
      event: "end",
      operationId: "a1",
    });
    recorder.observe({
      kind: "command",
      source: "command-proxy:process-date-now",
      commandId: "c1",
      name: "source-run",
      durationMs: 3,
      exitCode: 0,
      timedOut: false,
    });
    recorder.endStep(inner, "completed");
    recorder.endStep(outer, "failed", new Error("PRIVATE-PROMPT"));
    const dir = directory();
    expect(
      writeSmokeTiming(dir, identifiers, recorder.finish(), recorder.events()),
    ).toBe(dir);
    const raw = readFileSync(join(dir, "timing.json"), "utf8");
    const timing = JSON.parse(raw);
    expect(timing.totalDurationMs).toBe(4);
    expect(timing.hostSpans.map((span: { name: string }) => span.name)).toEqual(
      ["host-wrapper", "arbitrary-step"],
    );
    expect(timing.commands[0]).toMatchObject({
      durationMs: 3,
      source: "command-proxy:process-date-now",
    });
    expect(raw).not.toContain("PRIVATE-PROMPT");
  });

  it("keeps missing telemetry explicit and output failure best-effort", () => {
    const run = createRunRecorder({ runId: "missing" }).finish();
    const dir = directory();
    writeSmokeTiming(dir, identifiers, run, []);
    expect(
      JSON.parse(readFileSync(join(dir, "timing.json"), "utf8"))
        .agentAvailability,
    ).toBe("unavailable");
    expect(
      writeSmokeTiming(join(dir, "missing"), identifiers, run, []),
    ).toBeUndefined();
  });

  it("does not expose the current recorder to a service mock outside a run", () => {
    expect(currentRunRecorder()).toBeUndefined();
  });
});
