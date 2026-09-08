import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createWorkspaceBaseline,
  writeWorkspaceBaseline,
} from "./protect-project-files.js";
import type { VerificationStrategyContext } from "../../schemas/verification-types.js";

/** Fixed paths prepared once by the caller for one verification session. */
export interface RunLayout {
  executionRoot: string;
  agentDir: string;
  baselinePath: string;
  evidencePath: string;
  runnerRoots: readonly [string, string];
  projectRoots: string[];
  runnerDirs: string[];
}
export const smokeRunnerRoots = [
  "source/.forexplore-tests",
  "target/.forexplore-tests",
] as const;
const MUTABLE_FILES = [
  "agent/report.json",
  "agent/claude-steps.jsonl",
  "agent/commands.jsonl",
] as const;

/** Add smoke runner directories and a baseline to staged projects; the caller owns cleanup. */
export function prepareCallerOwnedWorkspace(
  context: VerificationStrategyContext,
  differential: boolean,
): RunLayout {
  const { root, strategyRoot, targetRoot } = context.workspace;
  const runnerDirs = smokeRunnerRoots
    .filter((_, index) => differential || index === 1)
    .map((path) => join(root, path));
  mkdirSync(strategyRoot, { recursive: true });
  for (const dir of runnerDirs) mkdirSync(dir, { recursive: true });
  const baselinePath = join(root, "baseline.json");
  writeWorkspaceBaseline(
    baselinePath,
    createWorkspaceBaseline(root, smokeRunnerRoots, MUTABLE_FILES),
  );
  return {
    executionRoot: root,
    agentDir: strategyRoot,
    baselinePath,
    evidencePath: join(strategyRoot, "commands.jsonl"),
    runnerRoots: smokeRunnerRoots,
    projectRoots: differential
      ? [context.workspace.sourceRoot, targetRoot]
      : [targetRoot],
    runnerDirs,
  };
}
