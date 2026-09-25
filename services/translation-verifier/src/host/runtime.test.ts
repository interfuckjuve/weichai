import { describe, expect, it } from "vitest";
import { createAgentHost } from "./runtime.js";
import { createTranslationVerifierModelClient } from "./model-client.js";
import type { AgentCompletion, AgentMessage, AgentModelClient } from "./model.js";
import type { AgentWorkLogEvent } from "./work-log.js";
import type { AgentTraceEvent } from "./trace-log.js";
import type { AgentTask, AgentToolFactory } from "./agent.js";
import type { HostTool, ToolRuntimeContext } from "./tools/common.js";

const subject = {
  sourceFunction: { path: "src/source.py", name: "source_fn" },
  targetFunction: { path: "src/target.py", name: "target_fn" },
  requirement: "Preserve the method behavior.",
};

const taskContext = {
  sourceLanguage: "Python",
  targetLanguage: "Python",
  sourceProjectPath: "/tmp/source",
  targetProjectPath: "/tmp/target",
  sourcePath: "src/source.py",
  targetPath: "src/target.py",
};

const resolveToolContext = async (): Promise<ToolRuntimeContext> => ({
  ...taskContext,
  sourceDirectory: "src",
  targetDirectory: "src",
  testRoots: ["tests/agent"],
  testRunner: "pytest",
  targetTest: { executable: "pytest", args: [] },
});

function task(
  tools: readonly AgentToolFactory[],
  terminalTools: readonly string[] = ["finish"],
): AgentTask {
  return {
    subject,
    taskContext,
    systemPrompt: "system",
    userPrompt: "user",
    tools,
    terminalTools,
  };
}

function tool(
  name: string,
  execute: (input: unknown) => Promise<unknown>,
): AgentToolFactory {
  return () => ({
    name,
    description: name,
    inputSchema: { type: "object" },
    parse: (input: unknown) => input,
    execute,
  } as HostTool<unknown, unknown>);
}

function clientFor(
  completions: readonly AgentCompletion[],
  observed: AgentMessage[][] = [],
) {
  let index = 0;
  return {
    observed,
    complete: async (messages: readonly AgentMessage[]) => {
      observed.push([...messages]);
      const completion = completions[index++];
      if (completion === undefined) throw new Error("No scripted completion.");
      return completion;
    },
  };
}

describe("AgentHost runtime", () => {
  it("executes tool calls and returns a terminal tool result", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          content: "Inspecting the target.",
          toolCalls: [
            { id: "call-1", name: "inspect", arguments: '{"path":"src/target.py"}' },
          ],
        },
        {
          toolCalls: [
            { id: "call-2", name: "finish", arguments: '{"status":"success"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([
        tool("inspect", async (input) => ({ inspected: input })),
        tool("finish", async (input) => ({ ...(input as object), terminal: true })),
      ]),
    );

    expect(result).toEqual({ status: "success", terminal: true });
    expect(observed).toHaveLength(2);
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-1",
      content: '{"inspected":{"path":"src/target.py"}}',
    });
  });

  it("emits bounded work events without recording tool payloads", async () => {
    const events: AgentWorkLogEvent[] = [];
    const client = clientFor([
      {
        content: "private model response",
        toolCalls: [
          { id: "call-inspect", name: "inspect", arguments: '{"path":"src/target.py"}' },
        ],
      },
      {
        toolCalls: [
          { id: "call-finish", name: "finish", arguments: '{"status":"success"}' },
        ],
      },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
      workLogger: (event) => events.push(event),
    });

    await expect(
      host.run(
        task([
          tool("inspect", async () => ({ secret: "private tool output" })),
          tool("finish", async () => ({ secret: "private terminal output" })),
        ]),
      ),
    ).resolves.toEqual({ secret: "private terminal output" });

    expect(events.map((event) => event.event)).toEqual([
      "run.started",
      "turn.started",
      "model.completed",
      "tool.started",
      "tool.completed",
      "turn.started",
      "model.completed",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(events.find((event) => event.event === "tool.started")).toMatchObject({
      toolCallId: "call-inspect",
      toolName: "inspect",
      argumentCharacters: expect.any(Number),
    });
  });

  it("emits detailed trace payloads separately from bounded work events", async () => {
    const events: AgentTraceEvent[] = [];
    const client = clientFor([
      {
        content: "visible model note",
        toolCalls: [
          { id: "call-inspect", name: "inspect", arguments: '{"path":"src/target.py"}' },
        ],
      },
      {
        toolCalls: [
          { id: "call-finish", name: "finish", arguments: '{"status":"success"}' },
        ],
      },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
      traceLogger: (event) => events.push(event),
    });

    await expect(
      host.run(
        task([
          tool("inspect", async () => ({ content: "private tool output" })),
          tool("finish", async () => ({ status: "success" })),
        ]),
      ),
    ).resolves.toEqual({ status: "success" });

    expect(events.map((event) => event.event)).toEqual([
      "run.started",
      "model.request",
      "model.response",
      "tool.started",
      "tool.completed",
      "model.request",
      "model.response",
      "tool.started",
      "tool.completed",
      "run.completed",
    ]);
    expect(JSON.stringify(events)).toContain("visible model note");
    expect(events.find((event) => event.event === "tool.started")).toMatchObject({
      arguments: '{"path":"src/target.py"}',
    });
    expect(events.find((event) => event.event === "tool.completed")).toMatchObject({
      output: { content: "private tool output" },
    });
  });  it("returns tool errors to the Agent and allows it to continue", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          toolCalls: [{ id: "call-1", name: "broken", arguments: "{}" }],
        },
        {
          toolCalls: [
            { id: "call-2", name: "finish", arguments: '{"status":"uncertain"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([
        tool("broken", async () => {
          throw new Error("fixture is unavailable");
        }),
        tool("finish", async (input) => input),
      ]),
    );

    expect(result).toEqual({ status: "uncertain" });
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-1",
      content: '{"error":"fixture is unavailable"}',
    });
  });

  it("returns malformed tool arguments with the same call ID", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          toolCalls: [
            { id: "call-invalid", name: "inspect", arguments: "{invalid" },
          ],
        },
        {
          toolCalls: [
            { id: "call-finish", name: "finish", arguments: '{"status":"uncertain"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([
        tool("inspect", async (input) => input),
        tool("finish", async (input) => input),
      ]),
    );

    expect(result).toEqual({ status: "uncertain" });
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-invalid",
      content: expect.stringContaining("Expected property name"),
    });
  });

  it("returns unknown tools with the same call ID", async () => {
    const observed: AgentMessage[][] = [];
    const client = clientFor(
      [
        {
          toolCalls: [
            { id: "call-unknown", name: "not_available", arguments: "{}" },
          ],
        },
        {
          toolCalls: [
            { id: "call-finish", name: "finish", arguments: '{"status":"uncertain"}' },
          ],
        },
      ],
      observed,
    );
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    const result = await host.run(
      task([tool("finish", async (input) => input)]),
    );

    expect(result).toEqual({ status: "uncertain" });
    expect(observed[1]).toContainEqual({
      role: "tool",
      toolCallId: "call-unknown",
      content: '{"error":"Tool is unavailable: not_available"}',
    });
  });

  it("continues after a prose-only completion", async () => {
    const client = clientFor([
      { content: "I need more evidence." },
      {
        toolCalls: [
          { id: "call-1", name: "finish", arguments: '{"status":"success"}' },
        ],
      },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    await expect(
      host.run(task([tool("finish", async (input) => input)])),
    ).resolves.toEqual({ status: "success" });
  });

  it("does not count provider retries as additional Agent turns", async () => {
    let requestCalls = 0;
    let completionCalls = 0;
    const adapter = createTranslationVerifierModelClient({
      apiKey: "test-key",
      apiBase: "https://model.example.test/v1",
      request: async () => {
        requestCalls += 1;
        if (requestCalls === 1) {
          return new Response("temporary", { status: 503 });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: "call-finish",
                      type: "function",
                      function: {
                        name: "finish",
                        arguments: '{"status":"success"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      },
      requestRetry: { maxAttempts: 2 },
    });
    const modelClient: AgentModelClient = {
      complete(messages, tools, signal) {
        completionCalls += 1;
        return adapter.complete(messages, tools, signal);
      },
    };
    const host = createAgentHost({
      modelClient,
      resolveToolContext,
      limits: { maxTurns: 1 },
    });

    await expect(
      host.run(task([tool("finish", async (input) => input)])),
    ).resolves.toEqual({ status: "success" });
    expect(completionCalls).toBe(1);
    expect(requestCalls).toBe(2);
  });

  it("enforces the turn budget before another model request", async () => {
    let modelCalls = 0;
    const host = createAgentHost({
      modelClient: {
        complete: async () => {
          modelCalls += 1;
          return { content: "still investigating" };
        },
      },
      resolveToolContext,
      limits: { maxTurns: 1 },
    });

    await expect(host.run(task([], []))).rejects.toThrow("1-turn budget");
    expect(modelCalls).toBe(1);
  });

  it("rejects a terminal tool combined with another call", async () => {
    const client = clientFor([
      {
        toolCalls: [
          { id: "call-1", name: "inspect", arguments: "{}" },
          { id: "call-2", name: "finish", arguments: "{}" },
        ],
      },
    ]);
    const host = createAgentHost({
      modelClient: client,
      resolveToolContext,
    });

    await expect(
      host.run(
        task([
          tool("inspect", async () => ({})),
          tool("finish", async () => ({})),
        ]),
      ),
    ).rejects.toThrow("terminal tool must be the only call");
  });
});
