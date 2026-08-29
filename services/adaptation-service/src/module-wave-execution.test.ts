import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildModuleMigrationPlan,
  createMigrationRunManifest,
  recordModulePlanDecision,
} from "@forexplore/workflow-core";
import {
  analyzeRepository,
  repositoryAnalysisContentHash,
  repositoryAnalysisSnapshotId,
} from "@forexplore/code-indexer";
import {
  moduleMigrationSchemaVersion,
  type FilePatch,
  type FunctionalModule,
  type ModuleMigrationPlan,
  type ModuleMigrationProposal,
  type RepositoryStaticAnalysis,
} from "@forexplore/contracts";
import {
  ModuleWaveExecutionCoordinator,
  type PreparedModulePatch,
} from "./module-wave-execution";

const roots: string[] = [];
const now = "2026-08-27T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function patch(original: string, replacement: string, pathValue = "src/Service.cs"): FilePatch {
  const originalLines = original.replace(/\r\n/g, "\n").split("\n");
  const replacementLines = replacement.replace(/\r\n/g, "\n").split("\n");
  return {
    path: pathValue,
    status: "modified",
    expectedOriginalSha256: hash(original),
    additions: replacementLines.length,
    deletions: originalLines.length,
    hunks: [{
      header: `@@ -1,${originalLines.length} +1,${replacementLines.length} @@`,
      lines: [
        ...originalLines.map((content) => ({ type: "remove" as const, content })),
        ...replacementLines.map((content) => ({ type: "add" as const, content })),
      ],
    }],
  };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "forexplore-module-wave-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "Service.cs"), "old implementation", "utf8");
  git(root, ["init"]);
  git(root, ["config", "user.email", "forexplore@example.test"]);
  git(root, ["config", "user.name", "ForeXplore Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function module(): FunctionalModule {
  return {
    id: "service",
    name: "Service",
    kind: "feature",
    description: "Migrated service",
    sourceFiles: ["src/Service.cs"],
    symbolIds: ["symbol:service"],
    dependsOn: [],
    writeSet: ["src/Service.cs"],
    resourceLocks: [],
    evidenceIds: ["symbol:service"],
  };
}

function analysis(): RepositoryStaticAnalysis {
  const evidence: Omit<RepositoryStaticAnalysis, "snapshotId" | "contentHash" | "createdAt"> = {
    schemaVersion: moduleMigrationSchemaVersion,
    analyzerVersion: "test",
    repository: { revision: "deadbeef" },
    files: [{
      path: "src/Service.cs",
      sha256: hash("old implementation"),
      role: "source",
      language: "C#",
    }],
    symbols: [{
      id: "symbol:service",
      name: "Service",
      qualifiedName: "Service",
      kind: "class",
      language: "C#",
      path: "src/Service.cs",
    }],
    dependencies: [],
    diagnostics: [],
  };
  return {
    ...evidence,
    snapshotId: repositoryAnalysisSnapshotId(evidence),
    contentHash: repositoryAnalysisContentHash(evidence),
    createdAt: now,
  };
}

function proposal(source: RepositoryStaticAnalysis): ModuleMigrationProposal {
  return {
    schemaVersion: moduleMigrationSchemaVersion,
    snapshotId: source.snapshotId,
    objective: "Migrate service",
    modules: [module()],
    fileAssignments: [{ path: "src/Service.cs", kind: "module", moduleId: "service" }],
  };
}

function planWithPlanApproval(source: RepositoryStaticAnalysis): ModuleMigrationPlan {
  const plan = buildModuleMigrationPlan(source, proposal(source), { now });
  return recordModulePlanDecision(plan, {
    id: "plan-approval",
    kind: "plan-approval",
    status: "approved",
    snapshotId: plan.snapshotId,
    planHash: plan.planHash,
    actor: "reviewer",
    decidedAt: now,
  }, source.snapshotId, now);
}

function preparedModulePatches(): PreparedModulePatch[] {
  return [{
    moduleId: "service",
    files: [patch("old implementation", "new implementation")],
    validation: [{
      id: "service-check",
      label: "Service check",
      status: "pass",
      required: true,
      summary: "module patch verified",
    }],
  }];
}

async function prepareWave(
  root: string,
  source: RepositoryStaticAnalysis,
  plan: ModuleMigrationPlan,
  runId = "run-01",
) {
  const manifest = createMigrationRunManifest(plan, runId, now);
  const prepared = await new ModuleWaveExecutionCoordinator().prepare({
    repositoryRoot: root,
    analysis: source,
    plan,
    manifest,
    waveId: plan.executionWaves[0]!.id,
    preparedModules: preparedModulePatches(),
    validate: async (worktreeRoot: string) => {
      await expect(readFile(path.join(worktreeRoot, "src", "Service.cs"), "utf8"))
        .resolves.toBe("new implementation");
      return [{
        id: "wave-check",
        label: "Wave check",
        status: "pass" as const,
        required: true,
        summary: "joint build verified",
      }];
    },
    now,
  });
  return { manifest, prepared };
}

function approvePreparedWave(plan: ModuleMigrationPlan, preparedHash: string): ModuleMigrationPlan {
  const wave = plan.executionWaves[0]!;
  return recordModulePlanDecision(plan, {
    id: `wave-approval:${preparedHash}`,
    kind: "wave-approval",
    status: "approved",
    waveId: wave.id,
    preparedHash,
    snapshotId: plan.snapshotId,
    planHash: plan.planHash,
    actor: "reviewer",
    decidedAt: now,
  }, plan.snapshotId, now);
}

describe("ModuleWaveExecutionCoordinator", () => {
  it("uses the isolated scheduler before materializing a prepared wave bundle", async () => {
    const root = await repository();
    const source = analysis();
    const plan = planWithPlanApproval(source);
    const manifest = createMigrationRunManifest(plan, "run-scheduled-preparation", now);
    let preparationWorktree: string | undefined;
    const prepared = await new ModuleWaveExecutionCoordinator().prepareWithPreparer({
      repositoryRoot: root,
      analysis: source,
      plan,
      manifest,
      waveId: plan.executionWaves[0]!.id,
      preparer: {
        async prepareModule(context) {
          preparationWorktree = context.worktreeRoot;
          expect(context.worktreeRoot).not.toBe(root);
          expect(await readFile(path.join(context.worktreeRoot, "src", "Service.cs"), "utf8"))
            .toBe("old implementation");
          return preparedModulePatches()[0]!;
        },
      },
      validate: () => [{
        id: "scheduled-wave-check",
        label: "Scheduled wave check",
        status: "pass" as const,
        required: true,
        summary: "combined validation passed",
      }],
      now,
    });

    expect(preparationWorktree).toBeDefined();
    expect(prepared.transaction.status).toBe("prepared");
    expect(prepared.preparedModules.map((item) => item.moduleId)).toEqual(["service"]);
    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-scheduled-preparation"])).toBe("");
  });

  it("prepares, then commits code, summary, snapshot, and run manifest as one approved wave", async () => {
    const root = await repository();
    const source = analysis();
    const plan = planWithPlanApproval(source);
    const coordinator = new ModuleWaveExecutionCoordinator();
    const { prepared } = await prepareWave(root, source, plan);

    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-01"])).toBe("");
    expect(prepared.transaction.status).toBe("prepared");
    expect(prepared.transaction.preparedHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.plan.status).toBe("executing");
    expect(prepared.plan.executionWaves[0]?.status).toBe("awaiting-approval");
    expect(prepared.manifest.transactions).toEqual([prepared.transaction]);
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("old implementation");

    const approved = approvePreparedWave(prepared.plan, prepared.transaction.preparedHash);
    const result = await coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan: approved,
      manifest: prepared.manifest,
      prepared,
      now,
    });

    expect(result.branchName).toBe("codex/forexplore-migration/run-01");
    expect(result.transaction.status).toBe("committed");
    expect(result.transaction.commit).toBe(result.commit);
    expect(result.summary.generated.executionWaves[0]?.status).toBe("committed");
    expect(await readFile(path.join(root, "src", "Service.cs"), "utf8")).toBe("old implementation");
    expect(git(root, ["show", `${result.branchName}:src/Service.cs`])).toBe("new implementation");

    const summary = JSON.parse(git(root, ["show", `${result.branchName}:.forexplore/module-summary.json`])) as {
      human: { approvalsCurrent: boolean };
    };
    expect(summary.human.approvalsCurrent).toBe(true);
    expect(git(root, ["show", `${result.branchName}:.forexplore/analysis/${source.snapshotId}.json`]))
      .toContain(`"snapshotId":"${source.snapshotId}"`);
    const run = JSON.parse(git(root, ["show", `${result.branchName}:.forexplore/runs/run-01.json`])) as {
      transactions: Array<{ waveId: string; status: string; preparedHash: string; baseCommit: string }>;
    };
    expect(run.transactions).toEqual([expect.objectContaining({
      waveId: plan.executionWaves[0]!.id,
      status: "committed",
      preparedHash: prepared.transaction.preparedHash,
      baseCommit: prepared.transaction.baseCommit,
    })]);
  });

  it("rejects missing or mismatched prepared-bundle approval without publishing a branch", async () => {
    const root = await repository();
    const source = analysis();
    const plan = planWithPlanApproval(source);
    const coordinator = new ModuleWaveExecutionCoordinator();
    const { prepared } = await prepareWave(root, source, plan, "run-02");

    await expect(coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan,
      manifest: prepared.manifest,
      prepared,
      now,
    })).rejects.toThrow("lacks a human approval");

    const wrongApproval = approvePreparedWave(prepared.plan, "sha256:wrong-bundle");
    await expect(coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan: wrongApproval,
      manifest: prepared.manifest,
      prepared,
      now,
    })).rejects.toThrow("lacks a human approval");
    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-02"])).toBe("");
  });

  it("rejects a commit when the prepared Git baseline moved", async () => {
    const root = await repository();
    const source = analysis();
    const plan = planWithPlanApproval(source);
    const coordinator = new ModuleWaveExecutionCoordinator();
    const { prepared } = await prepareWave(root, source, plan, "run-03");
    const approved = approvePreparedWave(prepared.plan, prepared.transaction.preparedHash);

    git(root, ["commit", "--allow-empty", "-m", "external baseline move"]);
    await expect(coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan: approved,
      manifest: prepared.manifest,
      prepared,
      now,
    })).rejects.toThrow("baseline changed after preparation");
    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-03"])).toBe("");
  });

  it("rejects a first wave when the indexed Git revision is stale", async () => {
    const root = await repository();
    const source = await analyzeRepository({ root, createdAt: now });
    const indexedModule: FunctionalModule = {
      ...module(),
      symbolIds: [],
      evidenceIds: [],
    };
    const indexedProposal: ModuleMigrationProposal = {
      ...proposal(source),
      modules: [indexedModule],
      fileAssignments: [{ path: "src/Service.cs", kind: "module", moduleId: "service" }],
    };
    const initial = buildModuleMigrationPlan(source, indexedProposal, { now });
    const plan = recordModulePlanDecision(initial, {
      id: "stale-revision-plan-approval",
      kind: "plan-approval",
      status: "approved",
      snapshotId: initial.snapshotId,
      planHash: initial.planHash,
      actor: "reviewer",
      decidedAt: now,
    }, source.snapshotId, now);
    git(root, ["commit", "--allow-empty", "-m", "external clean revision"]);

    await expect(new ModuleWaveExecutionCoordinator().prepare({
      repositoryRoot: root,
      analysis: source,
      plan,
      manifest: createMigrationRunManifest(plan, "run-stale-revision", now),
      waveId: plan.executionWaves[0]!.id,
      preparedModules: preparedModulePatches(),
      validate: () => [{
        id: "stale-revision-check",
        label: "Stale revision check",
        status: "pass" as const,
        required: true,
        summary: "not reached",
      }],
      now,
    })).rejects.toThrow("baseline changed after preparation");
    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-stale-revision"])).toBe("");
  });

  it("binds a prepared approval to the run's sole managed branch", async () => {
    const root = await repository();
    const source = analysis();
    const plan = planWithPlanApproval(source);
    const coordinator = new ModuleWaveExecutionCoordinator();
    const { prepared } = await prepareWave(root, source, plan, "run-branch-binding");
    const approved = approvePreparedWave(prepared.plan, prepared.transaction.preparedHash);

    await expect(coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan: approved,
      manifest: prepared.manifest,
      prepared: {
        ...prepared,
        branchName: "codex/forexplore-migration/other-run",
      },
      now,
    })).rejects.toThrow("Prepared wave transaction is incomplete");

    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-branch-binding"])).toBe("");
    expect(git(root, ["branch", "--list", "codex/forexplore-migration/other-run"])).toBe("");
  });

  it("rejects a caller-supplied analysis object that is not an immutable snapshot", async () => {
    const root = await repository();
    const source = analysis();
    const plan = planWithPlanApproval(source);
    const tampered = {
      ...source,
      files: [{ ...source.files[0]!, sha256: "tampered" }],
    };

    await expect(prepareWave(root, tampered, plan, "run-tampered-analysis"))
      .rejects.toThrow("not a verified immutable snapshot");
    expect(git(root, ["branch", "--list", "codex/forexplore-migration/run-tampered-analysis"])).toBe("");
  });

  it("accepts an already-stored immutable snapshot collected at a different time", async () => {
    const root = await repository();
    const source = analysis();
    const artifactDirectory = path.join(root, ".forexplore", "analysis");
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      path.join(artifactDirectory, `${source.snapshotId}.json`),
      `${JSON.stringify({ ...source, createdAt: "2026-08-27T01:00:00.000Z" })}\n`,
      "utf8",
    );
    git(root, ["add", ".forexplore"]);
    git(root, ["commit", "-m", "persist equivalent snapshot"]);

    const plan = planWithPlanApproval(source);
    const coordinator = new ModuleWaveExecutionCoordinator();
    const { prepared } = await prepareWave(root, source, plan, "run-equivalent-snapshot");
    const approved = approvePreparedWave(prepared.plan, prepared.transaction.preparedHash);
    const result = await coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan: approved,
      manifest: prepared.manifest,
      prepared,
      now,
    });

    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("continues later waves from the committed branch manifest without a self-referential commit ID", async () => {
    const root = await repository();
    const contractOriginal = "namespace Demo;\npublic interface Contract {}\n";
    const serviceOriginal = "namespace Demo;\npublic class Service : Contract {}\n";
    await writeFile(path.join(root, "src", "Contract.cs"), contractOriginal, "utf8");
    await writeFile(path.join(root, "src", "Service.cs"), serviceOriginal, "utf8");
    git(root, ["add", "src"]);
    git(root, ["commit", "-m", "add two migration modules"]);

    const source = await analyzeRepository({ root, createdAt: now });
    const contractSymbol = source.symbols.find(
      (symbol) => symbol.path === "src/Contract.cs" && symbol.kind === "interface",
    );
    const serviceSymbol = source.symbols.find(
      (symbol) => symbol.path === "src/Service.cs" && symbol.kind === "class",
    );
    if (!contractSymbol || !serviceSymbol) throw new Error("Expected C# fixture symbols.");

    const twoWaveProposal: ModuleMigrationProposal = {
      schemaVersion: moduleMigrationSchemaVersion,
      snapshotId: source.snapshotId,
      objective: "Migrate contract before service",
      modules: [
        {
          id: "contract",
          name: "Contract",
          kind: "shared-contract",
          description: "Shared public contract",
          sourceFiles: ["src/Contract.cs"],
          symbolIds: [contractSymbol.id],
          dependsOn: [],
          writeSet: ["src/Contract.cs"],
          resourceLocks: ["public-contract"],
          evidenceIds: [contractSymbol.id],
        },
        {
          id: "service",
          name: "Service",
          kind: "feature",
          description: "Contract consumer",
          sourceFiles: ["src/Service.cs"],
          symbolIds: [serviceSymbol.id],
          dependsOn: ["contract"],
          writeSet: ["src/Service.cs"],
          resourceLocks: [],
          evidenceIds: [serviceSymbol.id],
        },
      ],
      fileAssignments: [
        { path: "src/Contract.cs", kind: "module", moduleId: "contract" },
        { path: "src/Service.cs", kind: "module", moduleId: "service" },
      ],
    };
    const initial = buildModuleMigrationPlan(source, twoWaveProposal, { now });
    const plan = recordModulePlanDecision(initial, {
      id: "two-wave-plan-approval",
      kind: "plan-approval",
      status: "approved",
      snapshotId: initial.snapshotId,
      planHash: initial.planHash,
      actor: "reviewer",
      decidedAt: now,
    }, source.snapshotId, now);
    const [contractWave, serviceWave] = plan.executionWaves;
    if (!contractWave || !serviceWave) throw new Error("Expected two ordered execution waves.");
    const coordinator = new ModuleWaveExecutionCoordinator();
    const manifest = createMigrationRunManifest(plan, "run-two-waves", now);

    const preparedContract = await coordinator.prepare({
      repositoryRoot: root,
      analysis: source,
      plan,
      manifest,
      waveId: contractWave.id,
      preparedModules: [{
        moduleId: "contract",
        files: [patch(contractOriginal, "namespace Demo;\npublic interface Contract { int Version { get; } }\n", "src/Contract.cs")],
        validation: [{
          id: "contract-check",
          label: "Contract check",
          status: "pass",
          required: true,
          summary: "contract patch verified",
        }],
      }],
      validate: () => [{
        id: "shared-wave-check",
        label: "Contract wave check",
        status: "pass",
        required: true,
        summary: "joint contract validation",
      }],
      now,
    });
    const forgedCommittedPrerequisite = {
      ...preparedContract.manifest,
      transactions: [{
        ...preparedContract.transaction,
        status: "committed" as const,
        completedAt: now,
      }],
    };
    await expect(coordinator.prepare({
      repositoryRoot: root,
      analysis: source,
      plan,
      manifest: forgedCommittedPrerequisite,
      waveId: serviceWave.id,
      preparedModules: [{
        moduleId: "service",
        files: [patch(serviceOriginal, "namespace Demo;\npublic class Service : Contract { public int Version => 1; }\n")],
        validation: [{
          id: "forged-service-check",
          label: "Service check",
          status: "pass",
          required: true,
          summary: "must not reach Git preparation",
        }],
      }],
      validate: () => [],
      now,
    })).rejects.toThrow(`Committed prerequisite ${contractWave.id} is not published`);
    const approvedContract = recordModulePlanDecision(preparedContract.plan, {
      id: "two-wave-contract-approval",
      kind: "wave-approval",
      status: "approved",
      snapshotId: preparedContract.plan.snapshotId,
      planHash: preparedContract.plan.planHash,
      waveId: contractWave.id,
      preparedHash: preparedContract.transaction.preparedHash,
      actor: "reviewer",
      decidedAt: now,
    }, source.snapshotId, now);
    const committedContract = await coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan: approvedContract,
      manifest: preparedContract.manifest,
      prepared: preparedContract,
      now,
    });

    const persistedManifest = JSON.parse(git(
      root,
      ["show", `${committedContract.branchName}:.forexplore/runs/run-two-waves.json`],
    )) as typeof committedContract.manifest;
    expect(persistedManifest.transactions[0]?.status).toBe("committed");
    expect(persistedManifest.transactions[0]?.commit).toBeUndefined();

    const preparedService = await coordinator.prepare({
      repositoryRoot: root,
      analysis: source,
      plan: committedContract.plan,
      manifest: persistedManifest,
      waveId: serviceWave.id,
      preparedModules: [{
        moduleId: "service",
        files: [patch(serviceOriginal, "namespace Demo;\npublic class Service : Contract { public int Version => 1; }\n")],
        validation: [{
          id: "service-wave-two-check",
          label: "Service check",
          status: "pass",
          required: true,
          summary: "service patch verified",
        }],
      }],
      validate: () => [{
        id: "shared-wave-check",
        label: "Service wave check",
        status: "pass",
        required: true,
        summary: "joint service validation",
      }],
      now,
    });
    const approvedService = recordModulePlanDecision(preparedService.plan, {
      id: "two-wave-service-approval",
      kind: "wave-approval",
      status: "approved",
      snapshotId: preparedService.plan.snapshotId,
      planHash: preparedService.plan.planHash,
      waveId: serviceWave.id,
      preparedHash: preparedService.transaction.preparedHash,
      actor: "reviewer",
      decidedAt: now,
    }, source.snapshotId, now);
    const committedService = await coordinator.commit({
      repositoryRoot: root,
      analysis: source,
      plan: approvedService,
      manifest: preparedService.manifest,
      prepared: preparedService,
      now,
    });

    expect(committedService.plan.status).toBe("completed");
    expect(git(root, ["show", `${committedService.branchName}:src/Contract.cs`]))
      .toContain("int Version");
    expect(git(root, ["show", `${committedService.branchName}:src/Service.cs`]))
      .toContain("public int Version => 1");
  }, 20_000);
});
