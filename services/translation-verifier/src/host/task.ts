import type { AgentTaskContext, HostToolFactory } from "./tools/common.js";

/**
 * One Agent call: the application prompt plus the native LangChain tools the
 * strategy selected. The Agent ends the call by answering without a tool call.
 */
export type AgentTask = {
  taskContext: AgentTaskContext;
  systemPrompt: string;
  userPrompt: string;
  tools: readonly HostToolFactory[];
};

/** The application seam a strategy runs its task through. */
export interface AgentHost<Result = unknown> {
  run(task: AgentTask): Result | Promise<Result>;
}
