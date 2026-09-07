import { createHash } from "node:crypto";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptationRequestV2, FilePatch, ModifiedFilePatch } from "@forexplore/contracts";
import type { VerificationArtifact, VerificationInput } from "./verification-types.js";
import { createVerificationArtifactStore } from "./save-report.js";
import { createVerificationWorkspace, VerificationArtifactPersistenceError } from "./verification-workspace.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), statSync: vi.fn(actual.statSync), renameSync: vi.fn(actual.renameSync) };
});

const sourceContent = "export function source() {\n  return 1;\n}\n";
const originalTargetContent = "def target():\n    raise NotImplementedError()\n";
const translatedTargetContent = "def target():\n    return 1\n";
const firstArtifactContent = "{\"ok\":true,\"attempt\":1}\n";
const secondArtifactContent = "{\"ok\":true,\"attempt\":2}\n";

let root: string;
let workspaceRoot: string;
let artifactRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-v2-workspace-test-"));
  workspaceRoot = join(root, "workspaces");
  artifactRoot = join(root, "artifacts");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(fsReadFile);
  vi.mocked(fs.statSync).mockReset().mockImplementation(fsStat);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(fsRename);
  rmSync(root, { recursive: true, force: true });
});
const fsReadFile = vi.mocked(fs.readFileSync).getMockImplementation()!;
const fsStat = vi.mocked(fs.statSync).getMockImplementation()!;
const fsRename = vi.mocked(fs.renameSync).getMockImplementation()!;

describe("createVerificationWorkspace", () => {
  it("persists early canonical bytes without source materialization and retains attempt cleanup and closed guards", () => {
    const store = createVerificationArtifactStore({ artifactRoot, durablePrefix: "attempt-preflight" });
    const bytes = Buffer.from('{"early":true}');
    const stored = store.writeFrameworkResult(bytes);
    expect(existsSync(workspaceRoot)).toBe(false);
    expect(readFileSync(join(artifactRoot, stored.path))).toEqual(bytes);
    expect(stored.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(stored.path).toContain(stored.contentHash);
    expect(() => store.writeArtifact({ id: "report", kind: "report", path: "report.json", contentHash: "0".repeat(64), mediaType: "application/json" })).toThrow(/not prepared/);
    store.cleanup({ discardArtifacts: true });
    expect(readdirSync(artifactRoot)).toEqual([]);
    expect(() => store.writeFrameworkResult(bytes)).toThrow(/closed/);
  });

  const artifact = { id: "report", kind: "report", path: "report.json", contentHash: "0".repeat(64), mediaType: "application/json" };

  it.each(["missing", "symlink", "dangling", "directory", "ENOTDIR", "stat", "read", "destination", "rename"])("classifies %s failures without returning artifacts or leaking temp files", (failure) => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    const source = join(workspace.context.workspace.evidenceRoot, artifact.path);
    writeFileSync(source, "{}\n");
    if (failure === "missing") unlinkSync(source);
    if (failure === "symlink" || failure === "dangling") {
      unlinkSync(source);
      symlinkSync(failure === "symlink" ? join(workspace.context.workspace.sourceRoot, "src/source.ts") : join(root, "missing"), source);
    }
    if (failure === "directory") { unlinkSync(source); mkdirSync(source); }
    if (failure === "stat") vi.mocked(fs.statSync).mockImplementationOnce(() => { throw Object.assign(new Error("stat denied"), { code: "EACCES" }); });
    if (failure === "read") vi.mocked(fs.readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("read denied"), { code: "EACCES" }); });
    if (failure === "destination") writeFileSync(artifactRoot, "not a directory");
    if (failure === "rename") vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); });
    expect(() => workspace.context.writeArtifact({ ...artifact, path: failure === "ENOTDIR" ? "report.json/child" : artifact.path }))
      .toThrow(VerificationArtifactPersistenceError);
    expect(workspace.writtenArtifacts()).toEqual([]);
    if (existsSync(artifactRoot) && failure !== "destination") {
      expect(readdirSync(artifactRoot, { recursive: true }).filter((path) => String(path).includes(".tmp-"))).toEqual([]);
    }
    workspace.cleanup();
  });

  it("rejects duplicate strategy IDs even when the second path is different", () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    writeFileSync(join(workspace.context.workspace.evidenceRoot, artifact.path), "{}");
    writeFileSync(join(workspace.context.workspace.evidenceRoot, "other.json"), "{}");
    const stored = workspace.context.writeArtifact(artifact);
    expect(() => workspace.context.writeArtifact({ ...artifact, path: "other.json" })).toThrow(VerificationArtifactPersistenceError);
    expect(workspace.writtenArtifacts()).toEqual([stored]);
    workspace.cleanup();
  });

  it("checks actual bytes after reading instead of trusting the earlier stat", () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    const source = join(workspace.context.workspace.evidenceRoot, artifact.path);
    writeFileSync(source, Buffer.alloc(10 * 1024 * 1024 + 1));
    vi.mocked(fs.statSync).mockReturnValueOnce({ size: 1 } as ReturnType<typeof fs.statSync>);
    expect(() => workspace.context.writeArtifact(artifact)).toThrow(VerificationArtifactPersistenceError);
    expect(workspace.writtenArtifacts()).toEqual([]);
    workspace.cleanup();
  });

  it("shares the attempt byte budget between strategy artifacts and framework results", () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    writeFileSync(join(workspace.context.workspace.evidenceRoot, artifact.path), Buffer.alloc(10 * 1024 * 1024 - 2));
    workspace.context.writeArtifact(artifact);
    const result = workspace.writeFrameworkResult(Buffer.from("{}"));
    expect(result.size).toBe(2);
    expect(() => workspace.writeFrameworkResult(Buffer.from("x"))).toThrow(VerificationArtifactPersistenceError);
    workspace.cleanup();
  });

  it("rejects an oversized framework result before persisting it", () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    expect(() => workspace.writeFrameworkResult(Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow(VerificationArtifactPersistenceError);
    expect(existsSync(artifactRoot)).toBe(false);
    workspace.cleanup();
  });

  it("stages source and target artifacts and applies the patch only to the target copy", () => {
    const originalTargetPath = join(root, "original-target", "src", "target.py");
    mkdirSync(dirname(originalTargetPath), { recursive: true });
    writeFileSync(originalTargetPath, originalTargetContent, "utf8");

    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });

    expect(readFileSync(join(workspace.context.workspace.sourceRoot, "src/source.ts"), "utf8"))
      .toBe(sourceContent);
    expect(readFileSync(join(workspace.context.workspace.targetRoot, "src/target.py"), "utf8"))
      .toBe(translatedTargetContent);
    expect(readFileSync(originalTargetPath, "utf8")).toBe(originalTargetContent);
    expect(workspace.context.workspace.strategyRoot).toBe(workspace.context.workspace.evidenceRoot);
    expect(existsSync(join(dirname(workspace.context.workspace.sourceRoot), ".forexplore-tests"))).toBe(true);
    expect(existsSync(join(dirname(workspace.context.workspace.targetRoot), ".forexplore-tests"))).toBe(true);

    workspace.cleanup();
    expect(existsSync(workspace.context.workspace.root)).toBe(false);
  });

  it("rejects traversal and an expected-original hash mismatch", () => {
    expect(() => createVerificationWorkspace(inputWithSourcePath("../escape.ts"), { workspaceRoot, artifactRoot }))
      .toThrow(/repository-relative/i);
    expect(() => createVerificationWorkspace(inputWithWrongPatchHash(), { workspaceRoot, artifactRoot }))
      .toThrow(/original hash/i);
  });

  it("namespaces durable artifacts by attempt while preserving the strategy-relative source path", async () => {
    const firstWorkspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    const secondWorkspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });

    const firstEvidencePath = join(firstWorkspace.context.workspace.evidenceRoot, "reports/result.json");
    const secondEvidencePath = join(secondWorkspace.context.workspace.evidenceRoot, "reports/result.json");
    mkdirSync(dirname(firstEvidencePath), { recursive: true });
    mkdirSync(dirname(secondEvidencePath), { recursive: true });
    writeFileSync(firstEvidencePath, firstArtifactContent, "utf8");
    writeFileSync(secondEvidencePath, secondArtifactContent, "utf8");

    const firstArtifact = await firstWorkspace.context.writeArtifact({
      id: "artifact-1",
      kind: "report",
      path: "reports/result.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    });
    const secondArtifact = await secondWorkspace.context.writeArtifact({
      id: "artifact-1",
      kind: "report",
      path: "reports/result.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    });

    expect(secondArtifact.id).not.toBe(firstArtifact.id);
    const firstAttemptDir = firstArtifact.path.split("/")[0];
    const secondAttemptDir = secondArtifact.path.split("/")[0];
    expect(firstAttemptDir).toMatch(/^attempt-[A-Za-z0-9-]+$/);
    expect(secondAttemptDir).toMatch(/^attempt-[A-Za-z0-9-]+$/);
    expect(firstArtifact.path).toBe(`${firstAttemptDir}/reports/result.json`);
    expect(secondArtifact.path).toBe(`${secondAttemptDir}/reports/result.json`);
    expect(secondArtifact.path).not.toBe(firstArtifact.path);
    expect(readFileSync(join(artifactRoot, firstArtifact.path), "utf8")).toBe(firstArtifactContent);
    expect(readFileSync(join(artifactRoot, secondArtifact.path), "utf8")).toBe(secondArtifactContent);
    expect(readdirSync(artifactRoot).sort()).toEqual([firstAttemptDir, secondAttemptDir].sort());
    expect(firstWorkspace.writtenArtifacts()).toEqual([firstArtifact]);
    expect(secondWorkspace.writtenArtifacts()).toEqual([secondArtifact]);

    firstWorkspace.cleanup();
    secondWorkspace.cleanup();
  });

  it("rejects artifact writes after cleanup even when the workspace is kept", async () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot, keepWorkspace: true });
    const evidencePath = join(workspace.context.workspace.evidenceRoot, "reports/late.json");
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, "{}\n", "utf8");

    workspace.cleanup();

    expect(existsSync(workspace.context.workspace.root)).toBe(true);
    await expect(Promise.resolve().then(() => workspace.context.writeArtifact({
      id: "late-artifact",
      kind: "report",
      path: "reports/late.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    }))).rejects.toThrow(/closed/i);
    expect(existsSync(join(artifactRoot, "reports/late.json"))).toBe(false);
  });

  it("rejects symlinked and dangling artifact path components", async () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    const evidencePath = join(workspace.context.workspace.evidenceRoot, "reports/result.json");
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, "{}\n", "utf8");

    const outside = join(root, "outside");
    const attemptDir = `attempt-${basename(workspace.context.workspace.root).replace(/^verification-/, "")}`;
    mkdirSync(join(artifactRoot, attemptDir), { recursive: true });
    symlinkSync(outside, join(artifactRoot, attemptDir, "reports"), "dir");

    expect(() => workspace.context.writeArtifact({
      id: "artifact-symlink",
      kind: "report",
      path: "reports/result.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    })).toThrow(/symlink/i);
    expect(existsSync(join(outside, "result.json"))).toBe(false);

    unlinkSync(join(artifactRoot, attemptDir, "reports"));
    symlinkSync(join(root, "missing"), join(artifactRoot, attemptDir, "reports"), "dir");

    expect(() => workspace.context.writeArtifact({
      id: "artifact-dangling",
      kind: "report",
      path: "reports/result.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    })).toThrow(/symlink/i);

    workspace.cleanup();
  });
});

function input(files: FilePatch[] = [modifiedPatch()], sourcePath = "src/source.ts"): VerificationInput {
  return {
    schemaVersion: "1.0",
    request: {
      sourceBundle: {
        files: [{ path: sourcePath, content: sourceContent, contentHash: sha256(sourceContent) }],
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

function inputWithSourcePath(path: string): VerificationInput {
  return input([modifiedPatch()], path);
}

function inputWithWrongPatchHash(): VerificationInput {
  const patch = modifiedPatch();
  return input([{ ...patch, expectedOriginalSha256: "f".repeat(64) }]);
}

function modifiedPatch(): ModifiedFilePatch {
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
