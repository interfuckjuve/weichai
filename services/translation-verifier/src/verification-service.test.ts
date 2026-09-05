import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VerificationService } from "./verification-service.js";
import { VerificationStrategyFactory } from "./verification-strategy-factory.js";
import {
  createVerificationResult,
  type VerificationInput,
  type VerificationResult,
  type VerificationStrategy,
  type VerificationStrategyContext,
  type VerificationStrategyDescriptor,
  type VerificationStrategyProvider,
} from "./verification-types.js";

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
  rmSync(root, { recursive: true, force: true });
});

describe("VerificationService", () => {
  it("uses the default strategy and permits an explicit registered strategy", async () => {
    const service = serviceWith([provider("first"), provider("second")], "first");

    expect((await service.verify(input())).strategyId).toBe("first");
    expect((await service.verify(input(), { strategyId: "second" })).strategyId).toBe("second");
    expect(service.listStrategies().map((descriptor) => descriptor.id)).toEqual(["first", "second"]);
  });

  it("persists an exact identified receipt result artifact", async () => {
    const receipt = await serviceWith([provider("first")], "first").verifyWithReceipt(input());
    const bytes = readFileSync(join(artifactRoot, receipt.resultArtifact.path));
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(receipt.result);
    expect(receipt.resultArtifact.id).toContain(receipt.resultArtifact.path);
    expect(receipt.resultArtifact.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(receipt.resultArtifact.size).toBe(bytes.byteLength);
    expect(receipt.resultArtifact.kind).toBe("verification-result");
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
    const wrongResult = serviceWith([provider("first", async (inputValue) => ({
      ...okResult(inputValue, descriptor("first")),
      subjectHash: "f".repeat(64),
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
