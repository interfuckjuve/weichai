import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FilePatch } from "@forexplore/contracts";
import { GitWaveTransaction } from "./git-wave-transaction";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function modified(pathValue: string, original: string, replacement: string): FilePatch {
  return {
    path: pathValue,
    status: "modified",
    expectedOriginalSha256: hash(original),
    additions: 1,
    deletions: 1,
    hunks: [{
      header: "@@ -1,1 +1,1 @@",
      lines: [
        { type: "remove", content: original },
        { type: "add", content: replacement },
      ],
    }],
  };
}

function created(pathValue: string, content: string): FilePatch {
  return {
    path: pathValue,
    status: "created",
    expectedAbsent: true,
    additions: 1,
    deletions: 0,
    hunks: [{
      header: "@@ -0,0 +1,1 @@",
      lines: [{ type: "add", content }],
    }],
  };
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "forexplore-git-wave-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".forexplore"));
  await writeFile(path.join(root, "src", "Service.cs"), "old implementation", "utf8");
  await writeFile(path.join(root, ".forexplore", ".gitkeep"), "", "utf8");
  git(root, ["init"]);
  git(root, ["config", "user.email", "forexplore@example.test"]);
  git(root, ["config", "user.name", "ForeXplore Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("GitWaveTransaction", () => {
  it("commits the complete approved write set to an isolated migration branch", async () => {
    const root = await repository();
    const validationRoots: string[] = [];
    const result = await new GitWaveTransaction().commit({
      repositoryRoot: root,
      branchName: "codex/forexplore-migration/run-01",
      transactionId: "run-01-wave-01",
      files: [
        modified("src/Service.cs", "old implementation", "new implementation"),
        created(".forexplore/module-summary.json", '{"schemaVersion":"1.0"}'),
      ],
      commitMessage: "forexplore: apply wave 01",
      validate: async (worktree) => {
        validationRoots.push(worktree);
        await expect(readFile(path.join(worktree, "src", "Service.cs"), "utf8")).resolves.toBe("new implementation");
      },
    });

    expect(result.branchName).toBe("codex/forexplore-migration/run-01");
    expect(result.checkpointId).toBe("checkpoint-run-01-wave-01");
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(validationRoots).toHaveLength(1);
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("old implementation");
    expect(git(root, ["show", "codex/forexplore-migration/run-01:src/Service.cs"])).toBe("new implementation");
    expect(git(root, ["show", "codex/forexplore-migration/run-01:.forexplore/module-summary.json"])).toBe('{"schemaVersion":"1.0"}');
    expect(new GitWaveTransaction().findPublishedTransactionCommit(root, {
      transactionId: "run-01-wave-01",
      branchName: "codex/forexplore-migration/run-01",
      baseCommit: result.baseCommit,
    })).toBe(result.commit);
  });

  it("does not publish a branch when wave validation fails", async () => {
    const root = await repository();
    await expect(new GitWaveTransaction().commit({
      repositoryRoot: root,
      branchName: "codex/forexplore-migration/run-02",
      transactionId: "run-02-wave-01",
      files: [modified("src/Service.cs", "old implementation", "new implementation")],
      commitMessage: "forexplore: apply wave 01",
      validate: () => {
        throw new Error("combined validation failed");
      },
    })).rejects.toThrow("combined validation failed");

    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-02"])).toBe("");
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("old implementation");
  });

  it("rejects validation that changes a reviewed source file after patch application", async () => {
    const root = await repository();
    await expect(new GitWaveTransaction().prepare({
      repositoryRoot: root,
      branchName: "codex/forexplore-migration/run-validated-write",
      transactionId: "run-validated-write-wave-01",
      files: [modified("src/Service.cs", "old implementation", "new implementation")],
      validate: async (worktree) => {
        await writeFile(path.join(worktree, "src", "Service.cs"), "validator rewrite", "utf8");
      },
    })).rejects.toThrow("Wave validation modified an approved source path");

    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-validated-write"])).toBe("");
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("old implementation");
  });

  it("rejects finalization that changes a reviewed source file", async () => {
    const root = await repository();
    await expect(new GitWaveTransaction().commit({
      repositoryRoot: root,
      branchName: "codex/forexplore-migration/run-finalizer-write",
      transactionId: "run-finalizer-write-wave-01",
      files: [modified("src/Service.cs", "old implementation", "new implementation")],
      commitMessage: "forexplore: apply wave",
      finalize: async (worktree) => {
        await writeFile(path.join(worktree, "src", "Service.cs"), "finalizer rewrite", "utf8");
        return [];
      },
    })).rejects.toThrow("Wave finalization modified an approved source path");

    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-finalizer-write"])).toBe("");
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("old implementation");
  });

  it("marks uncommitted prepared waves rolled back during recovery", async () => {
    const root = await repository();
    const transaction = new GitWaveTransaction();
    await transaction.prepare({
      repositoryRoot: root,
      branchName: "codex/forexplore-migration/run-recovery",
      transactionId: "run-recovery-wave-01",
      files: [modified("src/Service.cs", "old implementation", "new implementation")],
    });

    expect(transaction.recoverIncompleteTransactions(root)).toEqual([{
      transactionId: "run-recovery-wave-01",
      state: "rolled-back",
    }]);
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("old implementation");
    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-recovery"])).toBe("");
  });

  it("does not accept an arbitrary direct-child commit as prerequisite publication", async () => {
    const root = await repository();
    const baseCommit = git(root, ["rev-parse", "HEAD"]).trim();
    await writeFile(path.join(root, "src", "Service.cs"), "external commit", "utf8");
    git(root, ["add", "src/Service.cs"]);
    git(root, ["commit", "-m", "external commit without migration trailer"]);
    const externalCommit = git(root, ["rev-parse", "HEAD"]).trim();
    git(root, [
      "update-ref",
      "refs/heads/codex/forexplore-migration/run-forged",
      externalCommit,
    ]);

    expect(new GitWaveTransaction().findPublishedTransactionCommit(root, {
      transactionId: "run-forged-wave-01",
      branchName: "codex/forexplore-migration/run-forged",
      baseCommit,
      commit: externalCommit,
    })).toBeUndefined();
  });

  it("refuses execution when the source worktree has tracked changes", async () => {
    const root = await repository();
    await writeFile(path.join(root, "src", "Service.cs"), "user change", "utf8");

    await expect(new GitWaveTransaction().commit({
      repositoryRoot: root,
      branchName: "codex/forexplore-migration/run-03",
      transactionId: "run-03-wave-01",
      files: [modified("src/Service.cs", "old implementation", "new implementation")],
      commitMessage: "forexplore: apply wave 01",
    })).rejects.toThrow("no tracked changes");
  });
});
