import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failureAssessment } from "../../schemas/verification-assessment.js";
import {
  acceptedPolicy,
  validAssessment,
  validCommandEvidence,
  validSmokeCase,
  validSmokeReport,
} from "./differential-test-fixtures.js";
import * as recording from "../../run-output/record-run.js";
import { assertVerificationRun } from "../../schemas/validate-verification-run.js";
import { runSmoke, type SmokeResult } from "./run-smoke-verification.js";
import { createDefaultVerificationService } from "../../create-default-verifier.js";
import {
  DIFFERENTIAL_SMOKE_STRATEGY,
  DifferentialSmokeStrategy,
  type RunSmokeImpl,
} from "./strategy.js";
import * as smokePreflight from "./prepare-smoke-input.js";
import * as smokeWorkspace from "./prepare-projects.js";
import type {
  VerificationArtifact,
  VerificationInput,
  VerificationStrategyContext,
} from "../../schemas/verification-types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-differential-smoke-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("DifferentialSmokeStrategy", () => {
  it.each([
    [10_000, 5000],
    [500, 1500],
    [undefined, 5000],
  ] as const)(
    "propagates the absolute Host/session deadline unchanged (timeout=%s)",
    async (timeoutMs, expected) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      const workspace = context();
      workspace.deadlineAt = 5000;
      const spawnClaude = vi.fn(async (_args, env, _timeout, options) => {
        expect(options.deadlineAt).toBe(expected);
        expect(env.VERIFIER_DEADLINE_AT).toBe(String(expected));
        writeFileSync(
          join(options.cwd, "report.json"),
          JSON.stringify(validSmokeReport()),
        );
        writeFileSync(
          join(options.cwd, "commands.jsonl"),
          validCommandEvidence()
            .map((entry) => JSON.stringify(entry))
            .join("\n"),
        );
        return { stdout: "done", exitCode: 0 };
      });
      const runSmokeImpl: RunSmokeImpl = async (job, options, signal) => {
        expect(options.deadlineAt).toBe(expected);
        clock.mockReturnValue(1200);
        return runSmoke(job, options, signal);
      };
      const result = await new DifferentialSmokeStrategy({
        timeoutMs,
        runSmokeImpl,
        spawnClaude,
        apiKey: "test",
      }).verify(input(), workspace);
      expect(result.executionStatus).toBe("completed");
      expect(spawnClaude).toHaveBeenCalledOnce();
    },
  );
  it("keeps a caller-owned wrapper occurrence running while recording private smoke steps", async () => {
    const recorder = recording.createRunRecorder({
      runId: "legacy-strategy-caller",
    });
    const handle = recorder.startStep("run-smoke", { scope: "strategy" });
    const strategy = new DifferentialSmokeStrategy({
      runSmokeImpl: async () => ({
        ...validAssessment(),
        summary: "same",
        durationMs: 0,
        report: validSmokeReport(),
      }),
    });
    const output = await recording.withRunRecorder(recorder, () =>
      strategy.verify(input(), context()),
    );
    expect(output.targetAssessment).toBe("no_bug_observed");
    expect(
      recorder.snapshot().stages.find((step) => step.id === handle!.id)?.state,
    ).toBe("running");
    const smoke = recorder
      .snapshot()
      .stages.filter((step) => step.name === "run-smoke");
    expect(smoke.map((step) => step.state)).toEqual(["running", "completed"]);
    expect(smoke[0].id).not.toBe(smoke[1].id);
    recorder.endStep(handle, "completed");
    expect(recorder.finish().diagnostics).toEqual([]);
  });

  it("publishes a structured failure artifact for an absent report", async () => {
    const workspace = context();
    const result = await new DifferentialSmokeStrategy({
      runSmokeImpl: async () => ({
        ...failureAssessment(input(), "report_missing", "Report absent"),
        summary: "Report absent",
        report: null,
        durationMs: 0,
      }),
    }).verify(input(), workspace);
    expect(result.strategyReport).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: "report_missing" }),
    ]);
    expect(
      JSON.parse(
        readFileSync(
          join(
            workspace.workspace.strategyRoot,
            "reports/differential-smoke-report.json",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      executionStatus: "failed",
      problems: [{ code: "report_missing" }],
    });
  });

  it.each(["completed", "partial"] as const)(
    "retains source-only findings during %s execution",
    async (executionStatus) => {
      const report = validSmokeReport({
        cases: [validSmokeCase({ sourceAssessment: "bug_found" })],
      });
      const result = await new DifferentialSmokeStrategy({
        runSmokeImpl: async () => ({
          ...validAssessment(),
          sourceAssessment: "bug_found",
          executionStatus,
          problems:
            executionStatus === "partial"
              ? [
                  {
                    code: "command_timeout",
                    message: "Later command timed out",
                  },
                ]
              : [],
          summary: "Source finding only",
          report,
          bugCases: [],
          durationMs: 0,
        }),
      }).verify(input(), context());
      expect(result).toMatchObject({
        executionStatus,
        sourceAssessment: "bug_found",
        targetAssessment: "no_bug_observed",
      });
      expect(
        result.issues.filter((item) => item.kind === "source-bug"),
      ).toHaveLength(1);
      expect(
        result.issues.some((item) => item.kind === "behavioral-divergence"),
      ).toBe(false);
      expect(result).not.toHaveProperty("status");
    },
  );

  it("maps the existing smoke result into strategy output", async () => {
    const prepare = vi.spyOn(smokePreflight, "prepareSmokeInput");
    const prepareLayout = vi.spyOn(
      smokeWorkspace,
      "prepareCallerOwnedWorkspace",
    );
    const report = validSmokeReport({
      cases: [validSmokeCase({ targetAssessment: "bug_found" })],
    });
    const fakeRunSmoke = vi.fn(
      async () =>
        ({
          ...validAssessment("bug_found"),
          summary: "1/1 translation bug",
          durationMs: 10,
          report,
          bugCases: report.cases,
        }) satisfies SmokeResult,
    );
    const workspace = context();
    const strategy = new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
    });

    const result = await strategy.verify(input(), workspace);

    expect(fakeRunSmoke).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepareLayout).toHaveBeenCalledOnce();
    const preflight = prepare.mock.results[0].value;
    if (!preflight.applicable) throw new Error("Expected prepared job");
    expect(fakeRunSmoke).toHaveBeenCalledWith(
      preflight.job,
      expect.objectContaining({ layout: prepareLayout.mock.results[0].value }),
      undefined,
    );
    const call = vi.mocked<RunSmokeImpl>(fakeRunSmoke).mock.calls[0];
    expect(call[0]).toBe(preflight.job);
    expect(call[1].layout).toBe(prepareLayout.mock.results[0].value);
    expect(result).not.toHaveProperty("strategyId");
    expect(result.targetAssessment).toBe("bug_found");
    expect(result.issues[0]).toMatchObject({
      kind: "behavioral-divergence",
      caseId: "c1",
    });
    expect(result.strategyReport).toEqual(report);
    expect(result.artifacts).toHaveLength(1);
    expect(workspace.writeArtifact).toHaveBeenCalledOnce();
    expect(
      readFileSync(
        join(
          workspace.workspace.strategyRoot,
          "reports",
          "differential-smoke-report.json",
        ),
        "utf8",
      ),
    ).toContain("translation-bug");
  });

  it("maps smoke pass to pass", async () => {
    const report = validSmokeReport();
    const fakeRunSmoke = vi.fn(
      async () =>
        ({
          ...validAssessment(),
          summary: "1/1 case passed",
          durationMs: 10,
          passRate: 1,
          report,
          bugCases: [],
        }) satisfies SmokeResult,
    );

    const result = await new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
    }).verify(input(), context());

    expect(result.targetAssessment).toBe("no_bug_observed");
    expect(result.issues).toEqual([]);
  });

  it("maps smoke error to unverified", async () => {
    const fakeRunSmoke = vi.fn(
      async () =>
        ({
          ...failureAssessment(
            { verificationPolicy: acceptedPolicy },
            "report_invalid_json",
            "invalid JSON",
          ),

          summary: "report.json is invalid",
          durationMs: 10,
          report: null,
        }) satisfies SmokeResult,
    );

    const result = await new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
    }).verify(input(), context());

    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.issues[0]).toMatchObject({ kind: "report_invalid_json" });
  });

  it("returns canonical insufficient-context for analysis unresolved without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;
    const result = await new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
    }).verify(
      inputWithContext({
        analysisReport: { unresolved: ["dependency mapping"] },
      }),
      context(),
    );
    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      executionStatus: "failed",
      artifacts: [],
      issues: [
        {
          id: "insufficient-context",
          kind: "insufficient-context",
          evidenceArtifactIds: [],
        },
      ],
    });
    expect(result.strategyReport).toEqual({
      preflight: {
        status: "insufficient-context",
        reasons: [{ code: "unresolved", fields: ["analysisReport"] }],
      },
    });
  });

  it("returns canonical insufficient-context for migration plan unresolved without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;
    const result = await new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
    }).verify(
      inputWithContext({ migrationPlan: { unresolved: ["build command"] } }),
      context(),
    );
    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result.issues[0]).toMatchObject({
      id: "insufficient-context",
      kind: "insufficient-context",
    });
  });

  it("returns canonical insufficient-context for declared dependencies without build facts without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;
    const result = await new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
    }).verify(
      inputWithContext({ sourceBundle: { dependencyIds: ["dep-1"] } }),
      context(),
    );
    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result.issues[0]).toMatchObject({
      id: "insufficient-context",
      kind: "insufficient-context",
    });
  });

  it("calls runSmoke for self-contained supported input after unsupported-language precedence", async () => {
    const fakeRunSmoke = vi.fn(
      async () =>
        ({
          ...validAssessment(),
          summary: "ok",
          durationMs: 1,
          report: validSmokeReport(),
          bugCases: [],
        }) satisfies SmokeResult,
    );
    await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(
      input(),
      context(),
    );
    expect(fakeRunSmoke).toHaveBeenCalledOnce();
  });
  it("returns unverified for unsupported language IDs without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;

    const result = await new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
    }).verify(input({ sourceLanguageId: "go" }), context());

    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.summary).toMatch(/unsupported/i);
  });

  it("passes caller-owned workspace paths and staged roots to runSmoke", async () => {
    const fakeRunSmoke = vi.fn(
      async () =>
        ({
          ...validAssessment(),
          summary: "ok",
          durationMs: 10,
          report: validSmokeReport(),
          bugCases: [],
        }) satisfies SmokeResult,
    );
    const workspace = context();

    await new DifferentialSmokeStrategy({
      runSmokeImpl: fakeRunSmoke,
      apiKey: "k",
      model: "m",
      timeoutMs: 123,
    }).verify(input(), workspace);

    expect(fakeRunSmoke).toHaveBeenCalledWith(
      expect.objectContaining({
        requirement: "Keep behavior identical.",
        analysisReport: JSON.stringify({ confidence: "high" }),
        source: expect.objectContaining({
          language: "Java",
          root: workspace.workspace.sourceRoot,
          candidatePath: "src/Source.java",
        }),
        target: expect.objectContaining({
          language: "C#",
          root: workspace.workspace.targetRoot,
          file: "src/Target.cs",
          className: "Target",
          method: "convert",
          isStatic: true,
        }),
      }),
      expect.objectContaining({
        layout: expect.objectContaining({
          agentDir: workspace.workspace.strategyRoot,
          executionRoot: workspace.workspace.root,
          baselinePath: join(workspace.workspace.root, "baseline.json"),
          evidencePath: join(
            workspace.workspace.strategyRoot,
            "commands.jsonl",
          ),
          runnerRoots: ["source/.forexplore-tests", "target/.forexplore-tests"],
        }),
        deadlineAt: expect.any(Number),
        apiKey: "k",
        model: "m",
      }),
      undefined,
    );
    expect(
      existsSync(join(workspace.workspace.root, "source", ".forexplore-tests")),
    ).toBe(true);
    expect(
      existsSync(join(workspace.workspace.root, "target", ".forexplore-tests")),
    ).toBe(true);
    expect(existsSync(join(workspace.workspace.root, "baseline.json"))).toBe(
      true,
    );
  });
});

describe("createDefaultVerificationService", () => {
  it.each(["success", "cancelled"])(
    "keeps delegated real smoke stages owned by its wrapper through %s postprocessing",
    async (outcome) => {
      const recorder = vi.spyOn(recording, "createRunRecorder");
      let enterPostprocessing!: () => void;
      let release!: () => void;
      let finishWrapper!: () => void;
      const postprocessing = new Promise<void>((resolve) => {
        enterPostprocessing = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const wrapperFinished = new Promise<void>((resolve) => {
        finishWrapper = resolve;
      });
      const controller = new AbortController();
      const cancellation = new DOMException(
        "cancelled during wrapper postprocessing",
        "AbortError",
      );
      const service = createDefaultVerificationService({
        workspaceRoot: join(root, "workspaces"),
        artifactRoot: join(root, "artifacts"),
        apiKey: "test",
        spawnClaude: async (_args, _env, _timeout, options) => {
          writeFileSync(
            join(options!.cwd!, "report.json"),
            JSON.stringify(validSmokeReport()),
          );
          writeFileSync(
            join(options!.cwd!, "commands.jsonl"),
            validCommandEvidence()
              .map((item) => JSON.stringify(item))
              .join("\n"),
          );
          return { stdout: "done", exitCode: 0 };
        },
        runSmokeImpl: async (...args) =>
          recording.measureStep("run-agent-session", async () => {
            try {
              const result = await runSmoke(...args);
              enterPostprocessing();
              await released;
              args[2]?.throwIfAborted();
              return result;
            } finally {
              finishWrapper();
            }
          }),
      });
      const pending = service.verifyWithReceipt(input(), {}, controller.signal);
      try {
        await postprocessing;
        const during = recorder.mock.results[0]!.value.snapshot();
        if (outcome === "cancelled") {
          controller.abort(cancellation);
          await expect(pending).resolves.toMatchObject({
            result: {
              executionStatus: "cancelled",
              targetAssessment: "inconclusive",
            },
          });
        } else {
          release();
          expect((await pending).result.targetAssessment).toBe(
            "no_bug_observed",
          );
        }
        const sessions = during.stages.filter(
          (step: { name: string }) => step.name === "run-agent-session",
        );
        expect(sessions.map((step: { state: string }) => step.state)).toEqual([
          "running",
          "completed",
        ]);
        expect(sessions[0]).not.toHaveProperty("endedAt");
        expect(sessions[1]).toHaveProperty("durationMs");
        expect(sessions[1].parentId).toBe(sessions[0].id);
        expect(
          during.stages.find(
            (step: { name: string }) => step.name === "evaluate-evidence",
          )?.state,
        ).toBe("completed");
        expect(during.diagnostics).toEqual([
          {
            code: "agent-telemetry-missing",
            message:
              "No live Agent task markers were observed; task timing is unavailable.",
          },
        ]);
        const run = assertVerificationRun(
          recorder.mock.results[0]!.value.snapshot(),
        );
        expect(
          run.stages.find((step) => step.name === "execute-strategy")?.state,
        ).toBe(outcome === "cancelled" ? "cancelled" : "completed");
        expect(
          run.stages.find((step) => step.id === sessions[1].id)?.state,
        ).toBe("completed");
        if (outcome === "cancelled") {
          // The non-cooperative wrapper has not returned: never synthesize its end or duration.
          expect(
            run.stages.find((step) => step.id === sessions[0].id),
          ).not.toHaveProperty("durationMs");
          expect(
            run.diagnostics
              .filter((item) => item.code !== "agent-telemetry-missing")
              .every((item) => item.code === "stage-missing-end"),
          ).toBe(true);
          expect(
            run.diagnostics.some((item) => item.code === "stage-missing-end"),
          ).toBe(true);
          expect(
            run.diagnostics.filter(
              (item) => item.code === "agent-telemetry-missing",
            ),
          ).toEqual(during.diagnostics);
        } else {
          expect(run.stages.every((step) => step.state === "completed")).toBe(
            true,
          );
          expect(run.diagnostics).toEqual(during.diagnostics);
        }
        release();
        await wrapperFinished;
        await Promise.resolve();
        expect(recorder.mock.results[0]!.value.snapshot()).toEqual(run);
      } finally {
        release();
        await wrapperFinished;
        await pending.catch(() => {});
      }
    },
  );

  it.each([
    "timeout",
    "cancel",
    "cancel-error",
    "cancel-string",
    "cancel-timeout",
  ] as const)(
    "retains real smoke findings and artifacts after the outer %s signal",
    async (origin) => {
      const controller = new AbortController();
      const timeoutController = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(
        timeoutController.signal,
      );
      const report = validSmokeReport({
        cases: [validSmokeCase({ targetAssessment: "bug_found" })],
      });
      const service = createDefaultVerificationService({
        workspaceRoot: join(root, "workspaces"),
        artifactRoot: join(root, "artifacts"),
        apiKey: "test",
        spawnClaude: async (_args, _env, _timeout, options) => {
          writeFileSync(
            join(options!.cwd!, "report.json"),
            JSON.stringify(report),
          );
          writeFileSync(
            join(options!.cwd!, "commands.jsonl"),
            validCommandEvidence(report)
              .map((item) => JSON.stringify(item))
              .join("\n"),
          );
          setTimeout(() => {
            if (origin === "timeout")
              timeoutController.abort(
                new DOMException(
                  "The operation was aborted due to timeout",
                  "TimeoutError",
                ),
              );
            else if (origin === "cancel-error")
              controller.abort(new Error("caller stopped"));
            else if (origin === "cancel-string")
              controller.abort("caller stopped");
            else if (origin === "cancel-timeout")
              controller.abort(
                new DOMException("caller stopped", "TimeoutError"),
              );
            else controller.abort();
          }, 0);
          await new Promise<void>((resolve) =>
            options!.signal!.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw options!.signal!.reason;
        },
      });
      const receipt = await service.verifyWithReceipt(
        input(),
        {},
        controller.signal,
      );
      expect(receipt.result).toMatchObject({
        executionStatus: origin === "timeout" ? "partial" : "cancelled",
        targetAssessment: "bug_found",
        problems: expect.arrayContaining([
          {
            code: origin === "timeout" ? "agent_timeout" : "cancelled",
            message: expect.any(String),
          },
        ]),
        strategyReport: report,
      });
      expect(receipt.result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "behavioral-divergence",
            caseId: "c1",
          }),
        ]),
      );
      const artifact = receipt.result.artifacts[0];
      expect(
        JSON.parse(
          readFileSync(join(root, "artifacts", artifact.path), "utf8"),
        ),
      ).toEqual(report);
      expect(
        JSON.parse(
          readFileSync(
            join(root, "artifacts", receipt.resultArtifact!.path),
            "utf8",
          ),
        ),
      ).toEqual(receipt.result);
    },
  );

  it.each(["valid", "missing-report", "changed-baseline"])(
    "records actual default smoke boundaries for %s evidence",
    async (kind) => {
      const recorder = vi.spyOn(recording, "createRunRecorder");
      const spawnClaude: NonNullable<
        ConstructorParameters<typeof DifferentialSmokeStrategy>[0]
      >["spawnClaude"] = async (_args, env, _timeout, options) => {
        const run = recording.currentRunRecorder()!.snapshot();
        expect(
          run.stages.find((step) => step.name === "run-agent-session")?.state,
        ).toBe("running");
        expect(
          run.stages.find((step) => step.name === "build-test-task")?.state,
        ).toBe("completed");
        await new Promise((resolve) => setTimeout(resolve, 3));
        expect(existsSync(env.VERIFIER_BASELINE_PATH!)).toBe(true);
        if (kind !== "missing-report")
          writeFileSync(
            join(options!.cwd!, "report.json"),
            JSON.stringify(validSmokeReport()),
          );
        writeFileSync(
          join(options!.cwd!, "commands.jsonl"),
          validCommandEvidence()
            .map((item) => JSON.stringify(item))
            .join("\n"),
        );
        if (kind === "changed-baseline")
          writeFileSync(
            join(env.VERIFIER_WORKSPACE_ROOT!, "target/project/src/Target.cs"),
            "changed",
          );
        return { stdout: "done", exitCode: 0 };
      };
      const service = createDefaultVerificationService({
        workspaceRoot: join(root, "workspaces"),
        artifactRoot: join(root, "artifacts"),
        apiKey: "test",
        spawnClaude,
      });
      const receipt = await service.verifyWithReceipt(input());
      expect(receipt.result.executionStatus).toBe(
        kind === "valid" ? "completed" : "failed",
      );
      const run = assertVerificationRun(
        recorder.mock.results[0]!.value.snapshot(),
      );
      expect(
        run.stages.find((step) => step.name === "evaluate-evidence")?.state,
      ).toBe(kind === "valid" ? "completed" : "failed");
      const privateNames = [
        "check-applicability",
        "prepare-projects-and-baseline",
        "build-smoke-input",
        "run-smoke",
        "build-test-task",
        "run-agent-session",
        "evaluate-evidence",
        "persist-strategy-report",
        "map-strategy-result",
      ];
      expect(
        run.stages
          .filter((step) => step.scope === "strategy")
          .map((step) => step.name),
      ).toEqual(privateNames);
      for (const name of privateNames) {
        const step = run.stages.find((step) => step.name === name)!;
        expect(step.startedAt).toBeDefined();
        expect(step.endedAt).toBeDefined();
        expect(step.durationMs).toBeGreaterThanOrEqual(0);
        expect(step.parentId).toBeDefined();
      }
      expect(
        run.stages.find((step) => step.name === "run-agent-session")!
          .durationMs,
      ).toBeGreaterThan(0);
      expect(
        run.stages.find((step) => step.name === "run-smoke")!.durationMs,
      ).toBeGreaterThanOrEqual(
        run.stages.find((step) => step.name === "run-agent-session")!
          .durationMs!,
      );
      expect(
        (
          receipt.result.strategyReport as unknown as SmokeResult["report"]
        )?.executions?.map((entry) => entry.durationMs),
      ).toEqual(kind === "missing-report" ? undefined : [10, 10, 10, 10]);
      expect(run.diagnostics).toEqual([
        {
          code: "agent-telemetry-missing",
          message:
            "No live Agent task markers were observed; task timing is unavailable.",
        },
      ]);
      expect(receipt.resultArtifact).toBeDefined();
    },
  );

  it("stops unsupported smoke applicability before baseline, runner or Agent work", async () => {
    const recorders = vi.spyOn(recording, "createRunRecorder");
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;
    const workspaceRoot = join(root, "workspaces");
    const receipt = await createDefaultVerificationService({
      workspaceRoot,
      artifactRoot: join(root, "artifacts"),
      runSmokeImpl: fakeRunSmoke,
    }).verifyWithReceipt(input({ sourceLanguageId: "go" }));
    expect(receipt.result.issues[0]?.kind).toBe("unsupported-language");
    expect(receipt.resultArtifact).toBeDefined();
    expect(fakeRunSmoke).not.toHaveBeenCalled();
    const run = assertVerificationRun(
      recorders.mock.results[0]!.value.snapshot(),
    );
    expect(
      run.stages
        .filter((step) => step.scope === "strategy")
        .map((step) => step.name),
    ).toEqual(["check-applicability"]);
    expect(run.diagnostics).toEqual([]);
  });

  it("registers differential-smoke as the default strategy", () => {
    const service = createDefaultVerificationService({
      runSmokeImpl: vi.fn() as RunSmokeImpl,
    });

    expect(service.listStrategies()).toEqual([DIFFERENTIAL_SMOKE_STRATEGY]);
  });
});

function input(
  overrides: { sourceLanguageId?: string; targetLanguageId?: string } = {},
): VerificationInput {
  const files: FilePatch[] = [
    {
      path: "src/Target.cs",
      status: "modified",
      expectedOriginalSha256: sha256(
        'class Target { string convert() => "old"; }\n',
      ),
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,1 +1,1 @@",
          lines: [
            {
              type: "remove",
              content: 'class Target { string convert() => "old"; }',
            },
            {
              type: "add",
              content: 'class Target { static string convert() => "new"; }',
            },
          ],
        },
      ],
    },
  ];

  return {
    verificationPolicy: acceptedPolicy,
    schemaVersion: "1.0",
    request: request(overrides),
    analysisReport: { confidence: "high" },
    migrationPlan: { steps: [] },
    translation: {
      round: 1,
      generatedContent: 'class Target { static string convert() => "new"; }\n',
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

function request(overrides: {
  sourceLanguageId?: string;
  targetLanguageId?: string;
}): AdaptationRequestV2 {
  const sourceLanguageId = overrides.sourceLanguageId ?? "java";
  const targetLanguageId = overrides.targetLanguageId ?? "csharp";
  return {
    route: { sourceLanguageId, targetLanguageId },
    target: {
      entity: {
        languageId: targetLanguageId,
        name: "convert",
        qualifiedName: "Target.convert",
        path: "src/Target.cs",
      },
    },
    candidate: {
      entity: {
        languageId: sourceLanguageId,
        name: "convert",
        qualifiedName: "Source.convert",
        path: "src/Source.java",
      },
    },
    sourceBundle: {
      files: [
        {
          path: "src/Source.java",
          content: 'class Source { String convert() { return "new"; } }\n',
          contentHash: sha256(
            'class Source { String convert() { return "new"; } }\n',
          ),
        },
      ],
    },
    targetContext: {
      sourceFiles: [
        {
          path: "src/Target.cs",
          content: 'class Target { string convert() => "old"; }\n',
          contentHash: sha256('class Target { string convert() => "old"; }\n'),
          attributes: {},
        },
      ],
      declarations: [
        {
          role: "declaration",
          path: "src/Target.cs",
          contentHash: sha256("declaration"),
          attributes: { containerName: "Target", isStatic: true },
        },
      ],
      containers: [],
    },
    requirement: "Keep behavior identical.",
  } as unknown as AdaptationRequestV2;
}

function inputWithContext(
  overrides: Record<string, unknown>,
): VerificationInput {
  const value = input() as unknown as Record<string, unknown>;
  const requestValue = value.request as Record<string, unknown>;
  const requestOverrides = Object.fromEntries(
    Object.entries(overrides).filter(
      ([key]) => key === "sourceBundle" || key === "targetContext",
    ),
  );
  for (const key of ["sourceBundle", "targetContext"] as const) {
    if (requestOverrides[key])
      requestOverrides[key] = {
        ...(requestValue[key] as Record<string, unknown>),
        ...(requestOverrides[key] as Record<string, unknown>),
      };
  }
  return {
    ...value,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => key !== "sourceBundle" && key !== "targetContext",
      ),
    ),
    request: { ...requestValue, ...requestOverrides },
  } as unknown as VerificationInput;
}

function context(): VerificationStrategyContext {
  const workspaceRoot = mkdtempSync(join(root, "workspace-"));
  const strategyRoot = join(workspaceRoot, "agent");
  const sourceRoot = join(workspaceRoot, "source", "project");
  const targetRoot = join(workspaceRoot, "target", "project");
  for (const directory of [strategyRoot, sourceRoot, targetRoot])
    mkdirSync(directory, { recursive: true });
  return {
    workspace: {
      root: workspaceRoot,
      sourceRoot,
      targetRoot,
      strategyRoot,
      evidenceRoot: strategyRoot,
    },
    deadlineAt: Number.POSITIVE_INFINITY,
    writeArtifact: vi.fn((artifact: VerificationArtifact) => {
      const content = readFileSync(join(strategyRoot, artifact.path));
      return {
        ...artifact,
        contentHash: createHash("sha256").update(content).digest("hex"),
      };
    }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
