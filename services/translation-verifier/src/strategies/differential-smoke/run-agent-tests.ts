import { markVerificationPhase } from "../../verification-timing.js";
import { currentRunRecorder } from "../../record-run-events.js";
import { runClaude } from "./claude-client.js";
import type { prepareAgentTask } from "./prepare-agent-task.js";

export async function runAgentTests(
  task: ReturnType<typeof prepareAgentTask>,
): Promise<void> {
  const recorder = currentRunRecorder();
  const observed = recorder?.snapshot().stages[2].state === "completed";
  if (observed) recorder!.startStage("run-agent-tests");
  markVerificationPhase("agent-session");
  await runClaude(task.prompt, task.llm);
  if (observed) recorder!.endStage("run-agent-tests", "completed");
}
