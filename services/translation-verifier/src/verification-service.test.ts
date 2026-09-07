import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markVerificationPhase, measureVerification } from "./run-output/measure-legacy-run.js";
import * as recording from "./run-output/record-run.js";
import { VerificationService } from "./verification-service.js";
import { VerificationStrategyFactory } from "./strategies/strategy-registry.js";
import { createVerificationResult } from "./run-output/create-verification-result.js";
import { type VerificationInput, type VerificationResult, type VerificationStrategy, type VerificationStrategyContext, type VerificationStrategyDescriptor, type VerificationStrategyProvider } from "./schemas/verification-types.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const fsRename = vi.mocked(fs.renameSync).getMockImplementation()!;

const sourceContent = "export function source() {\n  return 1;\n}\n";
const originalTargetContent = "def target():\n    raise NotImplementedError()\n";
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
  it("short-circuits synchronous preflight without materializing a workspace but persists the receipt", async () => {
    const recorder = vi.spyOn(recording, "createRunRecorder");
    const verify = vi.fn();
    const prepareWorkspace = vi.fn();
    const p = provider("first", verify);
    p.create = () => ({ verify, prepareWorkspace, preflight: () => ({
      status: "unverified", summary: "unsupported context", issues: [], artifacts: [], strategyReport: {},
    }) });
    writeFileSync(workspaceRoot, "expensive workspace must not be touched");
    const receipt = await serviceWith([p], "first").verifyWithReceipt(input());
    expect(receipt.result.summary).toBe("unsupported context");
    expect(receipt.resultArtifact).toBeDefined();
    expect(verify).not.toHaveBeenCalled();
    expect(prepareWorkspace).not.toHaveBeenCalled();
    expect(recorder.mock.results[0]!.value.snapshot().stages.map((stage: { state: string }) => stage.state))
      .toEqual(["completed", "skipped", "skipped", "skipped", "skipped", "completed"]);
  });

  it.each(["ordinary", "timeout", "abort"])("preserves %s preflight error semantics before workspace preparation", async (kind) => {
    const recorder = vi.spyOn(recording, "createRunRecorder");
    const error = kind === "ordinary" ? new Error("preflight failed") : new DOMException(kind, kind === "abort" ? "AbortError" : "TimeoutError");
    const verify = vi.fn();
    const p = provider("first", verify);
    p.create = () => ({ verify, preflight: () => { throw error; } });
    writeFileSync(workspaceRoot, "must not materialize");
    const pending = serviceWith([p], "first").verifyWithReceipt(input());
    if (kind === "abort") await expect(pending).rejects.toBe(error);
    else {
      const receipt = await pending;
      expect(receipt.result.issues[0]?.kind).toBe(kind === "timeout" ? "strategy-timeout" : "framework-error");
      expect(receipt.resultArtifact).toBeDefined();
    }
    expect(verify).not.toHaveBeenCalled();
    const stages = recorder.mock.results[0]!.value.snapshot().stages;
    expect(stages[0].state).toBe(kind === "abort" ? "cancelled" : "failed");
    expect(stages.slice(1, 5).map((stage: { state: string }) => stage.state)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  });

  it("propagates caller cancellation raised during a synchronous preflight before accepting its early output", async () => {
    const controller = new AbortController();
    const error = new DOMException("cancelled in preflight", "AbortError");
    const p = provider("first");
    p.create = () => ({ verify: vi.fn(), preflight: () => {
      controller.abort(error);
      return { status: "unverified", summary: "early", issues: [], artifacts: [], strategyReport: {} };
    } });
    await expect(serviceWith([p], "first").verifyWithReceipt(input(), {}, controller.signal)).rejects.toBe(error);
    expect(existsSync(artifactRoot)).toBe(false);
  });

  it("records legacy providers under stage 4 and completes preparation only after its synchronous hook", async () => {
    const recorder = vi.spyOn(recording, "createRunRecorder");
    const order: string[] = [];
    const p = provider("first", async (value, context) => {
      order.push("verify");
      expect(readFileSync(join(context.workspace.targetRoot, "src/target.py"), "utf8")).toBe(translatedTargetContent);
      expect(recording.currentRunRecorder()!.snapshot().stages.map((stage) => stage.state))
        .toEqual(["completed", "completed", "skipped", "running", "not-started", "not-started"]);
      return okResult(value, descriptor("first"));
    });
    const legacy = p.create();
    p.create = () => ({ ...legacy,
      preflight: () => { order.push("preflight"); return undefined; },
      prepareWorkspace: (_input, context) => {
        order.push("prepare");
        expect(Number.isFinite(context.deadlineAt)).toBe(true);
        expect(recording.currentRunRecorder()!.snapshot().stages[1].state).toBe("running");
      },
    });
    expect((await serviceWith([p], "first").verify(input())).status).toBe("pass");
    expect(order).toEqual(["preflight", "prepare", "verify"]);
    const run = recorder.mock.results[0]!.value.snapshot();
    expect(run.stages.map((stage: { state: string }) => stage.state)).toEqual(["completed", "completed", "skipped", "completed", "skipped", "completed"]);
    expect(run.diagnostics).toEqual([]);
    expect(run.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("isolates concurrent requests inside legacy timing while preserving both phase streams", async () => {
    const requests: recording.RunRecorder[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const service = serviceWith([provider("first", async (value) => {
      requests.push(recording.currentRunRecorder()!);
      if (requests.length === 2) release();
      await barrier;
      return okResult(value, descriptor("first"));
    })], "first");
    const outer = recording.createRunRecorder({ runId: "outer-measurement" });
    const measured = await recording.withRunRecorder(outer, () => measureVerification(() => Promise.all([service.verifyWithReceipt(input()), service.verifyWithReceipt(input())])));
    expect(measured.value.map((receipt) => receipt.result.status)).toEqual(["pass", "pass"]);
    expect(new Set(requests.map((recorder) => recorder.runId)).size).toBe(2);
    expect(requests.every((recorder) => recorder !== outer)).toBe(true);
    for (const recorder of requests) {
      expect(recorder.snapshot().stages.map((stage) => stage.state)).toEqual(["completed", "completed", "skipped", "completed", "skipped", "completed"]);
      expect(recorder.snapshot().diagnostics).toEqual([]);
      expect(recorder.events().every((event) => event.runId === recorder.runId)).toBe(true);
    }
    expect(outer.snapshot().stages.every((stage) => stage.state === "not-started")).toBe(true);
    expect(measured.timing.phases.filter((phase) => phase.phase === "request-validation-and-strategy-selection")).toHaveLength(2);
    expect(measured.timing.phases.filter((phase) => phase.phase === "response-ready")).toHaveLength(2);
  });

  it("does not forward late request phases into an enclosing measurement after timeout", async () => {
    let resume!: () => void;
    let wrote!: () => void;
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    const observed = new Promise<void>((resolve) => { wrote = resolve; });
    const service = serviceWith([provider("first", async (value) => {
      await wait;
      markVerificationPhase("late-provider-phase");
      wrote();
      return okResult(value, descriptor("first"));
    })], "first", { timeoutMs: 10 });
    const measured = await measureVerification(async () => {
      const result = await service.verify(input());
      resume();
      await observed;
      return result;
    });
    expect(measured.value.status).toBe("unverified");
    expect(measured.timing.phases.some((phase) => phase.phase === "late-provider-phase")).toBe(false);
  });

  async function evidence(context: VerificationStrategyContext, bytes = 3) {
    writeFileSync(join(context.workspace.evidenceRoot, "report.json"), Buffer.alloc(bytes, "x"));
    return context.writeArtifact({ id: "report", kind: "report", path: "report.json", contentHash: "0".repeat(64), mediaType: "application/json" });
  }

  it.each(["source", "oversized-artifact", "oversized-result", "cumulative-budget", "destination"])("fails closed on %s persistence failure and removes only this attempt's durable artifacts", async (failure) => {
    const previous = await serviceWith([provider("first")], "first").verifyWithReceipt(input());
    const previousBytes = readFileSync(join(artifactRoot, previous.resultArtifact!.path));
    const service = serviceWith([provider("first", async (inputValue, context) => {
      const artifact = await evidence(context, failure === "cumulative-budget" ? 10 * 1024 * 1024 : 3);
      if (failure === "source") await context.writeArtifact({ ...artifact, id: "missing", path: "missing.json" });
      if (failure === "oversized-artifact") {
        writeFileSync(join(context.workspace.evidenceRoot, "big.json"), Buffer.alloc(10 * 1024 * 1024 + 1));
        await context.writeArtifact({ ...artifact, id: "big", path: "big.json" });
      }
      if (failure === "destination") {
        // A non-directory artifact-root parent is a real ENOTDIR persistence failure.
        rmSync(join(artifactRoot, artifact.path.split("/")[0]!), { recursive: true });
        writeFileSync(join(artifactRoot, artifact.path.split("/")[0]!), "blocked");
      }
      return createVerificationResult(inputValue, descriptor("first"), {
        status: "pass", summary: "verified", issues: [], artifacts: [artifact],
        strategyReport: failure === "oversized-result" ? { output: "x".repeat(10 * 1024 * 1024) } : {},
      }, () => now);
    })], "first");
    const receipt = await service.verifyWithReceipt(input());
    expect(receipt.resultArtifact).toBeUndefined();
    expect(receipt.result).toMatchObject({ status: "unverified", artifacts: [], issues: [{ kind: "artifact-persistence-failed" }] });
    expect(readFileSync(join(artifactRoot, previous.resultArtifact!.path))).toEqual(previousBytes);
    expect(readdirSync(artifactRoot)).toEqual([previous.resultArtifact!.path.split("/")[0]]);
  });

  it.each(["strategy", "provider", "caller"])("propagates the identical %s AbortError and discards abandoned attempt artifacts", async (origin) => {
    const error = new DOMException("cancelled", "AbortError");
    const controller = new AbortController();
    const p = provider("first", async (_inputValue, context) => {
      await evidence(context);
      if (origin === "caller") controller.abort(error);
      throw error;
    });
    if (origin === "provider") p.create = () => { throw error; };
    await expect(serviceWith([p], "first").verifyWithReceipt(input(), {}, controller.signal)).rejects.toBe(error);
    expect(existsSync(artifactRoot) ? readdirSync(artifactRoot) : []).toEqual([]);
  });

  it.each(["missing", "file", "symlink"])("preserves AbortError when the durable root becomes %s during cleanup", async (replacement) => {
    const abort = new DOMException("cancelled", "AbortError");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "sentinel"), "untouched");
    const service = serviceWith([provider("first", async (_inputValue, context) => {
      await evidence(context);
      rmSync(artifactRoot, { recursive: true });
      if (replacement === "file") writeFileSync(artifactRoot, "blocked");
      if (replacement === "symlink") fs.symlinkSync(outside, artifactRoot, "dir");
      throw abort;
    })], "first");
    await expect(service.verifyWithReceipt(input())).rejects.toBe(abort);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("untouched");
    expect(readdirSync(workspaceRoot)).toEqual([]);
  });

  it("does not retry a transient final-result persistence failure", async () => {
    const service = serviceWith([provider("first", async (inputValue, context) => {
      const artifact = await evidence(context);
      vi.mocked(fs.renameSync).mockClear().mockImplementationOnce(() => { throw new Error("transient result rename failure"); });
      return createVerificationResult(inputValue, descriptor("first"), {
        status: "pass", summary: "verified", issues: [], artifacts: [artifact], strategyReport: {},
      }, () => now);
    })], "first");
    const receipt = await service.verifyWithReceipt(input());
    expect(receipt.resultArtifact).toBeUndefined();
    expect(receipt.result).toMatchObject({ status: "unverified", artifacts: [], issues: [{ kind: "artifact-persistence-failed" }] });
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
    expect(readdirSync(artifactRoot)).toEqual([]);
  });

  it("does not delete another attempt through a replaced attempt symlink", async () => {
    const previous = await serviceWith([provider("first")], "first").verifyWithReceipt(input());
    const bytes = readFileSync(join(artifactRoot, previous.resultArtifact!.path));
    const abort = new DOMException("cancelled", "AbortError");
    const service = serviceWith([provider("first", async (_inputValue, context) => {
      const artifact = await evidence(context);
      const attempt = join(artifactRoot, artifact.path.split("/")[0]!);
      rmSync(attempt, { recursive: true });
      fs.symlinkSync(join(artifactRoot, previous.resultArtifact!.path.split("/")[0]!), attempt, "dir");
      throw abort;
    })], "first");
    await expect(service.verifyWithReceipt(input())).rejects.toBe(abort);
    expect(readFileSync(join(artifactRoot, previous.resultArtifact!.path))).toEqual(bytes);
    expect(readdirSync(artifactRoot)).toEqual([previous.resultArtifact!.path.split("/")[0]]);
  });

  it.each(["strategy", "provider"])("normalizes a %s-thrown TimeoutError without caller cancellation", async (origin) => {
    const p = provider("first", async () => { throw new DOMException("timeout", "TimeoutError"); });
    if (origin === "provider") p.create = () => { throw new DOMException("timeout", "TimeoutError"); };
    const result = await serviceWith([p], "first").verifyWithReceipt(input());
    expect(result.result).toMatchObject({ status: "unverified", issues: [{ kind: "strategy-timeout" }] });
    expect(result.resultArtifact).toBeDefined();
  });

  it("preserves workspace creation errors instead of manufacturing receipts", async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(workspaceRoot, "blocked");
    await expect(serviceWith([provider("first")], "first").verifyWithReceipt(input())).rejects.toThrow();
    expect(existsSync(artifactRoot)).toBe(false);
  });

  it("uses the default strategy and permits an explicit registered strategy", async () => {
    const service = serviceWith([provider("first"), provider("second")], "first");

    expect((await service.verify(input())).strategyId).toBe("first");
    expect((await service.verify(input(), { strategyId: "second" })).strategyId).toBe("second");
    expect(service.listStrategies().map((descriptor) => descriptor.id)).toEqual(["first", "second"]);
  });

  it("persists an exact identified receipt result artifact", async () => {
    const receipt = await serviceWith([provider("first")], "first").verifyWithReceipt(input());
    const artifact = receipt.resultArtifact!;
    const bytes = readFileSync(join(artifactRoot, artifact.path));
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(receipt.result);
    expect(artifact.id).toContain(artifact.path);
    expect(artifact.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(artifact.size).toBe(bytes.byteLength);
    expect(artifact.kind).toBe("verification-result");
  });
  it("normalizes a strategy exception but preserves caller cancellation", async () => {
    const failingService = serviceWith([provider("failing", async () => { throw new Error("boom"); })], "failing");
    expect((await failingService.verify(input())).status).toBe("unverified");

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(serviceWith([provider("first")], "first").verify(input(), {}, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws invalid input and unknown strategy IDs before creating a workspace", async () => {
    const service = serviceWith([provider("first")], "first");
    await expect(service.verify({ ...input(), translation: { ...input().translation, patchHash: "f".repeat(64) } }))
      .rejects.toThrow(/patch hash/i);
    await expect(service.verify(input(), { strategyId: "missing" })).rejects.toThrow(/unknown/i);
    expect(existsSync(workspaceRoot) ? readdirSync(workspaceRoot) : []).toEqual([]);
  });

  it("normalizes empty strategy errors to a nonempty framework issue", async () => {
    const emptyError = serviceWith([provider("empty-error", async () => { throw new Error(""); })], "empty-error");
    const result = await emptyError.verify(input());
    expect(result.status).toBe("unverified");
    expect(result.summary).toBe("Verification framework could not complete: Unknown verification error");
    expect(result.issues[0]?.message).toBe("Unknown verification error");

    const emptyString = serviceWith([provider("empty-string", async () => { throw ""; })], "empty-string");
    expect((await emptyString.verify(input())).issues[0]?.message).toBe("Unknown verification error");
  });

  it("normalizes a pre-aborted non-AbortError without executing the strategy", async () => {
    let executed = false;
    const service = serviceWith([provider("first", async (inputValue) => {
      executed = true;
      return okResult(inputValue, descriptor("first"));
    })], "first");
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));

    const result = await service.verify(input(), {}, controller.signal);

    expect(result.status).toBe("unverified");
    expect(result.issues[0]?.message).toBe("caller stopped");
    expect(executed).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(true);
  });

  it("turns result identity mismatches and timeouts into unverified framework errors", async () => {
    const wrongResult = serviceWith([provider("first", async () => ({
      status: "fail",
      summary: "invalid",
      issues: [],
      artifacts: [],
      strategyReport: {},
    }))], "first");
    const mismatch = await wrongResult.verify(input());
    expect(mismatch.status).toBe("unverified");
    expect(mismatch.issues[0]).toMatchObject({ id: "framework-error", kind: "framework-error" });

    const timeoutService = serviceWith([provider("slow", async (_inputValue, _context, signal) => {
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    })], "slow", { timeoutMs: 1 });
    const timeout = await timeoutService.verify(input());
    expect(timeout.status).toBe("unverified");
    expect(timeout.strategyId).toBe("slow");
    expect(timeout.subjectHash).toBe(input().translation.patchHash);
    expect(timeout.summary).toBe("Verification framework could not complete: Verification strategy timed out");
  });

  it("returns promptly on a non-cooperative strategy timeout and cleans the workspace", async () => {
    const seenRoots: string[] = [];
    const service = serviceWith([provider("stuck", async (_inputValue, context) => {
      seenRoots.push(context.workspace.root);
      return new Promise<VerificationResult>(() => {});
    })], "stuck", { timeoutMs: 25 });

    const startedAt = Date.now();
    const result = await service.verify(input());

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(result.status).toBe("unverified");
    expect(result.summary).toBe("Verification framework could not complete: Verification strategy timed out");
    expect(result.issues).toEqual([{
      id: "strategy-timeout",
      kind: "strategy-timeout",
      message: "Verification strategy timed out",
      evidenceArtifactIds: [],
    }]);
    expect(result.strategyReport).toEqual({
      frameworkError: "Verification strategy timed out",
      errorName: "TimeoutError",
    });
    expect(existsSync(seenRoots[0]!)).toBe(false);
  });

  it("rejects late artifact writes after a timed-out strategy returns to the caller", async () => {
    let writeLateArtifact!: () => Promise<VerificationResult["artifacts"][number]> | VerificationResult["artifacts"][number];
    let keptWorkspace: string | undefined;
    const service = serviceWith([provider("late-writer", async (_inputValue, context) => {
      keptWorkspace = context.workspace.root;
      writeLateArtifact = () => {
        const evidencePath = join(context.workspace.evidenceRoot, "reports/late.json");
        mkdirSync(dirname(evidencePath), { recursive: true });
        writeFileSync(evidencePath, "{}\n", "utf8");
        return context.writeArtifact({
          id: "late-artifact",
          kind: "report",
          path: "reports/late.json",
          contentHash: "0".repeat(64),
          mediaType: "application/json",
        });
      };
      return new Promise<VerificationResult>(() => {});
    })], "late-writer", { timeoutMs: 25 });

    const result = await service.verify(input(), { keepWorkspace: true });
    expect(result.status).toBe("unverified");
    expect(keptWorkspace).toBeDefined();
    expect(existsSync(keptWorkspace!)).toBe(true);

    await expect(Promise.resolve().then(() => writeLateArtifact())).rejects.toThrow(/closed/i);
    expect(existsSync(join(artifactRoot, "reports/late.json"))).toBe(false);
  });

  it("requires result artifacts to match artifacts written through the workspace", async () => {
    const unwrittenArtifact = {
      id: "artifact-1",
      kind: "report",
      path: "reports/result.json",
      contentHash: sha256("{}\n"),
      mediaType: "application/json",
    };
    const missing = serviceWith([provider("first", async (inputValue) => createVerificationResult(inputValue, descriptor("first"), {
      status: "pass",
      summary: "verified",
      issues: [],
      artifacts: [unwrittenArtifact],
      strategyReport: {},
    }, () => now))], "first");
    expect((await missing.verify(input())).status).toBe("unverified");

    const altered = serviceWith([provider("first", async (inputValue, context) => {
      const evidencePath = join(context.workspace.evidenceRoot, "reports/result.json");
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, "{}\n", "utf8");
      const written = await context.writeArtifact(unwrittenArtifact);
      expect(written.path).toMatch(/^attempt-/);
      return createVerificationResult(inputValue, descriptor("first"), {
        status: "pass",
        summary: "verified",
        issues: [],
        artifacts: [{ ...written, path: written.path, contentHash: "f".repeat(64) }],
        strategyReport: {},
      }, () => now);
    })], "first");
    expect((await altered.verify(input())).status).toBe("unverified");
  });

  it("cleans temporary workspaces unless keepWorkspace is requested", async () => {
    const seenRoots: string[] = [];
    const service = serviceWith([provider("first", async (inputValue, context) => {
      seenRoots.push(context.workspace.root);
      return okResult(inputValue, descriptor("first"));
    })], "first");

    await service.verify(input());
    expect(existsSync(seenRoots[0]!)).toBe(false);

    await service.verify(input(), { keepWorkspace: true });
    expect(existsSync(seenRoots[1]!)).toBe(true);
  });
});

function serviceWith(
  providers: VerificationStrategyProvider[],
  defaultStrategyId: string,
  options: { timeoutMs?: number } = {},
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
  verify: VerificationStrategy["verify"] = async (inputValue) => okResult(inputValue, descriptor(id)),
): VerificationStrategyProvider {
  return {
    descriptor: descriptor(id),
    create: () => ({ verify }),
  };
}

function descriptor(id: string): VerificationStrategyDescriptor {
  return { id, version: "1.0.0", displayName: `${id} Strategy` };
}

function okResult(inputValue: VerificationInput, strategyDescriptor: VerificationStrategyDescriptor): VerificationResult {
  return createVerificationResult(inputValue, strategyDescriptor, {
    status: "pass",
    summary: "verified",
    issues: [],
    artifacts: [],
    strategyReport: { ok: true },
  }, () => now);
}

function input(files: FilePatch[] = [modifiedPatch()]): VerificationInput {
  return {
    schemaVersion: "1.0",
    request: {
      sourceBundle: {
        files: [{ path: "src/source.ts", content: sourceContent, contentHash: sha256(sourceContent) }],
      },
      targetContext: {
        sourceFiles: [{ path: "src/target.py", content: originalTargetContent, contentHash: sha256(originalTargetContent) }],
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
    hunks: [{
      header: "@@ -1,2 +1,2 @@",
      lines: [
        { type: "context", content: "def target():" },
        { type: "remove", content: "    raise NotImplementedError()" },
        { type: "add", content: "    return 1" },
      ],
    }],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
