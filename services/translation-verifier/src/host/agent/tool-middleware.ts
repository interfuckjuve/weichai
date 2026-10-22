import { createMiddleware, ToolInvocationError, ToolMessage } from "langchain";
import type { Command } from "@langchain/langgraph";
import { AgentRunFailure, type AgentRunBudget } from "./run-budget.js";
import { boundedValue, valueCharacters } from "./messages.js";
import {
  emitAgentTrace,
  type AgentTraceLogger,
} from "../logging/trace-log.js";
import { emitAgentWorkLog, type AgentWorkLogger } from "../logging/work-log.js";

/** Bound only the opt-in trace input payload; tool results stay complete in the trace. */
const MAX_TRACE_PAYLOAD_CHARS = 24_000;
const MAX_STDOUT_CHARS = 8_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_FAILURE_MESSAGE_CHARS = 2_000;
const MAX_REPORTED_FAILURES = 8;

/**
 * Host tools that touch the target working directory run one at a time, so a
 * batched framework tool call cannot read a half-written test file, rewrite a
 * test while its process runs, or release the harness mid-operation.
 */
const SERIAL_TOOLS = new Set([
  "write_target_test",
  "run_target_tests",
  "run_function_group_tests",
  "read_target_file",
  "list_target_files",
]);

/** Tools whose complete observation must stay available to the Host. */
const OBSERVATION_TOOLS = new Set(["run_target_tests", "run_function_group_tests"]);

export type WorkspaceSerializer = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** One queue per run: serializes shared-directory tools and can close before cleanup. */
export function createWorkspaceSerializer(budget: AgentRunBudget): WorkspaceSerializer {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const enter = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      throw new Error("The Agent run is finishing; workspace operations are closed.");
    }
    budget.assertActive();
    return operation();
  };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const next = tail.then(
        () => enter(operation),
        () => enter(operation),
      );
      tail = next.catch(() => undefined);
      return next;
    },
    async close(): Promise<void> {
      closed = true;
      await tail;
    },
  };
}

export type ToolCallMiddlewareOptions = {
  runId: string;
  serializer: WorkspaceSerializer;
  budget: AgentRunBudget;
  workLogger?: AgentWorkLogger;
  traceLogger?: AgentTraceLogger;
};

/**
 * Cross-cutting Host behavior for every native tool call: one log line per
 * call, serialized shared-directory access, the bounded model-visible
 * observation with the complete result kept as the ToolMessage artifact, and
 * a fatal path for budget/cancellation failures.
 *
 * Recoverable tool errors are re-thrown unchanged so the framework keeps
 * owning tool-error correlation and the self-correction message; structured
 * input is validated by the tool's Zod schema before this hook runs.
 */
export function createToolCallMiddleware(options: ToolCallMiddlewareOptions) {
  const { runId, serializer, budget, workLogger, traceLogger } = options;
  return createMiddleware({
    name: "TranslationVerifierToolCall",
    wrapToolCall: async (request, handler) => {
      const name = request.toolCall.name;
      const toolCallId = request.toolCall.id;
      const startedAt = performance.now();
      emitAgentWorkLog(workLogger, {
        ...event("tool.started"),
        toolName: name,
        ...(toolCallId ? { toolCallId } : {}),
        argumentCharacters: valueCharacters(request.toolCall.args),
      });
      emitAgentTrace(traceLogger, {
        ...event("tool.started"),
        toolName: name,
        ...(toolCallId ? { toolCallId } : {}),
        input: boundedValue(request.toolCall.args, MAX_TRACE_PAYLOAD_CHARS),
      });
      try {
        const run = async (): Promise<ToolMessage | Command> => await handler(request);
        const message = SERIAL_TOOLS.has(name)
          ? await serializer.run(run)
          : await run();
        const parsed = parsedToolResult(message);
        const observation = OBSERVATION_TOOLS.has(name) ? parsed : undefined;
        emitAgentWorkLog(workLogger, {
          ...event("tool.completed"),
          toolName: name,
          ...(toolCallId ? { toolCallId } : {}),
          outputCharacters: valueCharacters(parsed ?? toolContent(message)),
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        emitAgentTrace(traceLogger, {
          ...event("tool.completed"),
          toolName: name,
          ...(toolCallId ? { toolCallId } : {}),
          elapsedMs: Math.round(performance.now() - startedAt),
          // The trace keeps the complete observation; only the model-visible
          // tool message is bounded below.
          output: parsed ?? toolContent(message),
        });
        return modelVisibleMessage(name, message, observation);
      } catch (error) {
        emitAgentWorkLog(workLogger, {
          ...event("tool.failed"),
          toolName: name,
          ...(toolCallId ? { toolCallId } : {}),
          elapsedMs: Math.round(performance.now() - startedAt),
          ...errorFields(error),
        });
        emitAgentTrace(traceLogger, {
          ...event("tool.failed"),
          toolName: name,
          ...(toolCallId ? { toolCallId } : {}),
          elapsedMs: Math.round(performance.now() - startedAt),
          ...errorFields(error),
        });
        if (budget.signal.aborted) throw error;
        // An operational failure must never reach the model as an ordinary
        // tool result it could treat as verification evidence: a fresh
        // instance is not the framework's unwrappable tool error.
        if (error instanceof AgentRunFailure) {
          throw new AgentRunFailure(error.reason, error.message, { cause: error });
        }
        // Structured input errors stay with the framework: it unwraps its own
        // tool-invocation error into a self-correction message.
        if (ToolInvocationError.isInstance(error)) throw error;
        // Any other tool failure is a recoverable domain refusal (a path
        // outside the authorization, a missing file). The framework owns the
        // tool-message correlation, so answer on the same tool call.
        return new ToolMessage({
          content: `${errorMessage(error)}\n Please fix your mistakes.`,
          tool_call_id: toolCallId ?? "",
          name,
          status: "error",
        });
      }
    },
  });

  function event(name: "tool.started" | "tool.completed" | "tool.failed") {
    return { at: new Date().toISOString(), runId, event: name };
  }
}

/** The Host-owned result a tool returned, when it is a JSON object. */
function parsedToolResult(message: ToolMessage | Command): Record<string, unknown> | undefined {
  if (!ToolMessage.isInstance(message)) return undefined;
  if (typeof message.content !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(message.content);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function toolContent(message: ToolMessage | Command): unknown {
  return ToolMessage.isInstance(message) ? message.content : message;
}

/**
 * Bound the diagnostics the model sees for one test-run result while keeping
 * the Host-owned facts (status, tests, coverage, functions, report paths)
 * intact. Compiler dumps and reflection probes must not exhaust the context in
 * one tool call, so head and tail are kept with an explicit retention marker.
 * The full observation stays in the ToolMessage artifact and the trace.
 */
function modelVisibleMessage(
  name: string,
  message: ToolMessage | Command,
  observation: Record<string, unknown> | undefined,
): ToolMessage | Command {
  if (observation === undefined || !ToolMessage.isInstance(message)) return message;
  const bounded = boundedObservation(observation);
  return new ToolMessage({
    content: JSON.stringify(bounded),
    tool_call_id: message.tool_call_id,
    name: message.name ?? name,
    artifact: observation,
    status: message.status,
    ...(message.id === undefined ? {} : { id: message.id }),
  });
}

function boundedObservation(output: Record<string, unknown>): Record<string, unknown> {
  const bounded = (text: unknown, limit: number): unknown => {
    if (typeof text !== "string" || text.length <= limit) return text;
    const half = Math.floor(limit / 2);
    return `${text.slice(0, half)}\n[Host retained ${text.length - limit} additional diagnostic characters]\n${text.slice(-half)}`;
  };
  return {
    ...output,
    ...(typeof output.stdout === "string" ? { stdout: bounded(output.stdout, MAX_STDOUT_CHARS) } : {}),
    ...(typeof output.stderr === "string" ? { stderr: bounded(output.stderr, MAX_STDERR_CHARS) } : {}),
    ...(Array.isArray(output.failures) ? {
      failures: output.failures.slice(0, MAX_REPORTED_FAILURES).map(failure =>
        typeof failure === "object" && failure !== null
          ? { ...failure, message: bounded((failure as { message?: unknown }).message, MAX_FAILURE_MESSAGE_CHARS) }
          : failure),
      ...(output.failures.length > MAX_REPORTED_FAILURES
        ? { omittedFailureCount: output.failures.length - MAX_REPORTED_FAILURES }
        : {}),
    } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFields(error: unknown): Record<string, unknown> {
  return {
    error: errorMessage(error),
    errorType: error instanceof Error ? error.name : typeof error,
  };
}
