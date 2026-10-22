import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createVerifier } from "./verify.js";
import { createLangChainAgentHost } from "./host/langchain-runtime.js";
import { AgentRunFailure } from "./host/agent.js";
import type { AgentWorkLogEvent } from "./host/work-log.js";
import type { AgentTraceEvent } from "./host/trace-log.js";
import type { ToolRuntimeContext } from "./host/tools/common.js";
import type { VerificationInput } from "./types.js";

type ScriptedResponse = (messages: readonly BaseMessage[]) => AIMessage | Promise<AIMessage>;

/** Controllable framework model: real LangChain execution, scripted replies. */
class ScriptedChatModel extends BaseChatModel {
  readonly observations: BaseMessage[][] = [];
  private index = 0;

  constructor(private readonly script: ScriptedResponse[]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(_tools: StructuredToolInterface[]): this {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.observations.push([...messages]);
    const next = this.script[this.index++];
    if (next === undefined) throw new Error("Scripted model ran out of responses.");
    const message = await next(messages);
    return {
      generations: [{
        text: typeof message.content === "string" ? message.content : "",
        message,
      }],
    };
  }
}

const modelRoots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(modelRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const TEST_PATH = "tests/agent/BehaviorTest.java";
const TARGET_PATH = "src/Target.java";

const RUNNER_SCRIPT = `const fs = require('node:fs');
const content = fs.existsSync(${JSON.stringify(TEST_PATH)})
  ? fs.readFileSync(${JSON.stringify(TEST_PATH)}, 'utf8') : '';
fs.rmSync('target', { recursive: true, force: true });
fs.mkdirSync('target/surefire-reports', { recursive: true });
fs.mkdirSync('target/site/jacoco', { recursive: true });
const surefire = 'target/surefire-reports/TEST-BehaviorTest.xml';
const jacoco = 'target/site/jacoco/jacoco.xml';
const coverage = '<report><package name=""><class name="Target" sourcefilename="Target.java"><method name="targetFn" desc="()I"><counter type="METHOD" missed="0" covered="1"/></method></class></package></report>';
if (content.includes('BROKEN')) {
  fs.writeFileSync(surefire, '<testsuite name="BehaviorTest" tests="1" failures="0" errors="1" skipped="0"><testcase classname="BehaviorTest" name="compile"><error message="cannot find symbol"/></testcase></testsuite>');
} else if (content.includes('FAILING')) {
  fs.writeFileSync(surefire, '<testsuite name="BehaviorTest" tests="1" failures="1" errors="0" skipped="0"><testcase classname="BehaviorTest" name="requirement"><failure message="expected rejection">trace</failure></testcase></testsuite>');
  fs.writeFileSync(jacoco, coverage);
  process.exitCode = 1;
} else {
  fs.writeFileSync(surefire, '<testsuite name="BehaviorTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="BehaviorTest" name="requirement"/></testsuite>');
  fs.writeFileSync(jacoco, coverage);
}
`;

const SLOW_RUNNER_SCRIPT = `const fs = require('node:fs');
fs.writeFileSync('runner-started.txt', '1');
setTimeout(() => fs.writeFileSync('runner-finished.txt', '1'), 5000);
`;

type Fixture = {
  root: string;
  input: VerificationInput;
  resolveToolContext: () => Promise<ToolRuntimeContext>;
  cleanupCalls: number;
};

async function createFixture(testContent?: string, runnerScript = RUNNER_SCRIPT): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "verifier-langchain-lifecycle-"));
  modelRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests/agent"), { recursive: true });
  await writeFile(join(root, "src/Source.java"), "class Source { int sourceFn() { return 1; } }");
  await writeFile(join(root, TARGET_PATH), "class Target { int targetFn() { return 1; } }");
  if (testContent !== undefined) await writeFile(join(root, TEST_PATH), testContent);
  await writeFile(join(root, "fake-runner.cjs"), runnerScript);
  const input: VerificationInput = {
    schemaVersion: "2.0",
    sourceLanguage: "Java",
    targetLanguage: "Java",
    sourceProjectPath: root,
    targetProjectPath: root,
    subject: {
      sourceFunction: { path: "src/Source.java", name: "sourceFn" },
      targetFunction: { path: TARGET_PATH, name: "targetFn" },
      requirement: "Preserve the targetFn behavior.",
    },
    analysisReport: {
      schemaVersion: "1.0",
      applicability: { level: "reference", confidence: 1, reasons: [] },
      behaviorMapping: [],
      contractMapping: [],
      dependencyPlan: [],
      implementationPlan: [],
      risks: [],
      assumptions: [],
      unresolved: [],
    },
    migrationPlan: {},
    translation: { round: 0, files: [] },
  };
  const fixture: Fixture = {
    root,
    input,
    cleanupCalls: 0,
    resolveToolContext: async () => ({
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      sourceProjectPath: root,
      targetProjectPath: root,
      sourcePath: input.subject.sourceFunction.path,
      targetPath: input.subject.targetFunction.path,
      targetFunction: input.subject.targetFunction,
      sourceDirectory: "src",
      targetDirectory: "src",
      testRoots: ["tests/agent"],
      testRunner: "maven",
      targetTest: { executable: process.execPath, args: ["fake-runner.cjs"], timeoutMs: 10_000 },
      async cleanup() { fixture.cleanupCalls += 1; },
    }),
  };
  return fixture;
}

function report(
  verdict: "no-bug" | "bug-found" | "uncertain",
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    verdict,
    summary: "The target behavior was checked against the requirement.",
    ...extra,
  });
}

function toolCall(name: string, args: Record<string, unknown>, id: string): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id, type: "tool_call" }],
  });
}

function toolCalls(
  calls: Array<{ name: string; args: Record<string, unknown>; id: string }>,
): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: calls.map(call => ({ ...call, type: "tool_call" as const })),
  });
}

function finalReport(content: string): AIMessage {
  return new AIMessage({ content });
}

function verifier(fixture: Fixture, model: ScriptedChatModel, extra: {
  signal?: AbortSignal;
  limits?: {
    maxTurns?: number;
    maxToolCalls?: number;
    maxToolCallsPerTurn?: number;
    maxDurationMs?: number;
    maxContextCharacters?: number;
    maxResponseCharacters?: number;
  };
  events?: AgentWorkLogEvent[];
  trace?: AgentTraceEvent[];
  onEvent?: (event: AgentWorkLogEvent) => void;
} = {}) {
  return createVerifier(createLangChainAgentHost({
    model,
    resolveToolContext: fixture.resolveToolContext,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.limits ? { limits: extra.limits } : {}),
    ...(extra.trace ? { traceLogger: (event: AgentTraceEvent) => extra.trace!.push(event) } : {}),
    ...(extra.events || extra.onEvent
      ? {
          workLogger: (event: AgentWorkLogEvent) => {
            extra.events?.push(event);
            extra.onEvent?.(event);
          },
        }
      : {}),
  }));
}

const passingTest = "class BehaviorTest { int requirement() { return 1; } }";
const failingTest = "class BehaviorTest { int requirement() { /* FAILING */ } }";

describe("LangChain run budgets", () => {
  it("keeps the model-call budget across feedback rounds instead of resetting it", async () => {
    const fixture = await createFixture(failingTest);
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
      () => finalReport(report("no-bug")),
      () => finalReport(report("no-bug")),
    ]);
    const events: AgentWorkLogEvent[] = [];

    const failure = await verifier(fixture, model, { limits: { maxTurns: 2 }, events })(
      fixture.input, "single-agent", "verify",
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentRunFailure);
    expect(failure).toMatchObject({ reason: "budget" });
    expect((failure as Error).message).toMatch(/budget exhausted/i);
    expect(model.observations).toHaveLength(2);
    expect(events.filter(event => event.event === "host.revalidation.completed")).toHaveLength(2);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("keeps the tool-call budget across feedback rounds", async () => {
    const fixture = await createFixture(failingTest);
    const model = new ScriptedChatModel([
      () => toolCall("run_target_tests", {}, "run-1"),
      () => finalReport(report("no-bug")),
      () => toolCall("run_target_tests", {}, "run-2"),
    ]);
    const events: AgentWorkLogEvent[] = [];

    const failure = await verifier(fixture, model, {
      limits: { maxTurns: 6, maxToolCalls: 1, maxToolCallsPerTurn: 1 },
      events,
    })(fixture.input, "single-agent", "verify").catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "budget" });
    expect(events.filter(event => event.event === "tool.completed")).toHaveLength(1);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("rejects a response that exceeds the response size limit without revalidating", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([() => finalReport(report("no-bug", { summary: "x".repeat(400) }))]);
    const events: AgentWorkLogEvent[] = [];

    const failure = await verifier(fixture, model, {
      limits: { maxResponseCharacters: 100 },
      events,
    })(fixture.input, "single-agent", "verify").catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "context" });
    expect((failure as Error).message).toMatch(/response budget exhausted/i);
    expect(events.some(event => event.event === "host.revalidation.completed")).toBe(false);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("rejects a prompt that exceeds the context size limit before any model call", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([() => finalReport(report("no-bug"))]);

    const failure = await verifier(fixture, model, {
      limits: { maxContextCharacters: 100 },
    })(fixture.input, "single-agent", "verify").catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "context" });
    expect(model.observations).toHaveLength(0);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("rejects a batched model response above the per-turn tool-call limit before executing tools", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([
      () => toolCalls([
        { name: "read_target_file", args: { path: TARGET_PATH }, id: "read-1" },
        { name: "read_target_file", args: { path: TARGET_PATH }, id: "read-2" },
        { name: "read_target_file", args: { path: TARGET_PATH }, id: "read-3" },
      ]),
    ]);
    const events: AgentWorkLogEvent[] = [];

    const failure = await verifier(fixture, model, {
      limits: { maxTurns: 4, maxToolCalls: 10, maxToolCallsPerTurn: 2 },
      events,
    })(fixture.input, "single-agent", "verify").catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "budget" });
    expect(events.some(event => event.event === "tool.started")).toBe(false);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("classifies a model transport failure as a model run failure, not a defect", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([
      () => { throw new Error("model completion request failed"); },
    ]);

    const failure = await verifier(fixture, model)(fixture.input, "single-agent", "verify")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "model" });
    expect((failure as Error).message).toMatch(/model failure/i);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("rejects rather than reporting a production defect when feedback rounds run out", async () => {
    const fixture = await createFixture(failingTest);
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
      () => finalReport(report("no-bug")),
      () => finalReport(report("no-bug")),
      () => finalReport(report("no-bug")),
      () => finalReport(report("no-bug")),
    ]);

    const failure = await verifier(fixture, model)(fixture.input, "single-agent", "verify")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ reason: "budget" });
    expect((failure as Error).message).toMatch(/budget exhausted/i);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("cleans the harness once for an accepted uncertain report", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([
      () => finalReport(report("uncertain", {
        issue: {
          kind: "unknown",
          description: "The requirement does not define the rounding mode for negative values.",
        },
      })),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("failure");
    expect(result.issue?.kind).toBe("unknown");
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("stops the whole run when its time budget expires", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([
      async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return finalReport(report("no-bug"));
      },
    ]);

    const failure = await verifier(fixture, model, { limits: { maxDurationMs: 80 } })(
      fixture.input, "single-agent", "verify",
    ).catch((error: unknown) => error);

    expect((failure as Error).message).toMatch(/time budget/i);
    expect(fixture.cleanupCalls).toBe(1);
  });
});

describe("LangChain model-visible tool diagnostics", () => {
  it("bounds model-visible diagnostics while the trace keeps the complete observation", async () => {
    const fixture = await createFixture(
      passingTest,
      `${RUNNER_SCRIPT}\nprocess.stdout.write('BEGIN ' + 'x'.repeat(50_000) + ' END');\n`,
    );
    const trace: AgentTraceEvent[] = [];
    const model = new ScriptedChatModel([
      () => toolCall("run_target_tests", {}, "run-1"),
      () => finalReport(report("no-bug")),
    ]);

    const result = await verifier(fixture, model, {
      limits: { maxContextCharacters: 40_000 },
      trace,
    })(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("success");
    const toolMessage = model.observations[1]!.find(
      (message): message is ToolMessage => message instanceof ToolMessage,
    );
    expect(toolMessage).toBeDefined();
    const visible = JSON.parse(String(toolMessage!.content)) as {
      stdout: string;
      tests: unknown;
      reportPaths: string[];
    };
    // Head and tail stay visible so the Agent can keep debugging; the raw
    // 50k dump never reaches the model and cannot exhaust the context.
    expect(visible.stdout).toContain("BEGIN");
    expect(visible.stdout).toContain("END");
    expect(JSON.stringify(visible).length).toBeLessThan(20_000);
    expect(String(toolMessage!.content)).toContain("additional diagnostic characters");
    expect(visible.tests).toEqual({ executed: 1, passed: 1, failed: 0, skipped: 0 });
    expect(visible.reportPaths).toEqual(expect.arrayContaining(["target/site/jacoco/jacoco.xml"]));
    const completed = trace.find(event => event.event === "tool.completed");
    expect(String((completed!.output as { stdout: string }).stdout).length).toBeGreaterThan(50_000);
  });
});

describe("LangChain cancellation and cleanup", () => {
  it("cancels before Host revalidation and never reruns tests or invokes again", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([() => finalReport(report("no-bug"))]);
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const events: AgentWorkLogEvent[] = [];

    const failure = await verifier(fixture, model, {
      signal: controller.signal,
      events,
      onEvent: (event) => {
        if (event.event === "agent.invocation.completed") controller.abort(reason);
      },
    })(fixture.input, "single-agent", "verify").catch((error: unknown) => error);

    expect(failure).toBe(reason);
    expect(model.observations).toHaveLength(1);
    expect(events.some(event => event.event === "host.revalidation.completed")).toBe(false);
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("cancels a running test process and releases the harness", async () => {
    const fixture = await createFixture(passingTest, SLOW_RUNNER_SCRIPT);
    const model = new ScriptedChatModel([
      () => toolCall("run_target_tests", {}, "run-1"),
      () => finalReport(report("no-bug")),
    ]);
    const controller = new AbortController();
    const reason = new Error("cancelled while tests run");

    const pending = verifier(fixture, model, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.event === "tool.started") setTimeout(() => controller.abort(reason), 100);
      },
    })(fixture.input, "single-agent", "verify").catch((error: unknown) => error);

    const failure = await pending;
    expect(failure).toBe(reason);
    await expect(access(join(fixture.root, "runner-started.txt"))).resolves.toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 300));
    await expect(access(join(fixture.root, "runner-finished.txt"))).rejects.toThrow();
    expect(model.observations).toHaveLength(1);
    expect(fixture.cleanupCalls).toBe(1);
  });
});

describe("LangChain workspace serialization and session isolation", () => {
  it("runs batched writes, reads and test execution against the same working directory in order", async () => {
    const fixture = await createFixture();
    const model = new ScriptedChatModel([
      () => toolCalls([
        {
          name: "write_target_test",
          args: { path: TEST_PATH, content: failingTest },
          id: "write-1",
        },
        { name: "read_target_file", args: { path: TEST_PATH }, id: "read-1" },
        { name: "run_target_tests", args: {}, id: "run-1" },
      ]),
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "targetFn accepts input the requirement rejects." },
        affectedTargets: [{ path: TARGET_PATH, name: "targetFn" }],
      })),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("failure");
    expect(result.issue?.kind).toBe("translation");
    const toolMessages = model.observations[1]!.filter(
      (message): message is ToolMessage => message instanceof ToolMessage,
    );
    expect(toolMessages).toHaveLength(3);
    expect(String(toolMessages[0]!.content)).toContain(TEST_PATH);
    expect(String(toolMessages[1]!.content)).toContain("FAILING");
    expect(String(toolMessages[2]!.content)).toContain('"failed":1');
    expect(fixture.cleanupCalls).toBe(1);
  });

  it("keeps separate verification runs in separate sessions", async () => {
    const fixture = await createFixture(passingTest);
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
      () => finalReport(report("no-bug")),
    ]);
    const run = verifier(fixture, model);

    await expect(run(fixture.input, "single-agent", "verify")).resolves.toMatchObject({ status: "success" });
    await expect(run(fixture.input, "single-agent", "verify")).resolves.toMatchObject({ status: "success" });

    expect(model.observations[1]).toHaveLength(model.observations[0]!.length);
    const secondSession = JSON.stringify(model.observations[1]!.map(message => message.content));
    expect(secondSession).not.toContain("did not accept your final report");
    expect(secondSession).not.toContain("The target behavior was checked");
    expect(fixture.cleanupCalls).toBe(2);
  });

  it("emits bounded tool logs and keeps the full observation out of model-visible feedback", async () => {
    const fixture = await createFixture(passingTest);
    const outOfScope = Array.from({ length: 600 }, (_, index) => ({
      path: `src/Other${index}.java`,
      name: `other${index}`,
    }));
    const model = new ScriptedChatModel([
      () => toolCall("run_target_tests", {}, "run-1"),
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "A concrete defect description." },
        affectedTargets: [{ path: TARGET_PATH, name: "targetFn" }, ...outOfScope],
      })),
      () => finalReport(report("no-bug")),
    ]);
    const events: AgentWorkLogEvent[] = [];

    const result = await verifier(fixture, model, { events })(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("success");
    const feedback = model.observations[2]!.find(
      (message): message is HumanMessage => message instanceof HumanMessage &&
        String(message.content).includes("did not accept your final report"),
    );
    expect(feedback).toBeDefined();
    expect(String(feedback!.content).length).toBeLessThanOrEqual(12_200);
    expect(String(feedback!.content)).toContain("feedback truncated");

    expect(events.filter(event => event.event === "tool.completed")).toHaveLength(1);
    expect(events.find(event => event.event === "tool.completed")).toMatchObject({
      toolName: expect.any(String),
      outputCharacters: expect.any(Number),
    });
    expect(events.map(event => event.event)).toEqual(expect.arrayContaining([
      "run.started",
      "agent.invocation.started",
      "agent.invocation.completed",
      "host.revalidation.completed",
      "agent.feedback.appended",
      "run.completed",
    ]));
    expect(events.filter(event => event.event === "agent.invocation.started")).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain("sk-");
    expect(fixture.cleanupCalls).toBe(1);
  });
});
