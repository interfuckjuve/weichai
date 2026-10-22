import { bindFunctionGroupTestRunner, bindTestRunner } from "./test-runner.js";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  createAgentRunBudget,
  DEFAULT_AGENT_RUN_LIMITS,
  type AgentHost,
  type AgentRunLimits,
  type AgentTask,
} from "./agent.js";
import type {
  AgentCompletion,
  AgentMessage,
  AgentModelClient,
  AgentToolCall,
  AgentToolDefinition,
} from "./model.js";
import type {
  AgentTaskContext,
  ToolRuntimeContext,
  HostTool,
  ToolContext,
  ToolState,
} from "./tools/common.js";
import { resolveTestEnvironment } from "./test-environment.js";
import {
  emitAgentWorkLog,
  type AgentWorkLogEvent,
  type AgentWorkLogger,
} from "./work-log.js";
import {
  emitAgentTrace,
  type AgentTraceEvent,
  type AgentTraceLogger,
} from "./trace-log.js";

export type AgentHostOptions<Result = unknown> = {
  modelClient: AgentModelClient;
  signal?: AbortSignal;
  limits?: Partial<AgentRunLimits>;
  continuePrompt?: string;
  resolveToolContext?: ToolContextResolver;
  workLogger?: AgentWorkLogger;
  traceLogger?: AgentTraceLogger;
};

export type ToolContextResolver = (
  taskContext: AgentTaskContext,
) => Promise<ToolRuntimeContext>;

const DEFAULT_CONTINUE_PROMPT =
  "Continue the verification using the available tools, or finish/report uncertainty when appropriate.";

export async function defaultToolContextResolver(
  taskContext: AgentTaskContext,
): Promise<ToolRuntimeContext> {
  const testEnvironment = await resolveTestEnvironment(taskContext);
  return {
    ...taskContext,
    sourceDirectory: directoryForFile(taskContext.sourcePath),
    targetDirectory: directoryForFile(taskContext.targetPath),
    testRoots: testEnvironment.testRoots,
    testRunner: testEnvironment.framework,
    targetTest: testEnvironment.targetTest,
    cleanup: testEnvironment.cleanup,
  };
}

function directoryForFile(path: string): string {
  const directory = dirname(path.replaceAll("\\", "/"));
  return directory === "" ? "." : directory;
}

/** Create the provider-neutral Host runtime for strategy-created Agent tasks. */
export function createAgentHost<Result = unknown>(
  options: AgentHostOptions<Result>,
): AgentHost<Result> {
  const continuePrompt = options.continuePrompt ?? DEFAULT_CONTINUE_PROMPT;
  const resolveToolContext =
    options.resolveToolContext ?? defaultToolContextResolver;
  const limits: AgentRunLimits = { ...DEFAULT_AGENT_RUN_LIMITS, ...options.limits };

  return {
    async run(task) {
      const runId = randomUUID();
      const startedAt = performance.now();
      const budget = createAgentRunBudget(limits, Date.now(), options.signal);
      emitAgentWorkLog(
        options.workLogger,
        workEvent(runId, "run.started"),
      );
      emitAgentTrace(
        options.traceLogger,
        traceEvent(runId, "run.started"),
      );
      let cleanup: (() => Promise<void>) | undefined;
      const state: ToolState = {};
      try {
        budget.assertActive();
        const resolvedContext = {
          state,
          budget,
          runtime: await resolveToolContext(task.taskContext),
        };
        cleanup = resolvedContext.runtime.cleanup;
        budget.assertActive();
        const context: ToolContext = {
          ...resolvedContext,
          runner: bindTestRunner(resolvedContext),
          ...(task.functionGroup
            ? { functionGroupRunner: bindFunctionGroupTestRunner(resolvedContext) }
            : {}),
        };
        const tools = bindTools(task, context);
        const result = await runAgentLoop({
          client: options.modelClient,
          task: withRuntimeTestInstructions(task, resolvedContext.runtime, limits),
          tools,
          budget,
          limits,
          continuePrompt,
          runId,
          workLogger: options.workLogger,
          traceLogger: options.traceLogger,
        }) as Result;
        emitAgentWorkLog(
          options.workLogger,
          workEvent(runId, "run.completed", {
            elapsedMs: elapsedMs(startedAt),
            turns: budget.turns,
            totalToolCalls: budget.toolCalls,
          }),
        );
        emitAgentTrace(
          options.traceLogger,
          traceEvent(runId, "run.completed", {
            elapsedMs: elapsedMs(startedAt),
            turns: budget.turns,
            totalToolCalls: budget.toolCalls,
          }),
        );
        return result;
      } catch (error) {
        emitAgentWorkLog(
          options.workLogger,
          workEvent(runId, "run.failed", {
            elapsedMs: elapsedMs(startedAt),
            turns: budget.turns,
            totalToolCalls: budget.toolCalls,
            ...errorFields(error),
          }),
        );
        emitAgentTrace(
          options.traceLogger,
          traceEvent(runId, "run.failed", {
            elapsedMs: elapsedMs(startedAt),
            turns: budget.turns,
            totalToolCalls: budget.toolCalls,
            ...errorFields(error),
          }),
        );
        throw error;
      } finally {
        try {
          await cleanup?.();
        } finally {
          budget.dispose();
        }
      }
    },
  };
}

/**
 * The test root can be Host-created (for example the disposable C# harness),
 * so it is not available when a strategy builds its task.  Put the exact
 * project-relative roots into the user message after the Host has resolved
 * them.  This prevents the model from guessing `tests/` and repeatedly
 * submitting paths rejected by the allowlist.
 */
function withRuntimeTestInstructions(
  task: AgentTask,
  runtime: ToolRuntimeContext,
  limits: AgentRunLimits,
): AgentTask {
  const roots = runtime.testRoots.join(", ");
  const instruction = [
    "Host test setup (authoritative):",
    `- Test framework: ${runtime.testRunner}`,
    `- Authorized test roots: ${roots}`,
    "- Every test path passed to write_target_test, run_target_tests, and run_function_group_tests must start with one of those exact roots.",
    "- Test writes and test execution are limited to the dedicated folder above, not its parent test directory. You may edit and run any existing test in that folder, including tests from earlier runs; no creation or modification in the current run is required.",
    "- Start by inspecting and running ALL existing tests in the dedicated folder with the run tool's path/paths omitted. Establish a passing baseline with no skipped tests before adding new tests when possible. If the folder has no tests, write tests next.",
    "- Diagnose failed baseline tests. Repair stale tests only when changed source APIs or declared contracts explain the failure. Correct imports, signatures and fixtures as needed, but never weaken a valid requirement assertion just to match current implementation behavior. Retain actual production failures and report them.",
    "- Then write or update meaningful tests for EVERY upstream target function. Run changed tests immediately, inspect reportPaths with read_target_file when needed, and use Host diagnostics to repair test-authoring mistakes.",
    "- When ready, call finish or finish_function_group for the final complete-suite run. Every test must compile and execute without skips. Assertions that expose a real requirement bug may fail and must be preserved in a failure report; success requires the entire current suite to pass and every upstream target to execute.",
    "- finish and finish_function_group always rerun the complete dedicated suite once and record current function coverage. If completion checks are unmet, they return outcome='continue', feedback and the current test result. Read the diagnostics, debug or extend tests, and try again; this feedback keeps the Agent running.",
    `- Run budget: ${limits.maxTurns} model turns and ${limits.maxToolCalls} tool calls, with up to ${limits.maxToolCallsPerTurn} tool calls per turn.`,
    "- Batch independent source reads in one turn. Use at most the first third of model turns for initial inspection and reserve the remaining turns for writing, running, correcting tests, and finishing.",
    "- Discover sibling dependency files with list_target_files using directory '.'; use the returned project-relative paths rather than guessing file names.",
    "- Use the exact types and public signatures from the files you read; do not guess dependency names or dump the whole assembly through reflection probes. If a signature is unclear, read only its declaring file.",
    "- The current complete-suite result determines acceptance. Preserve valid requirement failures and report actual production bugs. No historical failure ledger, test snapshots, correction metadata or review model is used.",
  ].join("\n");
  return { ...task, userPrompt: `${task.userPrompt}\n\n${instruction}` };
}

type BoundTool = HostTool<any, any>;

type AgentLoopInput = {
  client: AgentModelClient;
  task: AgentTask;
  tools: readonly BoundTool[];
  budget: ReturnType<typeof createAgentRunBudget>;
  limits: AgentRunLimits;
  continuePrompt: string;
  runId: string;
  workLogger?: AgentWorkLogger;
  traceLogger?: AgentTraceLogger;
};

function bindTools(task: AgentTask, context: ToolContext): readonly BoundTool[] {
  const tools = task.tools.map((factory) => factory(context));
  const names = tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    throw new Error("Agent task contains duplicate tool names.");
  }
  const terminalNames = new Set(task.terminalTools);
  if (terminalNames.size !== task.terminalTools.length) {
    throw new Error("Agent task contains duplicate terminal tool names.");
  }
  for (const name of terminalNames) {
    if (!names.includes(name)) {
      throw new Error(`Terminal tool is not available: ${name}`);
    }
  }
  return tools;
}

export async function runAgentLoop({
  client,
  task,
  tools,
  budget,
  limits,
  continuePrompt,
  runId,
  workLogger,
  traceLogger,
}: AgentLoopInput): Promise<unknown> {
  const messages: AgentMessage[] = [
    { role: "system", content: task.systemPrompt },
    { role: "user", content: task.userPrompt },
  ];
  const definitions = tools.map(toDefinition);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const terminalNames = new Set(task.terminalTools);

  while (true) {
    budget.assertActive();
    budget.startTurn(0);
    assertMessageSize(messages, limits.maxContextCharacters);
    const turn = budget.turns;
    emitAgentWorkLog(
      workLogger,
      workEvent(runId, "turn.started", {
        turn,
        messageCount: messages.length,
        contextCharacters: messageCharacters(messages),
        toolCount: definitions.length,
        toolNames: definitions.map((definition) => definition.name),
      }),
    );

    emitAgentTrace(
      traceLogger,
      traceEvent(runId, "model.request", {
        turn,
        messages,
        tools: definitions,
      }),
    );
    const modelStartedAt = performance.now();
    let completion: AgentCompletion;
    try {
      completion = await client.complete(messages, definitions, budget.signal);
      budget.assertActive();
      validateCompletion(completion, limits.maxResponseCharacters);
    } catch (error) {
      emitAgentWorkLog(
        workLogger,
        workEvent(runId, "model.failed", {
          turn,
          elapsedMs: elapsedMs(modelStartedAt),
          ...errorFields(error),
        }),
      );
      emitAgentTrace(
        traceLogger,
        traceEvent(runId, "model.failed", {
          turn,
          elapsedMs: elapsedMs(modelStartedAt),
          error: errorMessage(error),
        }),
      );
      throw error;
    }
    const calls = completion.toolCalls ?? [];
    emitAgentWorkLog(
      workLogger,
      workEvent(runId, "model.completed", {
        turn,
        elapsedMs: elapsedMs(modelStartedAt),
        outputCharacters: serializedCharacters(completion),
        toolCallCount: calls.length,
        toolNames: calls.map((call) => call.name),
      }),
    );

    emitAgentTrace(
      traceLogger,
      traceEvent(runId, "model.response", {
        turn,
        elapsedMs: elapsedMs(modelStartedAt),
        completion,
      }),
    );

    budget.addToolCalls(calls.length);
    messages.push({
      role: "assistant",
      content: completion.content ?? "",
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    });

    if (calls.length === 0) {
      messages.push({ role: "user", content: continuePrompt });
      emitAgentWorkLog(
        workLogger,
        workEvent(runId, "agent.continued", {
          turn,
          status: "no-tool-call",
        }),
      );
      emitAgentTrace(
        traceLogger,
        traceEvent(runId, "agent.continued", {
          turn,
          prompt: continuePrompt,
        }),
      );
      continue;
    }
    if (calls.some((call) => terminalNames.has(call.name)) && calls.length !== 1) {
      // Do not execute any part of a mixed terminal turn.  Returning a tool
      // error for every call keeps the provider transcript valid and lets the
      // model resubmit the terminal action alone on the next turn.  The
      // terminal-only rule remains enforced; this is a recoverable protocol
      // mistake rather than a verifier run failure.
      const message = "A terminal tool must be the only call in its turn. Resubmit only finish_function_group or report_uncertain; no tool from this turn was executed.";
      for (const call of calls) {
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ error: message }) });
      }
      emitAgentWorkLog(workLogger, workEvent(runId, "agent.continued", {
        turn,
        status: "mixed-terminal-call",
        toolNames: calls.map((call) => call.name),
      }));
      emitAgentTrace(traceLogger, traceEvent(runId, "agent.continued", {
        turn,
        prompt: message,
      }));
      continue;
    }

    for (const call of calls) {
      budget.assertActive();
      emitAgentWorkLog(
        workLogger,
        workEvent(runId, "tool.started", {
          turn,
          toolCallId: call.id,
          toolName: call.name,
          argumentCharacters: call.arguments.length,
        }),
      );
      emitAgentTrace(
        traceLogger,
        traceEvent(runId, "tool.started", {
          turn,
          toolCallId: call.id,
          toolName: call.name,
          arguments: call.arguments,
        }),
      );
      const toolStartedAt = performance.now();
      const tool = toolsByName.get(call.name);
      try {
        if (tool === undefined) {
          throw new Error(`Tool is unavailable: ${call.name}`);
        }
        const parsed = tool.parse(JSON.parse(call.arguments));
        const output = await tool.execute(parsed);
        budget.assertActive();
        const outputFields = toolOutputFields(output);
        if (terminalNames.has(call.name) && (tool.isTerminal?.(output) ?? true)) {
          emitAgentWorkLog(
            workLogger,
            workEvent(runId, "tool.completed", {
              turn,
              toolCallId: call.id,
              toolName: call.name,
              elapsedMs: elapsedMs(toolStartedAt),
              terminal: true,
              ...outputFields,
            }),
          );
          emitAgentTrace(
            traceLogger,
            traceEvent(runId, "tool.completed", {
              turn,
              toolCallId: call.id,
              toolName: call.name,
              elapsedMs: elapsedMs(toolStartedAt),
              terminal: true,
              output,
            }),
          );
          return output;
        }
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: serializeToolValue(modelVisibleToolOutput(call.name, output)),
        });
        emitAgentWorkLog(
          workLogger,
          workEvent(runId, "tool.completed", {
            turn,
            toolCallId: call.id,
            toolName: call.name,
            elapsedMs: elapsedMs(toolStartedAt),
            terminal: false,
            ...outputFields,
          }),
        );
        emitAgentTrace(
          traceLogger,
          traceEvent(runId, "tool.completed", {
            turn,
            toolCallId: call.id,
            toolName: call.name,
            elapsedMs: elapsedMs(toolStartedAt),
            terminal: false,
            output,
          }),
        );
      } catch (error) {
        budget.assertActive();
        messages.push({
          role: "tool",
          toolCallId: call.id,
          content: JSON.stringify({ error: errorMessage(error) }),
        });
        emitAgentWorkLog(
          workLogger,
          workEvent(runId, "tool.failed", {
            turn,
            toolCallId: call.id,
            toolName: call.name,
            elapsedMs: elapsedMs(toolStartedAt),
            ...errorFields(error),
          }),
        );
        emitAgentTrace(
          traceLogger,
          traceEvent(runId, "tool.failed", {
            turn,
            toolCallId: call.id,
            toolName: call.name,
            elapsedMs: elapsedMs(toolStartedAt),
            arguments: call.arguments,
            error: errorMessage(error),
          }),
        );
      }
      assertMessageSize(messages, limits.maxContextCharacters);
    }
  }
}

function toDefinition(tool: BoundTool): AgentToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function validateCompletion(
  completion: AgentCompletion,
  maxResponseCharacters: number,
): asserts completion is AgentCompletion {
  if (typeof completion !== "object" || completion === null) {
    throw new Error("Model returned an invalid completion.");
  }
  if (completion.content !== undefined && typeof completion.content !== "string") {
    throw new Error("Model completion content must be a string.");
  }
  if (completion.toolCalls !== undefined && !Array.isArray(completion.toolCalls)) {
    throw new Error("Model completion toolCalls must be an array.");
  }
  const serialized = JSON.stringify(completion) ?? "";
  if (serialized.length > maxResponseCharacters) {
    throw new Error("Model response exceeds the configured response budget.");
  }
  const calls = completion.toolCalls ?? [];
  const ids = new Set<string>();
  for (const call of calls) {
    validateToolCall(call);
    if (ids.has(call.id)) throw new Error("Duplicate tool call IDs.");
    ids.add(call.id);
  }
}

function validateToolCall(call: AgentToolCall): void {
  if (
    typeof call !== "object" ||
    call === null ||
    typeof call.id !== "string" ||
    !call.id ||
    typeof call.name !== "string" ||
    !call.name ||
    typeof call.arguments !== "string"
  ) {
    throw new Error("Model returned an invalid tool call.");
  }
}

function assertMessageSize(
  messages: readonly AgentMessage[],
  maxCharacters: number,
): void {
  const serialized = JSON.stringify(messages);
  if (serialized.length > maxCharacters) {
    throw new Error("Agent context exceeds the configured context budget.");
  }
}

function workEvent(
  runId: string,
  event: AgentWorkLogEvent["event"],
  fields: Omit<AgentWorkLogEvent, "at" | "runId" | "event"> = {},
): AgentWorkLogEvent {
  return {
    at: new Date().toISOString(),
    runId,
    event,
    ...fields,
  };
}

function traceEvent(
  runId: string,
  event: string,
  fields: Record<string, unknown> = {},
): AgentTraceEvent {
  return {
    at: new Date().toISOString(),
    runId,
    event,
    ...fields,
  };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function messageCharacters(messages: readonly AgentMessage[]): number {
  return JSON.stringify(messages).length;
}

function serializedCharacters(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function errorFields(
  error: unknown,
): Pick<AgentWorkLogEvent, "errorType" | "errorMessageCharacters"> {
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    errorMessageCharacters: error instanceof Error ? error.message.length : String(error).length,
  };
}

function toolOutputFields(
  value: unknown,
): Pick<
  AgentWorkLogEvent,
  "outputCharacters" | "status" | "exitCode" | "timedOut" | "outcome"
> {
  const fields: Pick<
    AgentWorkLogEvent,
    "outputCharacters" | "status" | "exitCode" | "timedOut" | "outcome"
  > = { outputCharacters: serializedCharacters(value) };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fields;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.status === "string") fields.status = record.status;
  if (typeof record.exitCode === "number" || record.exitCode === null) {
    fields.exitCode = record.exitCode;
  }
  if (typeof record.timedOut === "boolean") fields.timedOut = record.timedOut;
  if (typeof record.outcome === "string") fields.outcome = record.outcome;
  return fields;
}

function serializeToolValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Tool returned a non-serializable value.");
  return serialized;
}

function modelVisibleToolOutput(name: string, value: unknown): unknown {
  if (!["run_target_tests", "run_function_group_tests", "write_target_test", "finish", "finish_function_group"].includes(name) ||
      typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const output = value as Record<string, unknown>;
  const bounded = (text: unknown, limit: number): unknown => {
    if (typeof text !== "string" || text.length <= limit) return text;
    const half = Math.floor(limit / 2);
    return `${text.slice(0, half)}\n[Host retained ${text.length - limit} additional diagnostic characters]\n${text.slice(-half)}`;
  };
  // Reflection probes and compiler dumps can fill the context in one call.
  // Keep facts and coverage intact; only bound the model-visible diagnostics.
  // The Host state and trace retain the original complete observation.
  return {
    ...output,
    ...(output.targetTest ? { targetTest: modelVisibleToolOutput("run_target_tests", output.targetTest) } : {}),
    ...(output.functionGroupTest ? { functionGroupTest: modelVisibleToolOutput("run_function_group_tests", output.functionGroupTest) } : {}),
    ...(typeof output.stdout === "string" ? { stdout: bounded(output.stdout, 8_000) } : {}),
    ...(typeof output.stderr === "string" ? { stderr: bounded(output.stderr, 4_000) } : {}),
    ...(Array.isArray(output.failures) ? {
      failures: output.failures.slice(0, 8).map(failure => typeof failure === "object" && failure !== null
        ? { ...failure, message: bounded(failure.message, 2_000) } : failure),
      ...(output.failures.length > 8 ? { omittedFailureCount: output.failures.length - 8 } : {}),
    } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
