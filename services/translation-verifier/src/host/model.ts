export type AgentToolCall = {
  id: string;
  name: string;
  /** Provider-neutral serialized JSON arguments. Host parses them again before execution. */
  arguments: string;
};

export type AgentMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string;
      toolCalls?: readonly AgentToolCall[];
    }
  | {
      role: "tool";
      content: string;
      toolCallId: string;
    };

export type AgentToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AgentCompletion = {
  content?: string;
  toolCalls?: readonly AgentToolCall[];
};

/**
 * Provider-neutral model port used by the verifier Agent runtime.
 * API keys, provider selection, request serialization, and response parsing
 * belong to the caller that supplies this port.
 */
export interface AgentModelClient {
  complete(
    messages: readonly AgentMessage[],
    tools: readonly AgentToolDefinition[],
    signal?: AbortSignal,
  ): Promise<AgentCompletion>;
}
