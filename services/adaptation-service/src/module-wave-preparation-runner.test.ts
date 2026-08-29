import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildModuleMigrationPlan,
  recordModulePlanDecision,
} from "@forexplore/workflow-core";
import {
  analyzeRepository,
} from "@forexplore/code-indexer";
import {
  moduleMigrationSchemaVersion,
  type FunctionalModule,
  type ModuleMigrationProposal,
} from "@forexplore/contracts";
import { ModuleWavePreparationRunner } from "./module-wave-preparation-runner";

const roots: string[] = [];
const now = "2026-08-27T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

async function repository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "forexplore-module-preparer-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  git(root, ["init"]);
  git(root, ["config", "user.email", "forexplore@example.test"]);
  git(root, ["config", "user.name", "ForeXplore Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function module(id: string, sourceFile: string, dependsOn: string[] = []): FunctionalModule {
  return {
    id,
    name: id,
    kind: "feature",
    description: id,
    sourceFiles: [sourceFile],
    symbolIds: [],
    dependsOn,
    writeSet: [sourceFile],
    resourceLocks: [],
    evidenceIds: [],
  };
}

async function approvedPlan(
  root: string,
  modules: FunctionalModule[],
): Promise<ReturnType<typeof buildModuleMigrationPlan>> {
  const analysis = await analyzeRepository({ root, createdAt: now });
  const proposal: ModuleMigrationProposal = {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: analysis.snapshotId,
    objective: "Prepare modules",
    modules,
    fileAssignments: modules.map((item) => ({
      path: item.sourceFiles[0]!,
      kind: "module" as const,
      moduleId: item.id,
    })),
  };
  const plan = buildModuleMigrationPlan(analysis, proposal, { now });
  return recordModulePlanDecision(plan, {
    id: "plan-approval",
    kind: "plan-approval",
    status: "approved",
    snapshotId: plan.snapshotId,
    planHash: plan.planHash,
    actor: "reviewer",
    decidedAt: now,
  }, analysis.snapshotId, now);
}

function noOpPatch(moduleId: string) {
  return {
    moduleId,
    files: [{
      path: `${moduleId}.patch`,
      status: "created" as const,
      expectedAbsent: true as const,
      additions: 1,
      deletions: 0,
      hunks: [{ header: "@@ -0,0 +1,1 @@", lines: [{ type: "add" as const, content: moduleId }] }],
    }],
    validation: [{
      id: `check:${moduleId}`,
      label: moduleId,
      status: "pass" as const,
      required: true,
      summary: "prepared",
    }],
  };
}

describe("ModuleWavePreparationRunner", () => {
  it("prepares independent module groups concurrently in separate clean worktrees", async () => {
    const root = await repository({
      "a.java": "class A {}\n",
      "b.java": "class B {}\n",
    });
    const plan = await approvedPlan(root, [module("a", "a.java"), module("b", "b.java")]);
    const analysis = await analyzeRepository({ root, createdAt: now });
    let active = 0;
    let maximum = 0;
    const worktrees = new Set<string>();
    const runner = new ModuleWavePreparationRunner({
      async prepareModule(context) {
        active += 1;
        maximum = Math.max(maximum, active);
        worktrees.add(context.worktreeRoot);
        expect(git(context.worktreeRoot, ["rev-parse", "HEAD"]).trim()).toBe(analysis.repository.revision);
        await new Promise((resolve) => setTimeout(resolve, 25));
        active -= 1;
        return noOpPatch(context.module.id);
      },
    });

    const prepared = await runner.prepare({
      repositoryRoot: root,
      analysis,
      plan,
      waveId: plan.executionWaves[0]!.id,
    });

    expect(prepared.map((item) => item.moduleId)).toEqual(["a", "b"]);
    expect(maximum).toBe(2);
    expect(worktrees.size).toBe(2);
    expect(git(root, ["worktree", "list", "--porcelain"])).not.toContain("forexplore-module-prepare-");
  });

  it("serializes members of a strongly connected component", async () => {
    const root = await repository({
      "a.java": "class A {}\n",
      "b.java": "class B {}\n",
    });
    const plan = await approvedPlan(root, [
      module("a", "a.java", ["b"]),
      module("b", "b.java", ["a"]),
    ]);
    const analysis = await analyzeRepository({ root, createdAt: now });
    const order: string[] = [];
    let active = 0;
    let maximum = 0;
    const runner = new ModuleWavePreparationRunner({
      async prepareModule(context) {
        active += 1;
        maximum = Math.max(maximum, active);
        order.push(context.module.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return noOpPatch(context.module.id);
      },
    });

    await runner.prepare({
      repositoryRoot: root,
      analysis,
      plan,
      waveId: plan.executionWaves[0]!.id,
    });

    expect(maximum).toBe(1);
    expect(order).toEqual(["a", "b"]);
  });

  it("rejects a preparer that writes into its isolated checkout", async () => {
    const root = await repository({ "a.java": "class A {}\n" });
    const plan = await approvedPlan(root, [module("a", "a.java")]);
    const analysis = await analyzeRepository({ root, createdAt: now });
    const runner = new ModuleWavePreparationRunner({
      async prepareModule(context) {
        await writeFile(path.join(context.worktreeRoot, "a.java"), "changed", "utf8");
        return noOpPatch(context.module.id);
      },
    });

    await expect(runner.prepare({
      repositoryRoot: root,
      analysis,
      plan,
      waveId: plan.executionWaves[0]!.id,
    })).rejects.toThrow("modified its isolated worktree");
  });

  it("rejects a dirty source checkout before preparing a patch", async () => {
    const root = await repository({ "a.java": "class A {}\n" });
    const plan = await approvedPlan(root, [module("a", "a.java")]);
    const analysis = await analyzeRepository({ root, createdAt: now });
    await writeFile(path.join(root, "a.java"), "changed", "utf8");
    const runner = new ModuleWavePreparationRunner({
      prepareModule: async (context) => noOpPatch(context.module.id),
    });

    await expect(runner.prepare({
      repositoryRoot: root,
      analysis,
      plan,
      waveId: plan.executionWaves[0]!.id,
    })).rejects.toThrow("no tracked changes");
  });
});
