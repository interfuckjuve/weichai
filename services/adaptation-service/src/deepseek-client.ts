import { deepSeekModelConfig, type DeepSeekModelConfig } from "./model-config";

export interface DeepSeekMessage {
  role: "system" | "user";
  content: string;
}

export interface DeepSeekClientOptions {
  apiKey: string;
  modelConfig?: DeepSeekModelConfig;
  request?: typeof globalThis.fetch;
  temperature?: number;
  jsonMode?: boolean;
}

/** Minimal OpenAI-compatible function-tool shape used by the semantic planner. */
export interface DeepSeekToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DeepSeekToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface DeepSeekToolMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: readonly DeepSeekToolCall[];
  toolCallId?: string;
}

export interface DeepSeekToolCompletion {
  content?: string;
  toolCalls?: DeepSeekToolCall[];
}

/**
 * Stateless DeepSeek chat-completions call used by one specialized agent.
 * Callers always provide a complete prompt, so no agent conversation history
 * is shared between Analyzer and Translator.
 */
export async function completeWithDeepSeek(
  messages: readonly DeepSeekMessage[],
  options: DeepSeekClientOptions,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for DeepSeek requests.");

  const modelConfig = options.modelConfig ?? deepSeekModelConfig;
  const request = options.request ?? globalThis.fetch.bind(globalThis);
  const response = await request(`${modelConfig.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelConfig.model,
      messages,
      thinking: { type: "disabled" },
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
    signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek API error ${response.status}: ${raw}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("DeepSeek API returned invalid JSON.");
  }

  const content = chatCompletionContent(data);
  if (!content) throw new Error("DeepSeek API returned an empty completion.");
  return content;
}

/**
 * Stateless tool-capable DeepSeek completion.  Tool declarations and all
 * assistant/tool transcript entries are supplied by the host runtime; model
 * tool arguments are never executed directly by this client.
 */
export async function completeWithDeepSeekTools(
  messages: readonly DeepSeekToolMessage[],
  tools: readonly DeepSeekToolDefinition[],
  options: DeepSeekClientOptions,
  signal?: AbortSignal,
): Promise<DeepSeekToolCompletion> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for DeepSeek requests.");

  const modelConfig = options.modelConfig ?? deepSeekModelConfig;
  const request = options.request ?? globalThis.fetch.bind(globalThis);
  const response = await request(`${modelConfig.apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelConfig.model,
      messages: messages.map(deepSeekToolMessage),
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: "auto",
      thinking: { type: "disabled" },
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    }),
    signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`DeepSeek API error ${response.status}: ${raw}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("DeepSeek API returned invalid JSON.");
  }
  return toolCompletion(data);
}

export function chatCompletionContent(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return null;
  const content = first.message.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function deepSeekToolMessage(message: DeepSeekToolMessage): Record<string, unknown> {
  if (message.role === "tool") {
    if (!message.toolCallId?.trim()) throw new Error("Tool transcript entry requires a toolCallId.");
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls?.length ? {
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: toolCall.arguments },
        })),
      } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

function toolCompletion(value: unknown): DeepSeekToolCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new Error("DeepSeek API returned an invalid tool completion.");
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error("DeepSeek API returned an invalid tool completion.");
  }
  const message = first.message;
  const content = typeof message.content === "string" && message.content.trim()
    ? message.content.trim()
    : undefined;
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map(parseToolCall)
    : [];
  if (!content && toolCalls.length === 0) {
    throw new Error("DeepSeek API returned neither content nor a tool call.");
  }
  return {
    ...(content ? { content } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

function parseToolCall(value: unknown): DeepSeekToolCall {
  if (!isRecord(value) || !isRecord(value.function)) {
    throw new Error("DeepSeek API returned an invalid tool call.");
  }
  const id = value.id;
  const name = value.function.name;
  const argumentsValue = value.function.arguments;
  if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim()) {
    throw new Error("DeepSeek API returned an invalid tool call.");
  }
  if (typeof argumentsValue !== "string") {
    throw new Error("DeepSeek API returned tool arguments that are not JSON text.");
  }
  return { id, name, arguments: argumentsValue };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
