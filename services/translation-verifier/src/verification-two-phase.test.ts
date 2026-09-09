import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  VerificationInput,
  VerificationPreparation,
  VerificationStrategyContext,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
  TwoPhaseVerificationStrategy,
} from "./schemas/verification-types.js";
import { VerificationService } from "./verification-service.js";
import { runVerificationCli } from "./verification-cli.js";
import { VerificationStrategyFactory } from "./workflow/strategy-registry.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const descriptor = {
  id: "two-phase-fixture",
  version: "1.0.0",
  displayName: "Two phase fixture",
};
const preparation: VerificationPreparation = {
  schemaVersion: "1.0",
  strategyId: descriptor.id,
  strategyVersion: descriptor.version,
  inputHash: "a".repeat(64),
  contentHash: "b".repeat(64),
  payload: { files: [{ path: "test.txt", content: "frozen test" }] },
};
const output: VerificationStrategyOutput = {
  mode: "target_only",
  referenceDecision: "undetermined",
  referenceReason: "No reference selected",
  executionStatus: "completed",
  sourceAssessment: "not_checked",
  targetAssessment: "no_bug_observed",
  problems: [],
  summary: "Completed",
  issues: [],
  artifacts: [],
  strategyReport: {},
};
const patches: FilePatch[] = [
  {
    path: "target.txt",
    status: "modified",
    expectedOriginalSha256: hash("original\n"),
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        lines: [
          { type: "remove", content: "original" },
          { type: "add", content: "translated" },
        ],
      },
    ],
  },
];
function input(): VerificationInput {
  return {
    schemaVersion: "1.0",
    request: {
      sourceBundle: {
        files: [
          {
            path: "source.txt",
            content: "source",
            contentHash: hash("source"),
          },
        ],
      },
      targetContext: {
        sourceFiles: [
          {
            path: "target.txt",
            content: "original\n",
            contentHash: hash("original\n"),
          },
        ],
      },
    } as AdaptationRequestV2,
    analysisReport: { kind: "analysis" },
    migrationPlan: { kind: "plan" },
    translation: {
      round: 0,
      generatedContent: "translated\n",
      files: patches,
      patchHash: calculatePatchHashV2(patches),
    },
  };
}
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-two-phase-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
function setup(
  overrides: Partial<TwoPhaseVerificationStrategy> = {},
  timeoutMs = 1000,
) {
  const strategy = {
    prepareTests: vi.fn(async () => preparation),
    verifyTranslation: vi.fn(async () => output),
    ...overrides,
  };
  const create = vi.fn(() => strategy);
  const provider: VerificationStrategyProvider = {
    descriptor,
    lifecycle: "two-phase",
    create,
  };
  const service = new VerificationService({
    factory: new VerificationStrategyFactory([provider]),
    defaultStrategyId: descriptor.id,
    workspaceRoot: join(root, "workspaces"),
    artifactRoot: join(root, "artifacts"),
    timeoutMs,
    shutdownTimeoutMs: 10,
  });
  return { service, strategy, create };
}

describe("explicit two-phase framework lifecycle", () => {
  it.each(["inputHash", "contentHash"])("rejects non-string preparation %s", async field => {
    const malformed = JSON.parse(JSON.stringify(preparation)); malformed[field] = [preparation.contentHash];
    const { service } = setup({ prepareTests: async () => malformed });
    await expect(service.prepareTests(input())).rejects.toThrow(/capsule is invalid/);
  });
  it("preserves the provider discriminant and rejects legacy entry points before strategy creation", async () => {
    const { service, create } = setup();
    await expect(service.verify(input())).rejects.toThrow(
      /explicit prepareTests and verifyTranslation/,
    );
    await expect(service.verifyWithReceipt(input())).rejects.toThrow(
      /explicit prepareTests and verifyTranslation/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(join(root, "workspaces"))).toBe(false);
  });

  it("dispatches translation verification without implicit preparation, including a missing capsule", async () => {
    const { service, strategy } = setup();
    expect((await service.verifyTranslation(input())).executionStatus).toBe(
      "completed",
    );
    expect(strategy.prepareTests).not.toHaveBeenCalled();
    expect(strategy.verifyTranslation).toHaveBeenCalledWith(
      input(),
      expect.anything(),
      undefined,
      expect.any(AbortSignal),
    );
    await expect(
      service.verifyTranslation(input(), { preparation }),
    ).rejects.toThrow(/previously issued by this Host/);
    await service.prepareTests(input());
    await service.verifyTranslation(input(), { preparation });
    expect(strategy.verifyTranslation).toHaveBeenLastCalledWith(
      input(),
      expect.anything(),
      preparation,
      expect.any(AbortSignal),
    );
  });

  it("projects pretranslation input, stages original bytes, and cleans owned projects without a final report", async () => {
    let workspace = "";
    const { service } = setup({
      prepareTests: async (value, context) => {
        workspace = context.workspace.root;
        expect(Object.keys(value).sort()).toEqual([
          "analysisReport",
          "migrationPlan",
          "request",
        ]);
        expect(
          readFileSync(
            join(context.workspace.targetRoot, "target.txt"),
            "utf8",
          ),
        ).toBe("original\n");
        expect(
          readFileSync(
            join(context.workspace.sourceRoot, "source.txt"),
            "utf8",
          ),
        ).toBe("source");
        return preparation;
      },
    });
    expect(await service.prepareTests(input())).toEqual(preparation);
    expect(existsSync(workspace)).toBe(false);
    expect(
      existsSync(
        join(
          root,
          "artifacts",
          "trusted-preparations",
          `${preparation.contentHash}.json`,
        ),
      ),
    ).toBe(true);
  });

  it("persists strategy preparation evidence without creating a final VerificationResult", async () => {
    let durablePath = "";
    const { service } = setup({
      prepareTests: async (_value, context) => {
        writeFileSync(
          join(context.workspace.evidenceRoot, "preparation.json"),
          JSON.stringify(preparation),
        );
        const artifact = await context.writeArtifact({
          id: "preparation",
          kind: "report",
          path: "preparation.json",
          contentHash: preparation.contentHash,
          mediaType: "application/json",
        });
        durablePath = artifact.path;
        return preparation;
      },
    });
    const { request, analysisReport, migrationPlan } = input();
    await service.prepareTests({ request, analysisReport, migrationPlan });
    expect(
      JSON.parse(readFileSync(join(root, "artifacts", durablePath), "utf8")),
    ).toEqual(preparation);
    expect(
      readdirSync(join(root, "artifacts"), { recursive: true }).some((path) =>
        String(path).includes("verification-result"),
      ),
    ).toBe(false);
  });

  it("enforces the Host preparation deadline and cleans up only after settlement", async () => {
    let workspace = "";
    const { service } = setup(
      {
        prepareTests: async (_value, context, signal) => {
          workspace = context.workspace.root;
          await new Promise<void>((resolve) =>
            signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
          expect(existsSync(workspace)).toBe(true);
          return preparation;
        },
      },
      10,
    );
    await expect(service.prepareTests(input())).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(existsSync(workspace)).toBe(false);
  });

  it("retains caller-owned projects for translation and validates original bytes during preparation", async () => {
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    mkdirSync(sourceRoot);
    mkdirSync(targetRoot);
    writeFileSync(join(sourceRoot, "source.txt"), "source");
    writeFileSync(join(targetRoot, "target.txt"), "original\n");
    const { service } = setup({
      prepareTests: async (_value, context) => {
        expect(context.workspace.projectOwnership).toBe("caller");
        writeFileSync(join(targetRoot, "prepared-test.txt"), "frozen test");
        return preparation;
      },
    });
    const preparedProjects = { sourceRoot, targetRoot };
    await service.prepareTests(input(), { preparedProjects });
    expect(readFileSync(join(targetRoot, "prepared-test.txt"), "utf8")).toBe(
      "frozen test",
    );
    writeFileSync(join(targetRoot, "target.txt"), "translated\n");
    expect(
      (
        await service.verifyTranslation(input(), {
          preparation,
          preparedProjects,
        })
      ).executionStatus,
    ).toBe("completed");
    await expect(
      service.prepareTests(input(), { preparedProjects }),
    ).rejects.toThrow(/content does not match/);
    expect(existsSync(join(targetRoot, "prepared-test.txt"))).toBe(true);
  });

  it("rejects invalid preparation input before constructing a strategy or workspace", async () => {
    const { service, create } = setup();
    const value = input();
    value.request.targetContext.sourceFiles[0].contentHash = "0".repeat(64);
    await expect(service.prepareTests(value)).rejects.toThrow(/contentHash/);
    value.request.targetContext.sourceFiles[0].path = "../escape";
    await expect(service.prepareTests(value)).rejects.toThrow(
      /repository-relative/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(existsSync(join(root, "workspaces"))).toBe(false);
  });

  it("preserves failed preparation evidence and closes writes after settled failure", async () => {
    let context!: VerificationStrategyContext;
    const { service } = setup({
      prepareTests: async (_value, current) => {
        context = current;
        writeFileSync(
          join(current.workspace.evidenceRoot, "evidence.json"),
          "{}",
        );
        await current.writeArtifact({
          id: "evidence",
          kind: "report",
          path: "evidence.json",
          contentHash: hash("{}"),
          mediaType: "application/json",
        });
        throw new Error("preparation failed");
      },
    });
    await expect(service.prepareTests(input())).rejects.toThrow(
      "preparation failed",
    );
    expect(existsSync(context.workspace.root)).toBe(false);
    expect(
      readdirSync(join(root, "artifacts"), { recursive: true }).some((path) =>
        String(path).endsWith("evidence.json"),
      ),
    ).toBe(true);
    expect(() =>
      context.writeArtifact({
        id: "late",
        kind: "report",
        path: "late",
        contentHash: hash(""),
        mediaType: "text/plain",
      }),
    ).toThrow(/closed/);
  });

  it("waits for interrupted preparation to settle before cleanup", async () => {
    let workspace = "";
    let existedWhenSettled = false;
    const controller = new AbortController();
    const { service } = setup({
      prepareTests: async (_value, context) => {
        workspace = context.workspace.root;
        controller.abort(new Error("cancel preparation"));
        await new Promise((resolve) => setTimeout(resolve, 1));
        existedWhenSettled = existsSync(workspace);
        return preparation;
      },
    });
    await expect(
      service.prepareTests(input(), {}, controller.signal),
    ).rejects.toThrow("cancel preparation");
    expect(existedWhenSettled).toBe(true);
    expect(existsSync(workspace)).toBe(false);
  });

  it("preserves workspace when preparation shutdown is unconfirmed", async () => {
    let workspace = "";
    let finish!: (value: VerificationPreparation) => void;
    const controller = new AbortController();
    const { service } = setup({
      prepareTests: (_value, context) => {
        workspace = context.workspace.root;
        controller.abort();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    await expect(
      service.prepareTests(input(), {}, controller.signal),
    ).rejects.toThrow(/shutdown unconfirmed.*Workspace preserved/);
    expect(existsSync(workspace)).toBe(true);
    finish(preparation);
    await Promise.resolve();
    expect(existsSync(workspace)).toBe(true);
  });

  it("retains single-phase verify and explicitly rejects preparation lifecycle calls", async () => {
    const verify = vi.fn(async () => output);
    const service = new VerificationService({
      factory: new VerificationStrategyFactory([
        { descriptor, create: () => ({ verify }) },
      ]),
      defaultStrategyId: descriptor.id,
      workspaceRoot: join(root, "workspaces"),
      artifactRoot: join(root, "artifacts"),
    });
    expect((await service.verify(input())).executionStatus).toBe("completed");
    await expect(service.prepareTests(input())).rejects.toThrow(/single-phase/);
    await expect(service.verifyTranslation(input())).rejects.toThrow(
      /single-phase/,
    );
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("CLI runs explicit preparation and verification phases without serial fallback", async () => {
    const { service, strategy } = setup();
    const inputPath = join(root, "input.json");
    const preparationPath = join(root, "preparation.json");
    const outputPath = join(root, "result.json");
    writeFileSync(inputPath, JSON.stringify(input()));
    const stderr = vi.fn();
    expect(
      await runVerificationCli(["--input", inputPath, "--output", outputPath], {
        service,
        stderr,
      }),
    ).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/explicit prepareTests/),
    );
    const { request, analysisReport, migrationPlan } = input();
    writeFileSync(
      inputPath,
      JSON.stringify({ request, analysisReport, migrationPlan }),
    );
    expect(
      await runVerificationCli(
        [
          "--phase",
          "prepare-tests",
          "--input",
          inputPath,
          "--output",
          preparationPath,
        ],
        { service, stderr },
      ),
    ).toBe(0);
    expect(strategy.prepareTests).toHaveBeenCalledTimes(1);
    expect(strategy.verifyTranslation).not.toHaveBeenCalled();
    writeFileSync(inputPath, JSON.stringify(input()));
    expect(
      await runVerificationCli(
        [
          "--phase",
          "verify-translation",
          "--input",
          inputPath,
          "--preparation",
          preparationPath,
          "--output",
          outputPath,
        ],
        { service, stderr },
      ),
    ).toBe(0);
    expect(strategy.prepareTests).toHaveBeenCalledTimes(1);
    expect(strategy.verifyTranslation).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(outputPath, "utf8")).executionStatus).toBe(
      "completed",
    );
  });
});
