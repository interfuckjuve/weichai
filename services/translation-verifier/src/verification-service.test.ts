import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markVerificationPhase,
  measureVerification,
} from "./run-output/measure-legacy-run.js";
import * as recording from "./run-output/record-run.js";
import { VerificationService } from "./verification-service.js";
import { createSingleAgentDifferentialProvider } from "./strategies/single-agent-differential/strategy.js";
import { BEHAVIOR_COMMAND_ENTRY } from "./strategies/multi-agent-differential/behavior-command.js";
import * as processes from "./strategies/smoke-differential/manage-test-process.js";
import { VerificationStrategyFactory } from "./workflow/strategy-registry.js";
import { resolveVerificationPolicy } from "./schemas/verification-assessment.js";
import type { VerificationAssessment } from "./schemas/verification-types.js";
import { createVerificationResult } from "./schemas/materialize-verification-result.js";
import * as materialization from "./schemas/materialize-verification-result.js";
import { assertVerificationReceipt } from "./schemas/validate-verification-receipt.js";
import {
  type VerificationInput,
  type VerificationResult,
  type VerificationStrategy,
  type VerificationStrategyContext,
  type VerificationStrategyDescriptor,
  type VerificationStrategyProvider,
} from "./schemas/verification-types.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const fsRename = vi.mocked(fs.renameSync).getMockImplementation()!;

const sourceContent = "export function source() {\n  return 1;\n}\n";
const originalTargetContent =
  "def target():\n    raise NotImplementedError()\n";
const translatedTargetContent = "def target():\n    return 1\n";
const now = "2026-09-05T00:00:00.000Z";

let root: string;
let workspaceRoot: string;
let artifactRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-v2-service-test-"));
  workspaceRoot = join(root, "workspaces");
  artifactRoot = join(root, "artifacts");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.renameSync).mockReset().mockImplementation(fsRename);
  rmSync(root, { recursive: true, force: true });
});

describe("VerificationService", () => {
  it("lets strategy resource requirements disclose source context without accepting a reference", async () => {
    const p = provider("autonomous", async (value, context) => {
      expect(
        readFileSync(
          join(context.workspace.sourceRoot, "src/source.ts"),
          "utf8",
        ),
      ).toBe(sourceContent);
      return okResult(value, descriptor("autonomous"));
    });
    const receipt = await serviceWith([p], "autonomous").verifyWithReceipt(
      input(),
    );
    expect(receipt.result.executionStatus).toBe("completed");
    expect(receipt.resultArtifact).toBeDefined();
  });

  it("persists a strategy-owned reference decision without a Host test basis", async () => {
    const receipt = await serviceWith(
      [
        provider("autonomous", async () => ({
          ...reportAssessment(),
          mode: "differential",
          referenceDecision: "accepted",
          referenceReason:
            "The strategy inspected the supplied requirements and source behavior.",
          sourceAssessment: "inconclusive",
          summary: "observations agree",
          issues: [],
          artifacts: [],
          strategyReport: { basis: "Requirement: return one" },
        })),
      ],
      "autonomous",
    ).verifyWithReceipt(input());
    expect(receipt.result).toMatchObject({
      executionStatus: "completed",
      mode: "differential",
      referenceDecision: "accepted",
    });
    expect(receipt.resultArtifact).toBeDefined();
    expect(() =>
      assertVerificationReceipt(receipt, input(), descriptor("autonomous")),
    ).not.toThrow();
  });

  it("uses caller-prepared project roots without reapplying patches or cleaning their contents", async () => {
    const sourceRoot = join(root, "prepared-source");
    const targetRoot = join(root, "prepared-target");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    mkdirSync(join(targetRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src/source.ts"), sourceContent);
    writeFileSync(join(targetRoot, "src/target.py"), translatedTargetContent);
    writeFileSync(join(targetRoot, "fixture.bin"), Buffer.from([0, 1, 255]));
    let attemptRoot = "";
    const p = provider("prepared", async (value, context) => {
      attemptRoot = context.workspace.root;
      expect(context.workspace.sourceRoot).toBe(sourceRoot);
      expect(context.workspace.targetRoot).toBe(targetRoot);
      expect(context.workspace.projectOwnership).toBe("caller");
      expect(readFileSync(join(targetRoot, "fixture.bin"))).toEqual(
        Buffer.from([0, 1, 255]),
      );
      return okResult(value, descriptor("prepared"));
    });
    const receipt = await serviceWith([p], "prepared").verifyWithReceipt(
      input(),
      {
        preparedProjects: { sourceRoot, targetRoot },
      },
    );
    expect(receipt.result.executionStatus, receipt.result.summary).toBe(
      "completed",
    );
    expect(receipt.resultArtifact).toBeDefined();
    expect(existsSync(attemptRoot)).toBe(false);
    expect(readFileSync(join(targetRoot, "src/target.py"), "utf8")).toBe(
      translatedTargetContent,
    );
    expect(readFileSync(join(sourceRoot, "src/source.ts"), "utf8")).toBe(
      sourceContent,
    );
  });

  it.each([
    "source-mismatch",
    "target-mismatch",
    "missing-source",
    "same-roots",
    "nested-roots",
    "storage-overlap",
    "symlink-file",
    "hardlink-file",
  ] as const)(
    "rejects invalid prepared projects (%s) before strategy creation and preserves caller files",
    async (violation) => {
      const sourceRoot = join(root, "prepared-source");
      let targetRoot = join(root, "prepared-target");
      mkdirSync(join(sourceRoot, "src"), { recursive: true });
      mkdirSync(join(targetRoot, "src"), { recursive: true });
      const sourceFile = join(sourceRoot, "src/source.ts");
      writeFileSync(sourceFile, sourceContent);
      writeFileSync(join(targetRoot, "src/target.py"), translatedTargetContent);
      if (violation === "source-mismatch") writeFileSync(sourceFile, "wrong");
      if (violation === "target-mismatch")
        writeFileSync(join(targetRoot, "src/target.py"), originalTargetContent);
      if (violation === "same-roots") targetRoot = sourceRoot;
      if (violation === "nested-roots") {
        targetRoot = join(sourceRoot, "nested");
        mkdirSync(targetRoot);
      }
      if (violation === "storage-overlap") {
        targetRoot = workspaceRoot;
        mkdirSync(targetRoot);
      }
      if (violation === "symlink-file" || violation === "hardlink-file") {
        const original = join(root, "original.ts");
        writeFileSync(original, sourceContent);
        rmSync(sourceFile);
        if (violation === "symlink-file") fs.symlinkSync(original, sourceFile);
        else fs.linkSync(original, sourceFile);
      }
      const p = provider("prepared");
      const create = vi.spyOn(p, "create");
      const receipt = await serviceWith([p], "prepared").verifyWithReceipt(
        input(),
        {
          preparedProjects: {
            ...(violation === "missing-source" ? {} : { sourceRoot }),
            targetRoot,
          },
        },
      );
      expect(receipt.result.executionStatus).toBe("failed");
      expect(receipt.result.referenceDecision).toBe("undetermined");
      expect(create).not.toHaveBeenCalled();
      expect(existsSync(sourceFile)).toBe(true);
      expect(existsSync(targetRoot)).toBe(true);
      expect(receipt.resultArtifact).toBeDefined();
    },
  );

  it.each(["artifacts", "workspaces", "requirements-failure"] as const)(
    "does not write into a prepared project when %s storage overlaps it",
    async (storage) => {
      const sourceRoot = join(root, "prepared-source");
      const targetRoot = join(root, "prepared-target");
      mkdirSync(join(sourceRoot, "src"), { recursive: true });
      mkdirSync(join(targetRoot, "src"), { recursive: true });
      writeFileSync(join(sourceRoot, "src/source.ts"), sourceContent);
      writeFileSync(join(targetRoot, "src/target.py"), translatedTargetContent);
      const originalFiles = readdirSync(targetRoot, { recursive: true });
      if (storage !== "workspaces") artifactRoot = join(targetRoot, "reports");
      else workspaceRoot = join(targetRoot, "workspaces");
      const p = provider("prepared");
      if (storage === "requirements-failure")
        p.workspaceRequirements = () => {
          throw new Error("Unable to declare project requirements");
        };
      const create = vi.spyOn(p, "create");
      const receipt = await serviceWith([p], "prepared").verifyWithReceipt(
        input(),
        { preparedProjects: { sourceRoot, targetRoot } },
      );
      expect(receipt.result.executionStatus).toBe("failed");
      expect(create).not.toHaveBeenCalled();
      expect(readdirSync(targetRoot, { recursive: true })).toEqual(
        originalFiles,
      );
      expect(readFileSync(join(targetRoot, "src/target.py"), "utf8")).toBe(
        translatedTargetContent,
      );
      if (storage !== "workspaces") {
        expect(receipt.resultArtifact).toBeUndefined();
        expect(receipt.result.artifacts).toEqual([]);
        expect(receipt.result.problems).toContainEqual(
          expect.objectContaining({ code: "artifact_persistence_failed" }),
        );
        expect(existsSync(artifactRoot)).toBe(false);
      } else {
        expect(receipt.resultArtifact).toBeDefined();
        expect(existsSync(workspaceRoot)).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "honors target-only resource declarations with supplied source=%s",
    async (supplySource) => {
      const sourceRoot = join(root, "prepared-source");
      mkdirSync(join(sourceRoot, "src"), { recursive: true });
      writeFileSync(join(sourceRoot, "src/source.ts"), sourceContent);
      const targetRoot = join(root, "prepared-target");
      mkdirSync(join(targetRoot, "src"), { recursive: true });
      writeFileSync(join(targetRoot, "src/target.py"), translatedTargetContent);
      const p = provider("target", async (value, context) => {
        expect(readdirSync(context.workspace.sourceRoot)).toEqual([]);
        expect(context.workspace.targetRoot).toBe(targetRoot);
        return okResult(value, descriptor("target"));
      });
      p.workspaceRequirements = () => ({ source: false });
      const receipt = await serviceWith([p], "target").verifyWithReceipt(
        input(),
        {
          preparedProjects: {
            ...(supplySource ? { sourceRoot } : {}),
            targetRoot,
          },
        },
      );
      expect(receipt.result.executionStatus).toBe("completed");
      expect(existsSync(targetRoot)).toBe(true);
    },
  );

  it.each(["failed", "cancelled"] as const)(
    "does not invent an Agent reference decision after a %s dispatch",
    async (state) => {
      const value = input();
      value.verificationPolicy = {
        referenceDecision: "accepted",
        reason: "Legacy Host decision",
      };
      const controller = new AbortController();
      const p = provider("not-started", async () => {
        throw new Error("failed before assessment");
      });
      if (state === "cancelled") controller.abort("caller stopped");
      const receipt = await serviceWith([p], "not-started").verifyWithReceipt(
        value,
        {},
        controller.signal,
      );
      expect(receipt.result).toMatchObject({
        mode: "target_only",
        referenceDecision: "undetermined",
        executionStatus: state,
        sourceAssessment: "not_checked",
        targetAssessment: "inconclusive",
      });
    },
  );

  it("preserves prepared caller projects when a strategy fails or is cancelled", async () => {
    const targetRoot = join(root, "prepared-target");
    mkdirSync(join(targetRoot, "src"), { recursive: true });
    writeFileSync(join(targetRoot, "src/target.py"), translatedTargetContent);
    const p = provider("failing", async () => {
      throw new Error("agent failed");
    });
    p.workspaceRequirements = () => ({ source: false });
    const service = serviceWith([p], "failing");
    for (const signal of [undefined, AbortSignal.abort("stop")]) {
      const receipt = await service.verifyWithReceipt(
        input(),
        { preparedProjects: { targetRoot } },
        signal,
      );
      expect(receipt.result.executionStatus).toBe(
        signal ? "cancelled" : "failed",
      );
      expect(readFileSync(join(targetRoot, "src/target.py"), "utf8")).toBe(
        translatedTargetContent,
      );
      expect(readdirSync(workspaceRoot)).toEqual([]);
    }
  });

  it("selects without enumeration and constructs exactly one strategy at dispatch", async () => {
    const p = provider("first");
    const create = vi.spyOn(p, "create");
    const list = vi.spyOn(VerificationStrategyFactory.prototype, "list");
    const receipt = await serviceWith([p], "first").verifyWithReceipt(input());
    expect(receipt.resultArtifact).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it.each([
    new DOMException("caller timeout reason", "TimeoutError"),
    "stop",
    42,
  ])(
    "classifies caller cancellation before workspace failure with reason %s",
    async (reason) => {
      const controller = new AbortController();
      controller.abort(reason);
      writeFileSync(workspaceRoot, "blocked");
      const p = provider("first");
      const create = vi.spyOn(p, "create");
      const receipt = await serviceWith([p], "first").verifyWithReceipt(
        input(),
        {},
        controller.signal,
      );
      expect(receipt.result).toMatchObject({
        executionStatus: "cancelled",
        problems: [{ code: "cancelled" }],
      });
      expect(receipt.resultArtifact).toBeDefined();
      expect(create).not.toHaveBeenCalled();
      expect(
        JSON.parse(
          readFileSync(
            join(artifactRoot, receipt.resultArtifact!.path),
            "utf8",
          ),
        ),
      ).toEqual(receipt.result);
    },
  );
  it("includes canonical materialization in the existing execution timing scope", async () => {
    const recorders = vi.spyOn(recording, "createRunRecorder");
    const resultNow = vi.fn(() => {
      expect(
        recorders.mock.results[0]!.value.snapshot().stages.find(
          (step: { name: string }) => step.name === "execute-strategy",
        ),
      ).toMatchObject({ state: "running" });
      return now;
    });
    await serviceWith([provider("first")], "first", {
      now: resultNow,
    }).verifyWithReceipt(input());
    expect(resultNow).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no_bug_observed", "no_bug_observed"],
    ["bug_found", "no_bug_observed"],
    ["no_bug_observed", "bug_found"],
    ["bug_found", "bug_found"],
  ] as const)(
    "preserves source %s and target %s when the caller cancels with TimeoutError",
    async (sourceAssessment, targetAssessment) => {
      const value = input();
      value.verificationPolicy = {
        referenceDecision: "accepted",
        reason: "Reviewed reference snapshot",
        testBasis: "Both implementations return one",
      };
      const controller = new AbortController();
      const resultNow = vi.fn(() => now);
      const service = serviceWith(
        [
          provider("first", async (_value, context) => {
            const artifact = await evidence(context);
            controller.abort(
              new DOMException("caller stopped", "TimeoutError"),
            );
            return {
              mode: "differential",
              referenceDecision: "accepted",
              referenceReason: value.verificationPolicy!.reason,
              executionStatus: "completed",
              sourceAssessment,
              targetAssessment,
              problems: [],
              summary: "Independent findings",
              issues: [
                {
                  id: "finding",
                  kind: "behavior",
                  message: "Observed result",
                  evidenceArtifactIds: [artifact.id],
                },
              ],
              artifacts: [artifact],
              strategyReport: { observed: true },
            };
          }),
        ],
        "first",
        { now: resultNow },
      );
      const receipt = await service.verifyWithReceipt(
        value,
        {},
        controller.signal,
      );
      expect(resultNow).toHaveBeenCalledTimes(1);
      expect(receipt.result).toMatchObject({
        executionStatus: "cancelled",
        sourceAssessment,
        targetAssessment,
        problems: [{ code: "cancelled", message: "caller stopped" }],
      });
      expect(receipt.result.issues[0]!.evidenceArtifactIds).toEqual([
        receipt.result.artifacts[0]!.id,
      ]);
      expect(
        JSON.parse(
          readFileSync(
            join(artifactRoot, receipt.resultArtifact!.path),
            "utf8",
          ),
        ),
      ).toEqual(receipt.result);
    },
  );

  describe.each([3, 4])("late interruption at microtask %i", (microtasks) => {
    function interrupt(callback: () => void, remaining = microtasks): void {
      queueMicrotask(() =>
        remaining === 1 ? callback() : interrupt(callback, remaining - 1),
      );
    }

    it.each([
      ["no_bug_observed", "no_bug_observed"],
      ["bug_found", "no_bug_observed"],
      ["no_bug_observed", "bug_found"],
      ["bug_found", "bug_found"],
    ] as const)(
      "retains source %s and target %s before one final construction",
      async (sourceAssessment, targetAssessment) => {
        const value = input();
        value.verificationPolicy = {
          referenceDecision: "accepted",
          reason: "Reviewed reference snapshot",
          testBasis: "Both implementations return one",
        };
        const controller = new AbortController();
        const resultNow = vi.fn(() => {
          expect(controller.signal.aborted).toBe(true);
          return now;
        });
        const construct = vi.spyOn(materialization, "createVerificationResult");
        const receipt = await serviceWith(
          [
            provider("first", async (_value, context) => {
              const artifact = await evidence(context);
              interrupt(() =>
                controller.abort(
                  new DOMException("late caller stop", "TimeoutError"),
                ),
              );
              return {
                mode: "differential",
                referenceDecision: "accepted",
                referenceReason: value.verificationPolicy!.reason,
                executionStatus: "completed",
                sourceAssessment,
                targetAssessment,
                problems: [],
                summary: "Independent findings",
                issues: [
                  {
                    id: "finding",
                    kind: "behavior",
                    message: "Observed result",
                    evidenceArtifactIds: [artifact.id],
                  },
                ],
                artifacts: [artifact],
                strategyReport: { observed: true },
              };
            }),
          ],
          "first",
          { now: resultNow },
        ).verifyWithReceipt(value, {}, controller.signal);
        expect(resultNow).toHaveBeenCalledTimes(1);
        // Receipt validation rebuilds the envelope using its own clock, not the Host constructor clock.
        expect(
          construct.mock.calls.filter((call) => call[3] === resultNow),
        ).toHaveLength(1);
        const persisted = JSON.parse(
          readFileSync(
            join(artifactRoot, receipt.resultArtifact!.path),
            "utf8",
          ),
        );
        expect(persisted).toEqual(receipt.result);
        expect(
          assertVerificationReceipt(
            { ...receipt, result: persisted },
            value,
            descriptor("first"),
          ),
        ).toEqual(receipt);
        expect(persisted).toMatchObject({
          executionStatus: "cancelled",
          sourceAssessment,
          targetAssessment,
          problems: [{ code: "cancelled", message: "late caller stop" }],
          strategyReport: { observed: true },
        });
        expect(persisted.problems).toHaveLength(1);
        expect(persisted.issues[0].evidenceArtifactIds).toEqual([
          persisted.artifacts[0].id,
        ]);
        expect(
          readFileSync(join(artifactRoot, persisted.artifacts[0].path), "utf8"),
        ).toBe("xxx");
        expect(readdirSync(workspaceRoot)).toEqual([]);
      },
    );

    it.each(["ordinary", "persistence"])(
      "preserves %s failure artifact semantics with late caller cancellation",
      async (failure) => {
        const controller = new AbortController();
        const resultNow = vi.fn(() => {
          expect(controller.signal.aborted).toBe(true);
          return now;
        });
        const value = input();
        const receipt = await serviceWith(
          [
            provider("first", async (_value, context) => {
              const artifact = await evidence(context);
              interrupt(() =>
                controller.abort(
                  new DOMException("late caller stop", "TimeoutError"),
                ),
              );
              if (failure === "persistence") {
                context.writeArtifact({
                  ...artifact,
                  id: "missing",
                  path: "missing.json",
                });
              }
              throw new Error("strategy failed");
            }),
          ],
          "first",
          { now: resultNow },
        ).verifyWithReceipt(value, {}, controller.signal);
        expect(resultNow).toHaveBeenCalledTimes(1);
        expect(
          assertVerificationReceipt(receipt, value, descriptor("first")),
        ).toEqual(receipt);
        expect(receipt.result).toMatchObject({
          executionStatus: failure === "persistence" ? "failed" : "cancelled",
          problems: [
            {
              code:
                failure === "persistence"
                  ? "artifact_persistence_failed"
                  : "cancelled",
              message: "late caller stop",
            },
          ],
        });
        if (failure === "persistence") {
          expect(receipt.resultArtifact).toBeUndefined();
          expect(receipt.result.artifacts).toEqual([]);
          expect(receipt.result.issues[0]!.evidenceArtifactIds).toEqual([]);
          expect(readdirSync(artifactRoot)).toEqual([]);
        } else {
          expect(receipt.result.artifacts).toHaveLength(1);
          expect(
            JSON.parse(
              readFileSync(
                join(artifactRoot, receipt.resultArtifact!.path),
                "utf8",
              ),
            ),
          ).toEqual(receipt.result);
        }
        expect(readdirSync(workspaceRoot)).toEqual([]);
      },
    );

    it("marks a late Host timeout partial without losing findings", async () => {
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      const receipt = await serviceWith(
        [
          provider("first", async () => {
            interrupt(() =>
              timeout.abort(new DOMException("deadline", "TimeoutError")),
            );
            return {
              ...reportAssessment(),
              summary: "Checked",
              issues: [],
              artifacts: [],
              strategyReport: null,
            };
          }),
        ],
        "first",
      ).verifyWithReceipt(input());
      expect(receipt.result).toMatchObject({
        executionStatus: "partial",
        targetAssessment: "no_bug_observed",
        problems: [{ code: "agent_timeout" }],
      });
      expect(
        JSON.parse(
          readFileSync(
            join(artifactRoot, receipt.resultArtifact!.path),
            "utf8",
          ),
        ),
      ).toEqual(receipt.result);
    });
  });

  it("runs a verify-only no-Agent provider with arbitrary repeated steps", async () => {
    const recorders = vi.spyOn(recording, "createRunRecorder");
    const service = serviceWith(
      [
        provider("custom", async (value, context) => {
          expect(context.measureStep).toBeTypeOf("function");
          expect(Number.isFinite(context.deadlineAt)).toBe(true);
          expect(
            readFileSync(
              join(context.workspace.targetRoot, "src/target.py"),
              "utf8",
            ),
          ).toBe(translatedTargetContent);
          expect(
            existsSync(join(context.workspace.root, "baseline.json")),
          ).toBe(false);
          expect(
            existsSync(
              join(context.workspace.root, "source/.forexplore-tests"),
            ),
          ).toBe(false);
          return context.measureStep!("compare-arbitrary", async () => {
            await context.measureStep!("compare-arbitrary", async () => {});
            await context.measureStep!(
              "collect-after-comparison",
              async () => {},
            );
            await context.measureStep!("compare-arbitrary", async () => {});
            return okResult(value, descriptor("custom"));
          });
        }),
      ],
      "custom",
    );
    const receipt = await service.verifyWithReceipt(input());
    expect(receipt.result.targetAssessment).toBe("no_bug_observed");
    expect(receipt.resultArtifact).toBeDefined();
    const run = recorders.mock.results[0]!.value.snapshot();
    expect(
      run.stages
        .filter(
          (step: { scope: string; parentId?: string }) =>
            step.scope === "framework" && !step.parentId,
        )
        .map((step: { name: string }) => step.name),
    ).toEqual(["validate-input", "execute-strategy", "save-report"]);
    expect(
      run.stages
        .filter((step: { scope: string }) => step.scope === "strategy")
        .map((step: { name: string }) => step.name),
    ).toEqual([
      "compare-arbitrary",
      "compare-arbitrary",
      "collect-after-comparison",
      "compare-arbitrary",
    ]);
    expect(
      new Set(run.stages.map((step: { id: string }) => step.id)).size,
    ).toBe(run.stages.length);
    expect(
      run.stages.every(
        (step: { state: string; durationMs?: number }) =>
          step.state === "completed" && step.durationMs !== undefined,
      ),
    ).toBe(true);
    expect(run.diagnostics).toEqual([]);
    const execute = run.stages.find(
      (step: { name: string }) => step.name === "execute-strategy",
    )!;
    const prepare = run.stages.find(
      (step: { name: string }) => step.name === "prepare-strategy-workspace",
    )!;
    const strategySteps = run.stages.filter(
      (step: { scope: string }) => step.scope === "strategy",
    );
    expect(prepare.parentId).toBe(execute.id);
    expect(strategySteps[0].parentId).toBe(execute.id);
    expect(
      strategySteps
        .slice(1)
        .every(
          (step: { parentId?: string }) =>
            step.parentId === strategySteps[0].id,
        ),
    ).toBe(true);
  });

  it.each(["ordinary", "timeout", "abort"])(
    "preserves %s errors from measured no-Agent strategy steps",
    async (kind) => {
      const recorders = vi.spyOn(recording, "createRunRecorder");
      const error =
        kind === "ordinary"
          ? new Error("custom failed")
          : new DOMException(
              kind,
              kind === "abort" ? "AbortError" : "TimeoutError",
            );
      let calls = 0;
      const service = serviceWith(
        [
          provider("custom", async (_value, context) =>
            context.measureStep!("arbitrary-error", () => {
              calls++;
              throw error;
            }),
          ),
        ],
        "custom",
      );
      const pending = service.verifyWithReceipt(input());
      const receipt = await pending;
      expect(receipt.result.targetAssessment).toBe("inconclusive");
      expect(receipt.result.executionStatus).toBe(
        kind === "abort" ? "cancelled" : "failed",
      );
      expect(receipt.result.issues[0]?.kind).toBe(
        kind === "timeout" ? "strategy-timeout" : "framework-error",
      );
      expect(receipt.resultArtifact).toBeDefined();
      expect(calls).toBe(1);
      const run = recorders.mock.results[0]!.value.snapshot();
      expect(
        run.stages.find(
          (step: { name: string }) => step.name === "arbitrary-error",
        ),
      ).toMatchObject({
        state: kind === "abort" ? "cancelled" : "failed",
        error: error.message,
      });
      expect(run.diagnostics).toEqual([]);
    },
  );

  it("isolates concurrent requests inside legacy timing while preserving both phase streams", async () => {
    const requests: recording.RunRecorder[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = serviceWith(
      [
        provider("first", async (value, context) =>
          context.measureStep!("custom-parallel", async () => {
            requests.push(recording.currentRunRecorder()!);
            if (requests.length === 2) release();
            await barrier;
            await context.measureStep!("custom-parallel", async () => {});
            return okResult(value, descriptor("first"));
          }),
        ),
      ],
      "first",
    );
    const outer = recording.createRunRecorder({ runId: "outer-measurement" });
    const measured = await recording.withRunRecorder(outer, () =>
      measureVerification(() =>
        Promise.all([
          service.verifyWithReceipt(input()),
          service.verifyWithReceipt(input()),
        ]),
      ),
    );
    expect(
      measured.value.map((receipt) => receipt.result.targetAssessment),
    ).toEqual(["no_bug_observed", "no_bug_observed"]);
    expect(new Set(requests.map((recorder) => recorder.runId)).size).toBe(2);
    expect(requests.every((recorder) => recorder !== outer)).toBe(true);
    for (const recorder of requests) {
      expect(
        recorder.snapshot().stages.every((step) => step.state === "completed"),
      ).toBe(true);
      expect(recorder.snapshot().diagnostics).toEqual([]);
      const custom = recorder
        .snapshot()
        .stages.filter((step) => step.scope === "strategy");
      expect(custom).toHaveLength(2);
      expect(custom[1].parentId).toBe(custom[0].id);
      expect(
        recorder.events().every((event) => event.runId === recorder.runId),
      ).toBe(true);
    }
    expect(outer.snapshot().stages).toEqual([]);
    expect(
      measured.timing.phases.filter(
        (phase) => phase.phase === "request-validation-and-strategy-selection",
      ),
    ).toHaveLength(2);
    expect(
      measured.timing.phases.filter(
        (phase) => phase.phase === "response-ready",
      ),
    ).toHaveLength(2);
  });

  it("does not forward late request phases into an enclosing measurement after timeout", async () => {
    let resume!: () => void;
    let wrote!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const service = serviceWith(
      [
        provider("first", async (value) => {
          await wait;
          markVerificationPhase("late-provider-phase");
          wrote();
          return okResult(value, descriptor("first"));
        }),
      ],
      "first",
      { timeoutMs: 10, shutdownTimeoutMs: 100 },
    );
    const measured = await measureVerification(async () => {
      const result = await service.verify(input());
      resume();
      await observed;
      return result;
    });
    expect(measured.value.targetAssessment).toBe("inconclusive");
    expect(
      measured.timing.phases.some(
        (phase) => phase.phase === "late-provider-phase",
      ),
    ).toBe(false);
  });

  async function evidence(context: VerificationStrategyContext, bytes = 3) {
    writeFileSync(
      join(context.workspace.evidenceRoot, "report.json"),
      Buffer.alloc(bytes, "x"),
    );
    return context.writeArtifact({
      id: "report",
      kind: "report",
      path: "report.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    });
  }

  it("does not enter verify when provider creation synchronously cancels the caller", async () => {
    const controller = new AbortController();
    const abort = new DOMException(
      "cancelled in provider creation",
      "AbortError",
    );
    const verify = vi.fn(async (value: VerificationInput) =>
      okResult(value, descriptor("first")),
    );
    const p = provider("first", verify);
    p.create = () => {
      controller.abort(abort);
      return { verify };
    };
    const receipt = await serviceWith([p], "first").verifyWithReceipt(
      input(),
      {},
      controller.signal,
    );
    expect(receipt.result.executionStatus).toBe("cancelled");
    expect(receipt.resultArtifact).toBeDefined();
    expect(verify).not.toHaveBeenCalled();
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });

  it.each([
    "source",
    "oversized-artifact",
    "oversized-result",
    "cumulative-budget",
    "destination",
  ])(
    "fails closed on %s persistence failure and removes only this attempt's durable artifacts",
    async (failure) => {
      const previous = await serviceWith(
        [provider("first")],
        "first",
      ).verifyWithReceipt(input());
      const previousBytes = readFileSync(
        join(artifactRoot, previous.resultArtifact!.path),
      );
      const service = serviceWith(
        [
          provider("first", async (inputValue, context) => {
            const artifact = await evidence(
              context,
              failure === "cumulative-budget" ? 10 * 1024 * 1024 : 3,
            );
            if (failure === "source")
              await context.writeArtifact({
                ...artifact,
                id: "missing",
                path: "missing.json",
              });
            if (failure === "oversized-artifact") {
              writeFileSync(
                join(context.workspace.evidenceRoot, "big.json"),
                Buffer.alloc(10 * 1024 * 1024 + 1),
              );
              await context.writeArtifact({
                ...artifact,
                id: "big",
                path: "big.json",
              });
            }
            if (failure === "destination") {
              // A non-directory artifact-root parent is a real ENOTDIR persistence failure.
              rmSync(join(artifactRoot, artifact.path.split("/")[0]!), {
                recursive: true,
              });
              writeFileSync(
                join(artifactRoot, artifact.path.split("/")[0]!),
                "blocked",
              );
            }
            return createVerificationResult(
              inputValue,
              descriptor("first"),
              {
                ...reportAssessment(),
                summary: "verified",
                issues: [],
                artifacts: [artifact],
                strategyReport:
                  failure === "oversized-result"
                    ? { output: "x".repeat(10 * 1024 * 1024) }
                    : {},
              },
              () => now,
            );
          }),
        ],
        "first",
      );
      const receipt = await service.verifyWithReceipt(input());
      expect(receipt.resultArtifact).toBeUndefined();
      expect(receipt.result).toMatchObject({
        executionStatus: "failed",
        artifacts: [],
        issues: [{ kind: "artifact-persistence-failed" }],
      });
      expect(
        readFileSync(join(artifactRoot, previous.resultArtifact!.path)),
      ).toEqual(previousBytes);
      expect(readdirSync(artifactRoot)).toEqual([
        previous.resultArtifact!.path.split("/")[0],
      ]);
    },
  );

  it.each(["strategy", "provider", "caller"])(
    "persists a classified %s cancellation with available artifacts",
    async (origin) => {
      const error = new DOMException("cancelled", "AbortError");
      const controller = new AbortController();
      const p = provider("first", async (_inputValue, context) => {
        await evidence(context);
        if (origin === "caller") controller.abort(error);
        throw error;
      });
      if (origin === "provider")
        p.create = () => {
          throw error;
        };
      const receipt = await serviceWith([p], "first").verifyWithReceipt(
        input(),
        {},
        controller.signal,
      );
      expect(receipt.result).toMatchObject({
        executionStatus: "cancelled",
        targetAssessment: "inconclusive",
        problems: [{ code: "cancelled" }],
      });
      expect(receipt.resultArtifact).toBeDefined();
      expect(
        readFileSync(join(artifactRoot, receipt.resultArtifact!.path), "utf8"),
      ).toContain('"cancelled"');
    },
  );

  it.each(["missing", "file", "symlink"])(
    "fails closed when the durable root becomes %s during cancellation",
    async (replacement) => {
      const abort = new DOMException("cancelled", "AbortError");
      const outside = join(root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "sentinel"), "untouched");
      const service = serviceWith(
        [
          provider("first", async (_inputValue, context) => {
            await evidence(context);
            rmSync(artifactRoot, { recursive: true });
            if (replacement === "file") writeFileSync(artifactRoot, "blocked");
            if (replacement === "symlink")
              fs.symlinkSync(outside, artifactRoot, "dir");
            throw abort;
          }),
        ],
        "first",
      );
      const receipt = await service.verifyWithReceipt(input());
      expect(receipt.result.executionStatus).toBe(
        replacement === "missing" ? "cancelled" : "failed",
      );
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
      expect(readdirSync(workspaceRoot)).toEqual([]);
    },
  );

  it("does not retry a transient final-result persistence failure", async () => {
    const service = serviceWith(
      [
        provider("first", async (inputValue, context) => {
          const artifact = await evidence(context);
          vi.mocked(fs.renameSync)
            .mockClear()
            .mockImplementationOnce(() => {
              throw new Error("transient result rename failure");
            });
          return createVerificationResult(
            inputValue,
            descriptor("first"),
            {
              ...reportAssessment(),
              summary: "verified",
              issues: [],
              artifacts: [artifact],
              strategyReport: {},
            },
            () => now,
          );
        }),
      ],
      "first",
    );
    const receipt = await service.verifyWithReceipt(input());
    expect(receipt.resultArtifact).toBeUndefined();
    expect(receipt.result).toMatchObject({
      executionStatus: "failed",
      artifacts: [],
      issues: [{ kind: "artifact-persistence-failed" }],
    });
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(readdirSync(artifactRoot)).toEqual([]);
  });

  it("does not delete another attempt through a replaced attempt symlink", async () => {
    const previous = await serviceWith(
      [provider("first")],
      "first",
    ).verifyWithReceipt(input());
    const bytes = readFileSync(
      join(artifactRoot, previous.resultArtifact!.path),
    );
    const abort = new DOMException("cancelled", "AbortError");
    const service = serviceWith(
      [
        provider("first", async (_inputValue, context) => {
          const artifact = await evidence(context);
          const attempt = join(artifactRoot, artifact.path.split("/")[0]!);
          rmSync(attempt, { recursive: true });
          fs.symlinkSync(
            join(artifactRoot, previous.resultArtifact!.path.split("/")[0]!),
            attempt,
            "dir",
          );
          throw abort;
        }),
      ],
      "first",
    );
    const receipt = await service.verifyWithReceipt(input());
    expect(receipt.result.problems).toMatchObject([
      { code: "artifact_persistence_failed" },
    ]);
    expect(
      readFileSync(join(artifactRoot, previous.resultArtifact!.path)),
    ).toEqual(bytes);
    expect(readdirSync(artifactRoot)).toEqual([
      previous.resultArtifact!.path.split("/")[0],
    ]);
  });

  it.each(["strategy", "provider"])(
    "normalizes a %s-thrown TimeoutError without caller cancellation",
    async (origin) => {
      const p = provider("first", async () => {
        throw new DOMException("timeout", "TimeoutError");
      });
      if (origin === "provider")
        p.create = () => {
          throw new DOMException("timeout", "TimeoutError");
        };
      const result = await serviceWith([p], "first").verifyWithReceipt(input());
      expect(result.result).toMatchObject({
        executionStatus: "failed",
        issues: [{ kind: "strategy-timeout" }],
      });
      expect(result.resultArtifact).toBeDefined();
    },
  );

  it.each([0.5, 4294967296])(
    "reports invalid timeout %s without executing the provider",
    async (timeoutMs) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const p = provider("first");
      const create = vi.spyOn(p, "create");
      const service = serviceWith([p], "first", { timeoutMs });
      for (const method of ["verify", "verifyWithReceipt"] as const) {
        const value = await service[method](input());
        const result = "result" in value ? value.result : value;
        expect(result).toMatchObject({
          executionStatus: "failed",
          problems: [{ code: "internal_error" }],
        });
        expect(timeout.mock.results.at(-1)?.type).toBe("throw");
        expect(timeout).toHaveBeenLastCalledWith(timeoutMs);
        expect(create).not.toHaveBeenCalled();
        expect(existsSync(artifactRoot)).toBe(true);
        expect(readdirSync(workspaceRoot)).toEqual([]);
      }
    },
  );

  it.each(["strategy", "provider"])(
    "normalizes a %s-thrown RangeError and cleans the workspace",
    async (origin) => {
      const recorders = vi.spyOn(recording, "createRunRecorder");
      const error = new RangeError("strategy value out of range");
      const p = provider("first", async () => {
        throw error;
      });
      if (origin === "provider")
        p.create = () => {
          throw error;
        };
      const receipt = await serviceWith([p], "first").verifyWithReceipt(
        input(),
      );
      expect(receipt.result).toMatchObject({
        executionStatus: "failed",
        issues: [{ kind: "framework-error", message: error.message }],
      });
      expect(receipt.resultArtifact).toBeDefined();
      expect(
        JSON.parse(
          readFileSync(
            join(artifactRoot, receipt.resultArtifact!.path),
            "utf8",
          ),
        ),
      ).toEqual(receipt.result);
      expect(readdirSync(workspaceRoot)).toEqual([]);
      const run = recorders.mock.results[0]!.value.snapshot();
      expect(
        run.stages.find(
          (step: { name: string }) => step.name === "execute-strategy",
        ),
      ).toMatchObject({ state: "failed", error: error.message });
      expect(run.diagnostics).toEqual([]);
    },
  );

  it("persists a Host failure report even when the project workspace cannot be created", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(workspaceRoot, "blocked");
    const receipt = await serviceWith(
      [provider("first")],
      "first",
    ).verifyWithReceipt(input());
    expect(receipt.result.executionStatus).toBe("failed");
    expect(receipt.resultArtifact).toBeDefined();
    expect(
      JSON.parse(
        readFileSync(join(artifactRoot, receipt.resultArtifact!.path), "utf8"),
      ),
    ).toEqual(receipt.result);
  });

  it("compares registered no-Agent strategies on identical input without imposing common private steps", async () => {
    const sameInput = input();
    const before = structuredClone(sameInput);
    const service = serviceWith(
      [
        provider("first"),
        provider("second", async (value, context) => {
          await context.measureStep!("custom-probe", async () => {});
          await context.measureStep!("custom-probe", async () => {});
          return okResult(value, descriptor("second"));
        }),
      ],
      "first",
    );
    const first = await service.verify(sameInput);
    const second = await service.verify(sameInput, { strategyId: "second" });
    expect([first.strategyId, second.strategyId]).toEqual(["first", "second"]);
    expect([first.subjectHash, second.subjectHash]).toEqual([
      sameInput.translation.patchHash,
      sameInput.translation.patchHash,
    ]);
    expect([first.targetAssessment, second.targetAssessment]).toEqual([
      "no_bug_observed",
      "no_bug_observed",
    ]);
    expect(sameInput).toEqual(before);
    expect(service.listStrategies().map((descriptor) => descriptor.id)).toEqual(
      ["first", "second"],
    );
  });

  it("persists an exact identified receipt result artifact", async () => {
    const receipt = await serviceWith(
      [provider("first")],
      "first",
    ).verifyWithReceipt(input());
    const artifact = receipt.resultArtifact!;
    const bytes = readFileSync(join(artifactRoot, artifact.path));
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(receipt.result);
    expect(artifact.id).toContain(artifact.path);
    expect(artifact.contentHash).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(artifact.size).toBe(bytes.byteLength);
    expect(artifact.kind).toBe("verification-result");
  });
  it("normalizes a strategy exception and reports caller cancellation separately", async () => {
    const failingService = serviceWith(
      [
        provider("failing", async () => {
          throw new Error("boom");
        }),
      ],
      "failing",
    );
    expect((await failingService.verify(input())).targetAssessment).toBe(
      "inconclusive",
    );

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    const cancelled = await serviceWith([provider("first")], "first").verify(
      input(),
      {},
      controller.signal,
    );
    expect(cancelled.executionStatus).toBe("cancelled");
    expect(cancelled.problems).toMatchObject([{ code: "cancelled" }]);
  });

  it("throws invalid input and unknown strategy IDs before creating a workspace", async () => {
    const service = serviceWith([provider("first")], "first");
    await expect(
      service.verify({
        ...input(),
        translation: { ...input().translation, patchHash: "f".repeat(64) },
      }),
    ).rejects.toThrow(/patch hash/i);
    await expect(
      service.verify(input(), { strategyId: "missing" }),
    ).rejects.toThrow(/unknown/i);
    expect(existsSync(workspaceRoot) ? readdirSync(workspaceRoot) : []).toEqual(
      [],
    );
  });

  it("normalizes empty strategy errors to a nonempty framework issue", async () => {
    const emptyError = serviceWith(
      [
        provider("empty-error", async () => {
          throw new Error("");
        }),
      ],
      "empty-error",
    );
    const result = await emptyError.verify(input());
    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.summary).toBe(
      "Verification framework could not complete: Unknown verification error",
    );
    expect(result.issues[0]?.message).toBe("Unknown verification error");

    const emptyString = serviceWith(
      [
        provider("empty-string", async () => {
          throw "";
        }),
      ],
      "empty-string",
    );
    expect((await emptyString.verify(input())).issues[0]?.message).toBe(
      "Unknown verification error",
    );
  });

  it("normalizes a pre-aborted non-AbortError without executing the strategy", async () => {
    let executed = false;
    const service = serviceWith(
      [
        provider("first", async (inputValue) => {
          executed = true;
          return okResult(inputValue, descriptor("first"));
        }),
      ],
      "first",
    );
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));

    const result = await service.verify(input(), {}, controller.signal);

    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.issues[0]?.message).toBe("caller stopped");
    expect(executed).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(true);
  });

  it("turns result identity mismatches and timeouts into unverified framework errors", async () => {
    const wrongResult = serviceWith(
      [
        provider("first", async () => ({
          ...reportAssessment("bug_found"),
          summary: "invalid",
          issues: [],
          artifacts: [],
          strategyReport: {},
        })),
      ],
      "first",
    );
    const mismatch = await wrongResult.verify(input());
    expect(mismatch.targetAssessment).toBe("inconclusive");
    expect(mismatch.issues[0]).toMatchObject({
      id: "framework-error",
      kind: "framework-error",
    });

    const timeoutService = serviceWith(
      [
        provider("slow", async (_inputValue, _context, signal) => {
          await new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          throw new Error("unreachable");
        }),
      ],
      "slow",
      { timeoutMs: 1 },
    );
    const timeout = await timeoutService.verify(input());
    expect(timeout.targetAssessment).toBe("inconclusive");
    expect(timeout.strategyId).toBe("slow");
    expect(timeout.subjectHash).toBe(input().translation.patchHash);
    expect(timeout.summary).toBe(
      "Verification framework could not complete: Verification strategy timed out",
    );
  });

  it("joins real proxy cancellation before returning a single-agent receipt and deleting its workspace", async () => {
    workspaceRoot = join(realpathSync(root), "workspaces");
    artifactRoot = join(realpathSync(root), "artifacts");
    const controller = new AbortController();
    const actual = processes.runManagedProcess;
    let pid: number | undefined;
    let workspace = "";
    let sessionStopped = false;
    let proxy: ReturnType<typeof actual> | undefined;
    vi.spyOn(processes, "runManagedProcess").mockImplementation(
      async (command, signal) => {
        const response = {
          exitCode: 0,
          timedOut: false,
          durationMs: 1,
          stdout: "",
          stderr: "",
        };
        if (command.args.includes("--version"))
          return { ...response, stdout: "2.1.236" };
        if (!command.args.includes("--print")) return actual(command, signal);
        workspace = dirname(dirname(command.cwd));
        const pidFile = join(command.cwd, ".forexplore-tests/pid.txt");
        writeFileSync(join(command.cwd, ".forexplore-tests/plan.json"), "{}");
        proxy = actual(
          {
            command: process.execPath,
            args: [
              "--import",
              import.meta.resolve("tsx"),
              BEHAVIOR_COMMAND_ENTRY,
              "--project",
              "target",
              "--",
              "node",
              "-e",
              `process.on('SIGTERM',()=>{}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`,
            ],
            cwd: command.cwd,
            env: command.env,
            deadlineAt: command.deadlineAt,
          },
          signal,
        );
        // Consume failure immediately while the fixture waits for the nested process to start.
        const joined = proxy.then(
          () => {},
          () => {},
        );
        try {
          for (
            let attempt = 0;
            attempt < 300 && !existsSync(pidFile);
            attempt++
          )
            await new Promise((resolve) => setTimeout(resolve, 10));
          expect(existsSync(pidFile)).toBe(true);
          pid = Number(readFileSync(pidFile, "utf8"));
          controller.abort(new Error("caller stopped"));
          await joined;
          sessionStopped = true;
          return response;
        } finally {
          controller.abort();
          await joined;
        }
      },
    );
    try {
      const provider = createSingleAgentDifferentialProvider({
        apiKey: "local-test-key",
      });
      const receipt = await serviceWith(
        [provider],
        provider.descriptor.id,
      ).verifyWithReceipt(input(), {}, controller.signal);
      expect(
        sessionStopped,
        receipt.result.problems.map((problem) => problem.message).join("; "),
      ).toBe(true);
      expect(pid).toBeDefined();
      expect(() => process.kill(pid!, 0)).toThrow();
      expect(existsSync(workspace)).toBe(false);
      expect(receipt.result.executionStatus).toBe("cancelled");
      expect(
        receipt.result.problems.some((problem) =>
          problem.message.includes("shutdown unconfirmed"),
        ),
      ).toBe(false);
      const session = receipt.result.artifacts.find((artifact) =>
        artifact.id.endsWith(":single-agent-session"),
      );
      expect(session).toBeDefined();
      expect(
        JSON.parse(readFileSync(join(artifactRoot, session!.path), "utf8")),
      ).toHaveProperty("commandEvidence");
      expect(
        JSON.parse(
          readFileSync(
            join(artifactRoot, receipt.resultArtifact!.path),
            "utf8",
          ),
        ),
      ).toEqual(receipt.result);
    } finally {
      controller.abort();
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* Already stopped. */
        }
      }
      await proxy?.catch(() => {});
    }
  }, 15_000);

  it("joins delayed cooperative cancellation before deleting its workspace and preserves evidence", async () => {
    const controller = new AbortController();
    let workspace = "";
    let stopped = false;
    const receipt = await serviceWith(
      [
        provider("delayed-stop", async (value, context) => {
          workspace = context.workspace.root;
          controller.abort(new Error("caller stopped"));
          await new Promise((resolve) => setTimeout(resolve, 350));
          const artifact = await evidence(context);
          stopped = true;
          return {
            ...okResult(value, descriptor("delayed-stop")),
            artifacts: [artifact],
          };
        }),
      ],
      "delayed-stop",
    ).verifyWithReceipt(input(), {}, controller.signal);

    expect(stopped).toBe(true);
    expect(existsSync(workspace)).toBe(false);
    expect(receipt.result).toMatchObject({
      executionStatus: "cancelled",
      targetAssessment: "no_bug_observed",
      problems: [{ code: "cancelled" }],
      issues: [],
    });
    expect(receipt.result.artifacts).toHaveLength(1);
    expect(
      readFileSync(
        join(artifactRoot, receipt.result.artifacts[0]!.path),
        "utf8",
      ),
    ).toBe("xxx");
    expect(
      JSON.parse(
        readFileSync(join(artifactRoot, receipt.resultArtifact!.path), "utf8"),
      ),
    ).toEqual(receipt.result);
  });

  it("bounds a non-cooperative timeout while preserving its workspace and reporting unconfirmed cleanup", async () => {
    const seenRoots: string[] = [];
    const service = serviceWith(
      [
        provider("stuck", async (_inputValue, context) => {
          seenRoots.push(context.workspace.root);
          return new Promise<VerificationResult>(() => {});
        }),
      ],
      "stuck",
      { timeoutMs: 25, shutdownTimeoutMs: 100 },
    );

    const startedAt = Date.now();
    const receipt = await service.verifyWithReceipt(input());
    const result = receipt.result;

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.targetAssessment).toBe("inconclusive");
    expect(result.summary).toBe(
      "Verification framework could not complete: Verification strategy timed out",
    );
    expect(result.issues).toEqual([
      {
        id: "strategy-timeout",
        kind: "strategy-timeout",
        message: "Verification strategy timed out",
        evidenceArtifactIds: [],
      },
    ]);
    expect(result.strategyReport).toEqual({
      frameworkError: "Verification strategy timed out",
      errorName: "TimeoutError",
    });
    expect(existsSync(seenRoots[0]!)).toBe(true);
    expect(result.problems).toContainEqual({
      code: "internal_error",
      message: expect.stringMatching(
        /shutdown unconfirmed.*cleanup skipped.*Workspace preserved/,
      ),
    });
    expect(
      JSON.parse(
        readFileSync(join(artifactRoot, receipt.resultArtifact!.path), "utf8"),
      ),
    ).toEqual(result);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid shutdown wait budget %s",
    (shutdownTimeoutMs) => {
      expect(() =>
        serviceWith([provider("first")], "first", { shutdownTimeoutMs }),
      ).toThrow(/shutdown timeout/i);
    },
  );

  it("preserves active resources and cleanup diagnostics when the final receipt cannot be persisted", async () => {
    const recorders = vi.spyOn(recording, "createRunRecorder");
    let workspace = "";
    let artifactPath = "";
    const receipt = await serviceWith(
      [
        provider("stuck", async (_value, context) => {
          workspace = context.workspace.root;
          artifactPath = (await evidence(context)).path;
          vi.mocked(fs.renameSync).mockImplementationOnce(() => {
            throw new Error("receipt write failed");
          });
          return new Promise<VerificationResult>(() => {});
        }),
      ],
      "stuck",
      { timeoutMs: 10, shutdownTimeoutMs: 50 },
    ).verifyWithReceipt(input());
    expect(receipt.resultArtifact).toBeUndefined();
    expect(receipt.result).toMatchObject({
      executionStatus: "failed",
      targetAssessment: "inconclusive",
    });
    expect(receipt.result.problems).toEqual([
      expect.objectContaining({ code: "artifact_persistence_failed" }),
      expect.objectContaining({
        code: "internal_error",
        message: expect.stringContaining("shutdown unconfirmed"),
      }),
    ]);
    expect(existsSync(workspace)).toBe(true);
    expect(readFileSync(join(artifactRoot, artifactPath), "utf8")).toBe("xxx");
    const cleanup = recorders.mock.results[0]!.value.snapshot().stages.find(
      (stage: { name: string }) => stage.name === "workspace-cleanup",
    );
    expect(cleanup).toMatchObject({
      state: "failed",
      error: expect.stringContaining("cleanup skipped"),
    });
  });

  it.each(["timeout", "caller", "caller-after-timeout", "caller-sync"])(
    "keeps cooperative findings after %s without passing an interrupted run",
    async (origin) => {
      const controller = new AbortController();
      const resultNow = vi.fn(() => now);
      const timeoutController = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(
        timeoutController.signal,
      );
      const service = serviceWith(
        [
          provider("first", async (value, context, signal) => {
            const abort =
              origin === "timeout" || origin === "caller-after-timeout"
                ? () =>
                    timeoutController.abort(
                      new DOMException("deadline", "TimeoutError"),
                    )
                : () => controller.abort(new Error("caller stopped"));
            if (origin === "caller-sync") abort();
            else setTimeout(abort, 0);
            if (!signal!.aborted)
              await new Promise<void>((resolve) => {
                signal!.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (origin === "caller-after-timeout")
              controller.abort("caller stopped");
            const artifact = await evidence(context);
            return {
              ...okResult(value, descriptor("first")),
              artifacts: [artifact],
            };
          }),
        ],
        "first",
        { now: resultNow },
      );
      const receipt = await service.verifyWithReceipt(
        input(),
        {},
        controller.signal,
      );
      expect(resultNow).toHaveBeenCalledTimes(1);
      expect(receipt.result).toMatchObject({
        executionStatus: origin === "timeout" ? "partial" : "cancelled",
        targetAssessment: "no_bug_observed",
        problems: [
          { code: origin === "timeout" ? "agent_timeout" : "cancelled" },
        ],
      });
      expect(receipt.result.artifacts).toHaveLength(1);
      expect(
        JSON.parse(
          readFileSync(
            join(artifactRoot, receipt.resultArtifact!.path),
            "utf8",
          ),
        ),
      ).toEqual(receipt.result);
      expect(readdirSync(workspaceRoot)).toEqual([]);
    },
  );

  it("bounds non-cooperative caller cancellation and consumes a late rejection", async () => {
    const controller = new AbortController();
    let rejectLate!: (reason: Error) => void;
    const service = serviceWith(
      [
        provider("stuck", (_value, _context) => {
          controller.abort(new Error("caller stopped"));
          return new Promise((_resolve, reject) => {
            rejectLate = reject;
          });
        }),
      ],
      "stuck",
      { shutdownTimeoutMs: 100 },
    );
    const startedAt = Date.now();
    const receipt = await service.verifyWithReceipt(
      input(),
      {},
      controller.signal,
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(receipt.result).toMatchObject({
      executionStatus: "cancelled",
      problems: [
        { code: "cancelled", message: "caller stopped" },
        {
          code: "internal_error",
          message: expect.stringContaining("shutdown unconfirmed"),
        },
      ],
    });
    const preserved = readdirSync(workspaceRoot);
    expect(preserved).toHaveLength(1);
    rejectLate(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readdirSync(workspaceRoot)).toEqual(preserved);
  });

  it("preserves the active workspace for late local writes but rejects late receipt artifact writes", async () => {
    let writeLateArtifact!: () =>
      | Promise<VerificationResult["artifacts"][number]>
      | VerificationResult["artifacts"][number];
    let keptWorkspace: string | undefined;
    const service = serviceWith(
      [
        provider("late-writer", async (_inputValue, context) => {
          keptWorkspace = context.workspace.root;
          writeLateArtifact = () => {
            const evidencePath = join(
              context.workspace.evidenceRoot,
              "late.json",
            );
            writeFileSync(evidencePath, "{}\n", "utf8");
            return context.writeArtifact({
              id: "late-artifact",
              kind: "report",
              path: "late.json",
              contentHash: "0".repeat(64),
              mediaType: "application/json",
            });
          };
          return new Promise<VerificationResult>(() => {});
        }),
      ],
      "late-writer",
      { timeoutMs: 25, shutdownTimeoutMs: 100 },
    );

    const receipt = await service.verifyWithReceipt(input());
    const result = receipt.result;
    expect(result.targetAssessment).toBe("inconclusive");
    expect(keptWorkspace).toBeDefined();
    expect(existsSync(keptWorkspace!)).toBe(true);

    await expect(
      Promise.resolve().then(() => writeLateArtifact()),
    ).rejects.toThrow(/closed/i);
    expect(readFileSync(join(keptWorkspace!, "agent/late.json"), "utf8")).toBe(
      "{}\n",
    );
    expect(
      JSON.parse(
        readFileSync(join(artifactRoot, receipt.resultArtifact!.path), "utf8"),
      ),
    ).toEqual(result);
    expect(
      readdirSync(
        join(artifactRoot, receipt.resultArtifact!.path.split("/")[0]!),
      ),
    ).toEqual([receipt.resultArtifact!.path.split("/").at(-1)]);
  });

  it("requires result artifacts to match artifacts written through the workspace", async () => {
    const unwrittenArtifact = {
      id: "artifact-1",
      kind: "report",
      path: "reports/result.json",
      contentHash: sha256("{}\n"),
      mediaType: "application/json",
    };
    const missing = serviceWith(
      [
        provider("first", async (inputValue) =>
          createVerificationResult(
            inputValue,
            descriptor("first"),
            {
              ...reportAssessment(),
              summary: "verified",
              issues: [],
              artifacts: [unwrittenArtifact],
              strategyReport: {},
            },
            () => now,
          ),
        ),
      ],
      "first",
    );
    expect((await missing.verify(input())).targetAssessment).toBe(
      "inconclusive",
    );

    const altered = serviceWith(
      [
        provider("first", async (inputValue, context) => {
          const evidencePath = join(
            context.workspace.evidenceRoot,
            "reports/result.json",
          );
          mkdirSync(dirname(evidencePath), { recursive: true });
          writeFileSync(evidencePath, "{}\n", "utf8");
          const written = await context.writeArtifact(unwrittenArtifact);
          expect(written.path).toMatch(/^attempt-/);
          return createVerificationResult(
            inputValue,
            descriptor("first"),
            {
              ...reportAssessment(),
              summary: "verified",
              issues: [],
              artifacts: [
                { ...written, path: written.path, contentHash: "f".repeat(64) },
              ],
              strategyReport: {},
            },
            () => now,
          );
        }),
      ],
      "first",
    );
    expect((await altered.verify(input())).targetAssessment).toBe(
      "inconclusive",
    );
  });

  it("cleans temporary workspaces unless keepWorkspace is requested", async () => {
    const seenRoots: string[] = [];
    const service = serviceWith(
      [
        provider("first", async (inputValue, context) => {
          seenRoots.push(context.workspace.root);
          return okResult(inputValue, descriptor("first"));
        }),
      ],
      "first",
    );

    await service.verify(input());
    expect(existsSync(seenRoots[0]!)).toBe(false);

    await service.verify(input(), { keepWorkspace: true });
    expect(existsSync(seenRoots[1]!)).toBe(true);
  });
});

function serviceWith(
  providers: VerificationStrategyProvider[],
  defaultStrategyId: string,
  options: {
    timeoutMs?: number;
    shutdownTimeoutMs?: number;
    now?: () => string;
  } = {},
): VerificationService {
  return new VerificationService({
    factory: new VerificationStrategyFactory(providers),
    defaultStrategyId,
    workspaceRoot,
    artifactRoot,
    now: () => now,
    ...options,
  });
}

function provider(
  id: string,
  verify: VerificationStrategy["verify"] = async (inputValue) =>
    okResult(inputValue, descriptor(id)),
): VerificationStrategyProvider {
  return {
    descriptor: descriptor(id),
    create: () => ({ verify }),
  };
}

function descriptor(id: string): VerificationStrategyDescriptor {
  return { id, version: "1.0.0", displayName: `${id} Strategy` };
}

function reportAssessment(
  targetAssessment: VerificationAssessment["targetAssessment"] = "no_bug_observed",
): VerificationAssessment {
  const { testBasis: _basis, ...policy } = resolveVerificationPolicy(input());
  return {
    ...policy,
    executionStatus: "completed",
    sourceAssessment: "not_checked",
    targetAssessment,
    problems: [],
  };
}

function okResult(
  inputValue: VerificationInput,
  strategyDescriptor: VerificationStrategyDescriptor,
): VerificationResult {
  return createVerificationResult(
    inputValue,
    strategyDescriptor,
    {
      ...reportAssessment(),
      summary: "verified",
      issues: [],
      artifacts: [],
      strategyReport: { ok: true },
    },
    () => now,
  );
}

function input(files: FilePatch[] = [modifiedPatch()]): VerificationInput {
  return {
    schemaVersion: "1.0",
    request: {
      sourceBundle: {
        files: [
          {
            path: "src/source.ts",
            content: sourceContent,
            contentHash: sha256(sourceContent),
          },
        ],
      },
      targetContext: {
        sourceFiles: [
          {
            path: "src/target.py",
            content: originalTargetContent,
            contentHash: sha256(originalTargetContent),
          },
        ],
      },
    } as AdaptationRequestV2,
    analysisReport: { kind: "analysis" },
    migrationPlan: { kind: "plan" },
    translation: {
      round: 1,
      generatedContent: translatedTargetContent,
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

function modifiedPatch(): FilePatch {
  return {
    path: "src/target.py",
    status: "modified",
    expectedOriginalSha256: sha256(originalTargetContent),
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1,2 +1,2 @@",
        lines: [
          { type: "context", content: "def target():" },
          { type: "remove", content: "    raise NotImplementedError()" },
          { type: "add", content: "    return 1" },
        ],
      },
    ],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
