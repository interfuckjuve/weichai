import { join } from "node:path";
import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import { DEFAULT_DISALLOWED_TOOLS, VERIFIER_COMMAND_ENTRY } from "../strategies/test-execution-config.js";
import { buildSmokeTaskPrompt, type SmokeTaskInput } from "../strategies/build-differential-test-prompt.js";
import type { RunLayout } from "../strategies/prepare-smoke-projects.js";
import type { SmokeRunOptions } from "../strategies/run-smoke-verification.js";

export function prepareAgentTask(
  job: SmokeTaskInput,
  options: SmokeRunOptions,
  layout: RunLayout,
  signal?: AbortSignal,
) {
  const mode = options.mode ?? "verify-only";
  const timeoutMs = options.timeoutMs ?? 300_000;
  signal?.throwIfAborted();

  // 兼容暂存把双侧输入搬到请求级项目副本,提示/上下文一律指向暂存根。
  const promptJob: SmokeTaskInput =
    options.workspaceDir !== undefined
      ? job
      : {
          ...job,
          source: {
            ...job.source,
            root: layout.projectRoots[0] ?? job.source.root,
          },
          target: {
            ...job.target,
            root: layout.projectRoots[1] ?? job.target.root,
          },
        };

  const deadlineAt = Date.now() + timeoutMs;
  const allowedTools = [`Bash(npx tsx ${VERIFIER_COMMAND_ENTRY} *)`];
  const env: Record<string, string> = {
    VERIFIER_WORKSPACE_ROOT: layout.executionRoot,
    VERIFIER_BASELINE_PATH: layout.baselinePath,
    VERIFIER_COMMAND_EVIDENCE_PATH: layout.evidencePath,
    VERIFIER_DEADLINE_AT: String(deadlineAt),
  };
  if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
  const llm = {
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs,
    ...(options.spawnClaude ? { spawnClaude: options.spawnClaude } : {}),
    cwd: layout.agentDir,
    addDirs: [...layout.projectRoots, ...layout.runnerDirs, layout.agentDir],
    readOnlyDirs: layout.projectRoots,
    permissionMode: "acceptEdits" as const,
    maxTurns: options.maxTurns ?? 50,
    ...(options.effort ? { effort: options.effort } : {}),
    hooksLogPath: join(layout.agentDir, "claude-steps.jsonl"),
    allowedTools,
    disallowedTools: [...DEFAULT_DISALLOWED_TOOLS],
    env,
    ...(signal ? { signal } : {}),
    deadlineAt,
  };
  markVerificationPhase("prompt-construction");
  const prompt = [
    buildSmokeTaskPrompt(promptJob, mode),
    executionContextSection(promptJob, layout),
  ].join("\n\n");

  return { layout, prompt, llm };
}

/** 运行期执行上下文(注入绝对路径与唯一 Bash 形态),由宿主在 prompt 后附加。 */
function executionContextSection(
  job: SmokeTaskInput,
  layout: RunLayout,
): string {
  return `EXECUTION CONTEXT (host-injected, authoritative)
- Execution/workspace root: ${layout.executionRoot}
- Source project (READ-ONLY): ${layout.projectRoots[0] ?? "(not resolved)"}
  candidate file: ${job.source.candidatePath ?? "(browse)"}
- Target project (READ-ONLY): ${layout.projectRoots[1] ?? "(not resolved)"}
  target file under test: ${job.target.file ?? "(browse)"}
- Source runner directory (the ONLY writable source area): ${layout.runnerDirs[0]}
- Target runner directory (the ONLY writable target area): ${layout.runnerDirs[1]}
- Agent working directory (write report.json here): ${layout.agentDir}

VERIFIER-COMMAND PROXY (the ONLY allowed Bash form)
Run every compile/run through the proxy; never invoke javac/java/dotnet/python3/tsx directly.
  npx tsx ${VERIFIER_COMMAND_ENTRY} --side source|target --phase compile|run --cwd <rel> -- <command...>
where <rel> is relative to the execution root above (for example "source/project" or
"target/project"). After each proxied command, read the last line of commands.jsonl in
your working directory and copy its commandId plus side/phase/exitCode/durationMs into the
report executions entry. Never invent commandIds or exit codes.`;
}
