import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect((await timeoutService.verify(input())).status).toBe("unverified");
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
