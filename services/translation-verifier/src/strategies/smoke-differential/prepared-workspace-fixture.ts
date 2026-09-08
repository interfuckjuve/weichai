import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VerificationStrategyContext } from "../../schemas/verification-types.js";
import { resolveVerificationPolicy } from "../../schemas/verification-assessment.js";
import type { SmokeTaskInput } from "./build-differential-test-prompt.js";
import { prepareCallerOwnedWorkspace } from "./prepare-smoke-workspace.js";

/** Test caller owns staging and cleanup; the runner receives only prepared paths. */
export function prepareSmokeWorkspaceFixture(
  parent: string,
  input: SmokeTaskInput,
) {
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "prepared-"));
  const sourceRoot = join(root, "source/project");
  const targetRoot = join(root, "target/project");
  const strategyRoot = join(root, "agent");
  const differential = resolveVerificationPolicy(input).mode === "differential";
  const stage = (
    destination: string,
    origin: string | undefined,
    file: string,
  ) => {
    mkdirSync(destination, { recursive: true });
    if (origin) cpSync(origin, destination, { recursive: true });
    else {
      const path = join(destination, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "// prepared test implementation\n");
    }
  };
  if (differential)
    stage(
      sourceRoot,
      input.source.root,
      input.source.candidatePath ?? "Source.ts",
    );
  stage(targetRoot, input.target.root, input.target.file ?? "Target.ts");
  const workspace = {
    root,
    sourceRoot,
    targetRoot,
    strategyRoot,
    evidenceRoot: strategyRoot,
  };
  const context: VerificationStrategyContext = {
    workspace,
    deadlineAt: Date.now() + 300_000,
    writeArtifact: (artifact) => artifact,
  };
  const layout = prepareCallerOwnedWorkspace(context, differential);
  const job: SmokeTaskInput = {
    requirement: input.requirement,
    analysisReport: differential ? input.analysisReport : undefined,
    verificationPolicy: input.verificationPolicy,
    source: differential
      ? { ...input.source, root: sourceRoot }
      : { language: input.target.language },
    target: { ...input.target, root: targetRoot },
  };
  return {
    job,
    layout,
    deadlineAt: context.deadlineAt,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
