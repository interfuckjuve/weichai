import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { copySourceProject, resolveSourceRepositoryRoot } from "./source-project";

const corpusRoot = fileURLToPath(
  new URL("../../../fixtures/code-corpus", import.meta.url),
);

describe("resolveSourceRepositoryRoot", () => {
  it("strips the fixture/ prefix and resolves the corpus directory", () => {
    const info = resolveSourceRepositoryRoot("fixture/commons-fileupload-csharp", corpusRoot);

    expect(info).not.toBeNull();
    expect(info?.repositoryName).toBe("commons-fileupload-csharp");
    expect(info?.root.endsWith("commons-fileupload-csharp")).toBe(true);
    expect(existsSync(info!.root)).toBe(true);
  });

  it("accepts a repository name without the fixture/ prefix", () => {
    const info = resolveSourceRepositoryRoot("commons-fileupload-python", corpusRoot);

    expect(info?.repositoryName).toBe("commons-fileupload-python");
  });

  it("returns null for repositories absent from the local corpus", () => {
    expect(resolveSourceRepositoryRoot("fixture/not-a-real-repo", corpusRoot)).toBeNull();
    expect(resolveSourceRepositoryRoot("", corpusRoot)).toBeNull();
  });
});

describe("copySourceProject", () => {
  it("copies the repository into destParent/.forexplore-source-<repo> with manifest", () => {
    const destParent = mkdtempSync(join(tmpdir(), "fx-source-copy-"));

    try {
      const info = copySourceProject("fixture/commons-fileupload-csharp", corpusRoot, destParent);

      expect(info).not.toBeNull();
      expect(info?.root).toBe(join(destParent, ".forexplore-source-commons-fileupload-csharp"));
      expect(existsSync(join(info!.root, "manifest.json"))).toBe(true);
      expect(existsSync(join(info!.root, "src"))).toBe(true);
      // 排除垃圾/构建目录。
      expect(existsSync(join(info!.root, ".git"))).toBe(false);
      expect(existsSync(join(info!.root, "obj"))).toBe(false);
    } finally {
      rmSync(destParent, { recursive: true, force: true });
    }
  });

  it("returns null when the repository is missing locally", () => {
    const destParent = mkdtempSync(join(tmpdir(), "fx-source-copy-"));

    try {
      expect(copySourceProject("fixture/missing-repo", corpusRoot, destParent)).toBeNull();
    } finally {
      rmSync(destParent, { recursive: true, force: true });
    }
  });
});
