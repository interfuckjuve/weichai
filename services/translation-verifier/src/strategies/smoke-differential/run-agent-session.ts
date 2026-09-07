import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import { currentRunRecorder, measureStep } from "../../run-output/record-run.js";
import { observeAgentSteps } from "./observe-agent-steps.js";
import { runClaude } from "./claude-session.js";
import type { prepareAgentTask } from "./build-test-task.js";

export async function runAgentTests(task: ReturnType<typeof prepareAgentTask>): Promise<void> {
  await measureStep("run-agent-session", async () => {
    markVerificationPhase("agent-session");
    const recorder = currentRunRecorder();
    const observer = recorder ? observeAgentSteps(recorder) : undefined;
    try {
      await runClaude(task.prompt, { ...task.llm, ...(observer ? { onStdoutChunk: observer.push } : {}) });
    } finally {
      observer?.finish();
    }
  });
}
