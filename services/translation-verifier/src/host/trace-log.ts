import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AgentTraceEvent = {
  at: string;
  runId: string;
  event: string;
  [key: string]: unknown;
};

export type AgentTraceLogger = (event: AgentTraceEvent) => void;

/** Detailed local debugging trace. Keep this opt-in because it contains payloads. */
export function emitAgentTrace(
  logger: AgentTraceLogger | undefined,
  event: AgentTraceEvent,
): void {
  if (!logger) return;
  try {
    logger(event);
  } catch {
    // A trace sink must never change Agent behavior.
  }
}

/** Write detailed Agent/model/tool payloads as mode 600 JSONL. */
export function createJsonlAgentTraceLogger(
  filePath: string,
  secrets: readonly string[] = [],
): AgentTraceLogger {
  mkdirSync(dirname(filePath), { recursive: true });
  const redact = secrets.filter((secret) => secret.length > 0);
  return (event) => {
    appendFileSync(filePath, `${JSON.stringify(event, (_, value) => {
      if (typeof value !== "string") return value;
      return redact.reduce(
        (current, secret) => current.split(secret).join("[REDACTED]"),
        value,
      );
    })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };
}
