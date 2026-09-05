import type { AdaptationRequestV2, FilePatch, ModifiedFilePatch } from "@forexplore/contracts";
import { calculatePatchHashV2 } from "@forexplore/workflow-core";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VerificationArtifact, VerificationInput } from "./verification-types.js";
import { createVerificationWorkspace } from "./verification-workspace.js";

const sourceContent = "export function source() {\n  return 1;\n}\n";
const originalTargetContent = "def target():\n    raise NotImplementedError()\n";
const translatedTargetContent = "def target():\n    return 1\n";

let root: string;
let workspaceRoot: string;
let artifactRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tv-v2-workspace-test-"));
  workspaceRoot = join(root, "workspaces");
  artifactRoot = join(root, "artifacts");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createVerificationWorkspace", () => {
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
      .toThrow(/relative path/i);
    expect(() => createVerificationWorkspace(inputWithWrongPatchHash(), { workspaceRoot, artifactRoot }))
      .toThrow(/original hash/i);
  });

  it("writes artifacts beneath artifactRoot with SHA-256 metadata and rejects unsafe names", async () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    const evidencePath = join(workspace.context.workspace.evidenceRoot, "reports/result.json");
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, "{\"ok\":true}\n", "utf8");

    const written = await workspace.context.writeArtifact({
      id: "artifact-1",
      kind: "report",
      path: "reports/result.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    });

    expect(written).toEqual({
      id: "artifact-1",
      kind: "report",
      path: "reports/result.json",
      contentHash: sha256("{\"ok\":true}\n"),
      mediaType: "application/json",
    } satisfies VerificationArtifact);
    expect(readFileSync(join(artifactRoot, "reports/result.json"), "utf8")).toBe("{\"ok\":true}\n");
    expect(readdirSync(join(artifactRoot, "reports"))).toEqual(["result.json"]);
    expect(workspace.writtenArtifacts()).toEqual([written]);
    expect(workspace.writtenArtifacts()[0]).not.toBe(written);

    expect(() => workspace.context.writeArtifact({ ...written, path: "/tmp/result.json" })).toThrow(/relative path/i);
    expect(() => workspace.context.writeArtifact({ ...written, path: "../result.json" })).toThrow(/relative path/i);

    workspace.cleanup();
  });

  it("rejects symlinked and dangling artifact path components", async () => {
    const workspace = createVerificationWorkspace(input(), { workspaceRoot, artifactRoot });
    const evidencePath = join(workspace.context.workspace.evidenceRoot, "reports/result.json");
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, "{}\n", "utf8");

    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(artifactRoot, { recursive: true });
    symlinkSync(outside, join(artifactRoot, "reports"), "dir");

    expect(() => workspace.context.writeArtifact({
      id: "artifact-symlink",
      kind: "report",
      path: "reports/result.json",
      contentHash: "0".repeat(64),
      mediaType: "application/json",
    })).toThrow(/symlink/i);
    expect(existsSync(join(outside, "result.json"))).toBe(false);

    unlinkSync(join(artifactRoot, "reports"));
    symlinkSync(join(root, "missing"), join(artifactRoot, "reports"), "dir");

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
