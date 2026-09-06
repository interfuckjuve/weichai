import type { AdaptationRequestV2, FilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validSmokeCase, validSmokeReport } from "./test-fixtures.js";
import type { SmokeResult } from "./runner.js";
import { createDefaultVerificationService } from "../../default-verification-service.js";
import {
  DIFFERENTIAL_SMOKE_STRATEGY,
  DifferentialSmokeStrategy,
  type RunSmokeImpl,
} from "./strategy.js";
import type { VerificationArtifact, VerificationInput, VerificationStrategyContext } from "../../verification-types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-differential-smoke-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("DifferentialSmokeStrategy", () => {
  it("maps the existing smoke result into strategy output", async () => {
    const report = validSmokeReport({ cases: [validSmokeCase("translation-bug")] });
    const fakeRunSmoke = vi.fn(async () => ({
      status: "fail" as const,
      summary: "1/1 translation bug",
      durationMs: 10,
      generatedTestsKept: false,
      report,
      evaluation: { status: "fail" as const, reason: "behavioral-divergence" as const, bugCases: report.cases, summary: "different" },
    } satisfies SmokeResult));
    const workspace = context();
    const strategy = new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke });

    const result = await strategy.verify(input(), workspace);

    expect(fakeRunSmoke).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty("strategyId");
    expect(result.status).toBe("fail");
    expect(result.issues[0]).toMatchObject({ kind: "behavioral-divergence", caseId: "c1" });
    expect(result.strategyReport).toEqual(report);
    expect(result.artifacts).toHaveLength(1);
    expect(workspace.writeArtifact).toHaveBeenCalledOnce();
    expect(readFileSync(join(workspace.workspace.strategyRoot, "reports", "differential-smoke-report.json"), "utf8"))
      .toContain("translation-bug");
  });

  it("maps smoke pass to pass", async () => {
    const report = validSmokeReport();
    const fakeRunSmoke = vi.fn(async () => ({
      status: "pass" as const,
      summary: "1/1 case passed",
      durationMs: 10,
      generatedTestsKept: false,
      passRate: 1,
      report,
      evaluation: { status: "pass" as const, bugCases: [], summary: "same" },
    } satisfies SmokeResult));

    const result = await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(input(), context());

    expect(result.status).toBe("pass");
    expect(result.issues).toEqual([]);
  });

  it("maps smoke error to unverified", async () => {
    const fakeRunSmoke = vi.fn(async () => ({
      status: "error" as const,
      summary: "report.json is invalid",
      durationMs: 10,
      generatedTestsKept: false,
      report: {} as SmokeResult["report"],
      errorReason: "invalid-report" as const,
    } satisfies SmokeResult));

    const result = await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(input(), context());

    expect(result.status).toBe("unverified");
    expect(result.issues[0]).toMatchObject({ kind: "invalid-report" });
  });

  it("returns canonical insufficient-context for analysis unresolved without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;
    const result = await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(
      inputWithContext({ analysisReport: { unresolved: ["dependency mapping"] } }), context(),
    );
    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "unverified", artifacts: [], issues: [{ id: "insufficient-context", kind: "insufficient-context", evidenceArtifactIds: [] }] });
    expect(result.strategyReport).toEqual({ preflight: { status: "insufficient-context", reasons: [{ code: "unresolved", fields: ["analysisReport"] }] } });
  });

  it("returns canonical insufficient-context for migration plan unresolved without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;
    const result = await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(
      inputWithContext({ migrationPlan: { unresolved: ["build command"] } }), context(),
    );
    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result.issues[0]).toMatchObject({ id: "insufficient-context", kind: "insufficient-context" });
  });

  it("returns canonical insufficient-context for declared dependencies without build facts without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;
    const result = await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(
      inputWithContext({ sourceBundle: { dependencyIds: ["dep-1"] } }), context(),
    );
    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result.issues[0]).toMatchObject({ id: "insufficient-context", kind: "insufficient-context" });
  });

  it("calls runSmoke for self-contained supported input after unsupported-language precedence", async () => {
    const fakeRunSmoke = vi.fn(async () => ({ status: "pass" as const, summary: "ok", durationMs: 1, generatedTestsKept: false, report: validSmokeReport(), evaluation: { status: "pass" as const, bugCases: [], summary: "same" } } satisfies SmokeResult));
    await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(input(), context());
    expect(fakeRunSmoke).toHaveBeenCalledOnce();
  });
  it("returns unverified for unsupported language IDs without calling runSmoke", async () => {
    const fakeRunSmoke = vi.fn() as RunSmokeImpl;

    const result = await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke }).verify(
      input({ sourceLanguageId: "go" }),
      context(),
    );

    expect(fakeRunSmoke).not.toHaveBeenCalled();
    expect(result.status).toBe("unverified");
    expect(result.summary).toMatch(/unsupported/i);
  });

  it("passes caller-owned workspace paths and staged roots to runSmoke", async () => {
    const fakeRunSmoke = vi.fn(async () => ({
      status: "pass" as const,
      summary: "ok",
      durationMs: 10,
      generatedTestsKept: false,
      report: validSmokeReport(),
      evaluation: { status: "pass" as const, bugCases: [], summary: "same" },
    } satisfies SmokeResult));
    const workspace = context();

    await new DifferentialSmokeStrategy({ runSmokeImpl: fakeRunSmoke, apiKey: "k", model: "m", timeoutMs: 123 }).verify(input(), workspace);

    expect(fakeRunSmoke).toHaveBeenCalledWith(
      expect.objectContaining({
        requirement: "Keep behavior identical.",
        analysisReport: JSON.stringify({ confidence: "high" }),
        source: expect.objectContaining({ language: "Java", root: workspace.workspace.sourceRoot, candidatePath: "src/Source.java" }),
        target: expect.objectContaining({ language: "C#", root: workspace.workspace.targetRoot, file: "src/Target.cs", className: "Target", method: "convert", isStatic: true }),
      }),
      expect.objectContaining({
        mode: "verify-only",
        workspaceDir: workspace.workspace.strategyRoot,
        executionRoot: workspace.workspace.root,
        baselinePath: join(workspace.workspace.root, "baseline.json"),
        commandEvidencePath: join(workspace.workspace.strategyRoot, "commands.jsonl"),
        runnerRoots: ["source/.forexplore-tests", "target/.forexplore-tests"],
        apiKey: "k",
        model: "m",
        timeoutMs: 123,
      }),
      undefined,
    );
    expect(existsSync(join(workspace.workspace.root, "source", ".forexplore-tests"))).toBe(true);
    expect(existsSync(join(workspace.workspace.root, "target", ".forexplore-tests"))).toBe(true);
    expect(existsSync(join(workspace.workspace.root, "baseline.json"))).toBe(true);
  });
});

describe("createDefaultVerificationService", () => {
  it("registers differential-smoke as the default strategy", () => {
    const service = createDefaultVerificationService({ runSmokeImpl: vi.fn() as RunSmokeImpl });

    expect(service.listStrategies()).toEqual([DIFFERENTIAL_SMOKE_STRATEGY]);
  });
});

function input(overrides: { sourceLanguageId?: string; targetLanguageId?: string } = {}): VerificationInput {
  const files: FilePatch[] = [{
    path: "src/Target.cs",
    status: "modified",
    expectedOriginalSha256: sha256("class Target { string convert() => \"old\"; }\n"),
    additions: 1,
    deletions: 1,
    hunks: [{
      header: "@@ -1,1 +1,1 @@",
      lines: [
        { type: "remove", content: "class Target { string convert() => \"old\"; }" },
        { type: "add", content: "class Target { static string convert() => \"new\"; }" },
      ],
    }],
  }];

  return {
    schemaVersion: "1.0",
    request: request(overrides),
    analysisReport: { confidence: "high" },
    migrationPlan: { steps: [] },
    translation: {
      round: 1,
      generatedContent: "class Target { static string convert() => \"new\"; }\n",
      files,
      patchHash: calculatePatchHashV2(files),
    },
  };
}

function request(overrides: { sourceLanguageId?: string; targetLanguageId?: string }): AdaptationRequestV2 {
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
      files: [{ path: "src/Source.java", content: "class Source { String convert() { return \"new\"; } }\n", contentHash: sha256("class Source { String convert() { return \"new\"; } }\n") }],
    },
    targetContext: {
      sourceFiles: [{ path: "src/Target.cs", content: "class Target { string convert() => \"old\"; }\n", contentHash: sha256("class Target { string convert() => \"old\"; }\n"), attributes: {} }],
      declarations: [{
        role: "declaration",
        path: "src/Target.cs",
        contentHash: sha256("declaration"),
        attributes: { containerName: "Target", isStatic: true },
      }],
      containers: [],
    },
    requirement: "Keep behavior identical.",
  } as unknown as AdaptationRequestV2;
}

function inputWithContext(overrides: Record<string, unknown>): VerificationInput {
  const value = input() as unknown as Record<string, unknown>;
  const requestValue = value.request as Record<string, unknown>;
  const requestOverrides = Object.fromEntries(Object.entries(overrides).filter(([key]) => key === "sourceBundle" || key === "targetContext"));
  for (const key of ["sourceBundle", "targetContext"] as const) {
    if (requestOverrides[key]) requestOverrides[key] = { ...(requestValue[key] as Record<string, unknown>), ...(requestOverrides[key] as Record<string, unknown>) };
  }
  return {
    ...value,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "sourceBundle" && key !== "targetContext")),
    request: { ...requestValue, ...requestOverrides },
  } as unknown as VerificationInput;
}

function context(): VerificationStrategyContext {
  const workspaceRoot = mkdtempSync(join(root, "workspace-"));
  const strategyRoot = join(workspaceRoot, "agent");
  const sourceRoot = join(workspaceRoot, "source", "project");
  const targetRoot = join(workspaceRoot, "target", "project");
  for (const directory of [strategyRoot, sourceRoot, targetRoot]) mkdirSync(directory, { recursive: true });
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
      return { ...artifact, contentHash: createHash("sha256").update(content).digest("hex") };
    }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
