import { resolveVerificationPolicy } from "../../schemas/verification-assessment.js";
import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import {
  DEFAULT_DISALLOWED_TOOLS,
  VERIFIER_COMMAND_ENTRY,
} from "./test-execution-config.js";
import {
  buildSmokeTaskPrompt,
  type SmokeTaskInput,
} from "./build-differential-test-prompt.js";
import type { RunLayout } from "./prepare-projects.js";
import type { SmokeRunOptions } from "./run-smoke-verification.js";

export function prepareAgentTask(
  job: SmokeTaskInput,
  options: SmokeRunOptions,
  signal?: AbortSignal,
) {
  const layout = options.layout;
  const differential = resolveVerificationPolicy(job).mode === "differential";
  signal?.throwIfAborted();
  const deadlineAt = options.deadlineAt;

  const allowedTools = [`Bash(npx tsx ${VERIFIER_COMMAND_ENTRY} *)`];
  const env: Record<string, string> = {
    VERIFIER_MODE: differential ? "differential" : "target_only",
    VERIFIER_WORKSPACE_ROOT: layout.executionRoot,
    VERIFIER_BASELINE_PATH: layout.baselinePath,
    VERIFIER_COMMAND_EVIDENCE_PATH: layout.evidencePath,
    VERIFIER_DEADLINE_AT: String(deadlineAt),
  };
  if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
  const llm = {
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs: Math.max(1, deadlineAt - Date.now()),
    ...(options.spawnClaude ? { spawnClaude: options.spawnClaude } : {}),
    cwd: layout.agentDir,
    addDirs: [...layout.projectRoots, ...layout.runnerDirs, layout.agentDir],
    readOnlyDirs: layout.projectRoots,
    permissionMode: "acceptEdits" as const,
    maxTurns: options.maxTurns ?? 50,
    ...(options.effort ? { effort: options.effort } : {}),
    allowedTools,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    env,
    ...(signal ? { signal } : {}),
    deadlineAt,
  };
  markVerificationPhase("prompt-construction");
  const prompt = [
    buildSmokeTaskPrompt(job),
    executionContextSection(job, layout),
  ].join("\n\n");

  return { layout, prompt, llm };
}

/** 运行期执行上下文(注入绝对路径与唯一 Bash 形态),由宿主在 prompt 后附加。 */
function executionContextSection(
  job: SmokeTaskInput,
  layout: RunLayout,
): string {
  const differential = resolveVerificationPolicy(job).mode === "differential";
  return `EXECUTION CONTEXT (host-injected, authoritative)
- Execution/workspace root: ${layout.executionRoot}
${
  differential
    ? `- Source project (READ-ONLY): ${layout.projectRoots[0]}
  candidate file: ${job.source.candidatePath ?? "(browse)"}
- Source runner directory: ${layout.runnerDirs[0]}\n`
    : ""
}- Target project (READ-ONLY): ${layout.projectRoots.at(-1) ?? "(not resolved)"}
  target file under test: ${job.target.file ?? "(browse)"}
- Target runner directory (the ONLY writable target area): ${layout.runnerDirs.at(-1)}
- Agent working directory (write report.json here): ${layout.agentDir}

VERIFIER-COMMAND PROXY (the ONLY allowed Bash form)
Run every compile/run through the proxy; never invoke javac/java/dotnet/python3/tsx directly.
  npx tsx ${VERIFIER_COMMAND_ENTRY} --side ${differential ? "source|target" : "target"} --phase compile|run --cwd <rel> -- <command...>
where <rel> is relative to the execution root above (for example "target/project"). After each proxied command, read the last line of commands.jsonl in
your working directory and copy its commandId plus side/phase/exitCode/durationMs into the
report executions entry. Never invent commandIds or exit codes.`;
}
