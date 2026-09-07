import { markVerificationPhase } from "../../run-output/measure-legacy-run.js";
import { measureStep } from "../../run-output/record-run.js";
import { runClaude } from "./claude-session.js";
import type { prepareAgentTask } from "./build-test-task.js";

export async function runAgentTests(task: ReturnType<typeof prepareAgentTask>): Promise<void> {
  await measureStep("run-agent-session", async () => {
    markVerificationPhase("agent-session");
    await runClaude(task.prompt, task.llm);
  });
}
