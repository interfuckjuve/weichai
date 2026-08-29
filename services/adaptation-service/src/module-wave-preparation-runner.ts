import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  ExecutionGroup,
  ExecutionWave,
  FunctionalModule,
  ModuleMigrationPlan,
  RepositoryStaticAnalysis,
} from "@forexplore/contracts";
import { verifyRepositoryStaticAnalysis } from "@forexplore/code-indexer";
import { validateModuleMigrationPlan } from "@forexplore/workflow-core";
import type { PreparedModulePatch } from "./module-wave-execution";

export interface ModulePatchPreparationContext {
  repositoryRoot: string;
  /** Disposable, detached worktree at the exact wave baseline. */
  worktreeRoot: string;
  analysis: RepositoryStaticAnalysis;
  plan: ModuleMigrationPlan;
  wave: ExecutionWave;
  group: ExecutionGroup;
  module: FunctionalModule;
}

/**
 * A code-generation host supplies this boundary. It receives a read-only
 * disposable checkout and must return a patch rather than changing it.
 */
export interface ModulePatchPreparer {
  prepareModule(
    context: ModulePatchPreparationContext,
    signal?: AbortSignal,
  ): Promise<PreparedModulePatch> | PreparedModulePatch;
}

export interface PrepareModuleWavePatchesRequest {
  repositoryRoot: string;
  analysis: RepositoryStaticAnalysis;
  plan: ModuleMigrationPlan;
  waveId: string;
  /** The run's managed branch, when prior waves have already been published. */
  branchName?: string;
  /** Tighten, but never exceed, the scheduler-selected concurrency limit. */
  maxParallelism?: number;
  signal?: AbortSignal;
}

/**
 * Runs module patch preparation according to the deterministic schedule.
 *
 * Every module receives a distinct detached worktree. Members of an SCC or a
 * shared-contract group execute serially; independent groups in the same wave
 * may run concurrently up to the wave's configured limit. The runner rejects
 * a preparer that modifies its checkout, so only returned FilePatch evidence
 * can reach the combined wave transaction.
 */
export class ModuleWavePreparationRunner {
  constructor(private readonly preparer: ModulePatchPreparer) {}

  async prepare(
    request: PrepareModuleWavePatchesRequest,
  ): Promise<PreparedModulePatch[]> {
    request.signal?.throwIfAborted();
    const repositoryRoot = resolve(request.repositoryRoot);
    assertGitRepository(repositoryRoot);
    assertNoTrackedChanges(repositoryRoot);

    const analysis = verifyRepositoryStaticAnalysis(request.analysis);
    const validation = validateModuleMigrationPlan(request.plan, analysis);
    if (!validation.valid) {
      throw new Error(`Module migration plan is invalid: ${validation.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.code)
        .join(", ")}`);
    }

    const wave = request.plan.executionWaves.find((item) => item.id === request.waveId);
    if (!wave) throw new Error(`Unknown execution wave: ${request.waveId}`);
    const groups = groupsForWave(request.plan, wave);
    const baseCommit = resolveWaveBaseCommit(
      repositoryRoot,
      request.branchName,
      analysis.repository.revision,
    );
    const configuredLimit = request.maxParallelism ?? wave.maxParallelism;
    if (!Number.isInteger(configuredLimit) || configuredLimit < 1) {
      throw new RangeError("Module wave preparation concurrency must be a positive integer.");
    }
    const maxParallelism = Math.min(configuredLimit, wave.maxParallelism);

    const prepared = await mapWithConcurrency(groups, maxParallelism, async (group) => {
      const groupPrepared: PreparedModulePatch[] = [];
      for (const moduleId of group.moduleIds) {
        request.signal?.throwIfAborted();
        const module = request.plan.modules.find((item) => item.id === moduleId);
        if (!module) throw new Error(`Execution group ${group.id} references unknown module ${moduleId}.`);
        groupPrepared.push(await this.prepareModule({
          repositoryRoot,
          baseCommit,
          analysis,
          plan: request.plan,
          wave,
          group,
          module,
          signal: request.signal,
        }));
      }
      return groupPrepared;
    });

    const flattened = prepared.flat().sort((left, right) => left.moduleId.localeCompare(right.moduleId));
    const expected = [...wave.moduleIds].sort((left, right) => left.localeCompare(right));
    if (
      flattened.length !== expected.length ||
      flattened.some((item, index) => item.moduleId !== expected[index])
    ) {
      throw new Error(`Module patch preparer did not return exactly the modules in ${wave.id}.`);
    }
    return flattened;
  }

  private async prepareModule(input: {
    repositoryRoot: string;
    baseCommit: string;
    analysis: RepositoryStaticAnalysis;
    plan: ModuleMigrationPlan;
    wave: ExecutionWave;
    group: ExecutionGroup;
    module: FunctionalModule;
    signal?: AbortSignal;
  }): Promise<PreparedModulePatch> {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "forexplore-module-prepare-"));
    const worktreeRoot = join(temporaryRoot, "worktree");
    let worktreeAdded = false;
    try {
      git(input.repositoryRoot, ["worktree", "add", "--detach", worktreeRoot, input.baseCommit]);
      worktreeAdded = true;
      const result = await this.preparer.prepareModule({
        repositoryRoot: input.repositoryRoot,
        worktreeRoot,
        analysis: input.analysis,
        plan: input.plan,
        wave: input.wave,
        group: input.group,
        module: input.module,
      }, input.signal);
      input.signal?.throwIfAborted();
      if (result.moduleId !== input.module.id) {
        throw new Error(`Module patch preparer returned ${result.moduleId} for ${input.module.id}.`);
      }
      assertWorktreeClean(worktreeRoot);
      return result;
    } finally {
      if (worktreeAdded) {
        try {
          git(input.repositoryRoot, ["worktree", "remove", "--force", worktreeRoot]);
        } catch {
          // The temporary root is uniquely owned by this runner and is removed below.
        }
      }
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  }
}

function groupsForWave(plan: ModuleMigrationPlan, wave: ExecutionWave): ExecutionGroup[] {
  const byId = new Map(plan.executionGroups.map((group) => [group.id, group]));
  const groups = wave.groupIds.map((id) => byId.get(id));
  if (groups.some((group) => group === undefined)) {
    throw new Error(`Execution wave ${wave.id} references an unknown execution group.`);
  }
  const result = groups as ExecutionGroup[];
  const moduleIds = result.flatMap((group) => group.moduleIds).sort((left, right) => left.localeCompare(right));
  const expected = [...wave.moduleIds].sort((left, right) => left.localeCompare(right));
  if (
    moduleIds.length !== expected.length ||
    moduleIds.some((moduleId, index) => moduleId !== expected[index])
  ) {
    throw new Error(`Execution wave ${wave.id} does not match its execution groups.`);
  }
  return result;
}

function resolveWaveBaseCommit(
  repositoryRoot: string,
  branchName: string | undefined,
  analysisRevision: string | undefined,
): string {
  const branchTip = branchName === undefined
    ? undefined
    : tryGit(repositoryRoot, ["rev-parse", "--verify", `refs/heads/${branchName}`])?.trim();
  const baseCommit = branchTip ?? git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/i.test(baseCommit)) {
    throw new Error("Module wave baseline is not a full Git object ID.");
  }
  if (
    branchTip === undefined &&
    analysisRevision !== undefined &&
    /^[0-9a-f]{40}$/i.test(analysisRevision) &&
    analysisRevision !== baseCommit
  ) {
    throw new Error("Module wave baseline changed after static analysis; re-index and reapprove the plan.");
  }
  return baseCommit;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await run(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function assertGitRepository(root: string): void {
  if (tryGit(root, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") {
    throw new Error("Module wave preparation requires a Git worktree.");
  }
}

function assertNoTrackedChanges(root: string): void {
  const changes = git(root, ["status", "--porcelain", "--untracked-files=no"]).trim();
  if (changes) {
    throw new Error("Module wave preparation requires no tracked changes in the source worktree.");
  }
}

function assertWorktreeClean(root: string): void {
  const changes = git(root, ["status", "--porcelain", "--untracked-files=all"]).trim();
  if (changes) {
    throw new Error("Module patch preparer modified its isolated worktree; return FilePatch evidence instead.");
  }
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Git command failed (${args.join(" ")}): ${detail}`, { cause: error });
  }
}

function tryGit(root: string, args: string[]): string | undefined {
  try {
    return git(root, args);
  } catch {
    return undefined;
  }
}
