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

async function defaultToolContextResolver(
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
      const budget = createAgentRunBudget(limits);
      emitAgentWorkLog(
        options.workLogger,
        workEvent(runId, "run.started"),
      );
      emitAgentTrace(
        options.traceLogger,
        traceEvent(runId, "run.started"),
      );
      try {
        const context: ToolContext = {
          state: {},
          budget,
          runtime: await resolveToolContext(task.taskContext),
        };
        const tools = bindTools(task, context);
        const result = await runAgentLoop({
          client: options.modelClient,
          task,
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
        budget.dispose();
      }
    },
  };
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
      throw new Error("A terminal tool must be the only call in its turn.");
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
        if (terminalNames.has(call.name)) {
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
          content: serializeToolValue(output),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
