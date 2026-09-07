import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import { currentRunRecorder } from "../run-output/record-run.js";
import { runClaude } from "../strategies/claude-session.js";
import type { prepareAgentTask } from "./build-test-task.js";

export async function runAgentTests(
  task: ReturnType<typeof prepareAgentTask>,
): Promise<void> {
  const recorder = currentRunRecorder();
  const stages = recorder?.snapshot().stages;
  const observed = stages?.[2].state === "completed" && stages[3].state === "not-started";
  if (observed) recorder!.startStage("run-agent-tests");
  try {
    markVerificationPhase("agent-session");
    await runClaude(task.prompt, task.llm);
    if (observed) recorder!.endStage("run-agent-tests", "completed");
  } catch (error) {
    const cancelled = typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
    if (observed) recorder!.endStage("run-agent-tests", cancelled ? "cancelled" : "failed", error);
    throw error;
  }
}
