import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AgentWorkLogEventName =
  | "run.started"
  | "turn.started"
  | "model.completed"
  | "model.failed"
  | "agent.continued"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "run.completed"
  | "run.failed";

/**
 * Structured, deliberately bounded Agent work metadata.
 * Prompt/response contents, tool arguments, command output, paths and keys do
 * not belong in this event type; callers should log scalar summaries only.
 */
export type AgentWorkLogEvent = {
  at: string;
  runId: string;
  event: AgentWorkLogEventName;
  turn?: number;
  elapsedMs?: number;
  messageCount?: number;
  contextCharacters?: number;
  toolCount?: number;
  toolNames?: readonly string[];
  toolCallId?: string;
  toolName?: string;
  argumentCharacters?: number;
  outputCharacters?: number;
  toolCallCount?: number;
  status?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  outcome?: string;
  terminal?: boolean;
  errorType?: string;
  errorMessageCharacters?: number;
  turns?: number;
  totalToolCalls?: number;
};

export type AgentWorkLogger = (event: AgentWorkLogEvent) => void;

/** Logging is observability only; a broken sink must not change Agent behavior. */
export function emitAgentWorkLog(
  logger: AgentWorkLogger | undefined,
  event: AgentWorkLogEvent,
): void {
  if (!logger) return;
  try {
    logger(event);
  } catch {
    // A log sink must never become a new Host failure path.
  }
}

/** Write one safe event per line for local E2E inspection. */
export function createJsonlAgentWorkLogger(filePath: string): AgentWorkLogger {
  mkdirSync(dirname(filePath), { recursive: true });
  return (event) => {
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };
}

/** Emit the same structured event shape used by the JSONL logger to stdout. */
export function consoleAgentWorkLogger(event: AgentWorkLogEvent): void {
  console.info("[agent-work]", JSON.stringify(event));
}
