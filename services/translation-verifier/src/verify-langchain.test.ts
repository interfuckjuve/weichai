import {
  createSingleFunctionFixture,
  RUNNER_SCRIPT,
  TARGET_PATH,
  TEST_PATH,
  type SingleFunctionFixture,
} from "../test-support/single-function-fixture.js";
import { ScriptedChatModel } from "../test-support/scripted-chat-model.js";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { createVerifier } from "./verify.js";
import { createLangChainAgentHost } from "./host/agent/langchain-runtime.js";
import type { AgentTraceEvent } from "./host/logging/trace-log.js";

const modelRoots: string[] = [];
afterEach(async () => {
  await Promise.all(modelRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function createFixture(testContent?: string, runnerSuffix = ""): Promise<SingleFunctionFixture> {
  return createSingleFunctionFixture(modelRoots, testContent, `${RUNNER_SCRIPT}${runnerSuffix}`);
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

function finalReport(content: string): AIMessage {
  return new AIMessage({ content });
}

function verifier(fixture: SingleFunctionFixture, model: ScriptedChatModel, extra: {
  signal?: AbortSignal;
  limits?: { maxTurns?: number; maxToolCalls?: number };
  events?: AgentTraceEvent[];
} = {}) {
  return createVerifier(createLangChainAgentHost({
    model,
    resolveToolContext: fixture.resolveToolContext,
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.limits ? { limits: extra.limits } : {}),
    ...(extra.events ? { traceLogger: event => extra.events!.push(event) } : {}),
  }));
}

describe("LangChain single-function verification", () => {
  it("ends on a plain no-bug report, revalidates the complete folder, and maps success", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
    const events: AgentTraceEvent[] = [];
    const model = new ScriptedChatModel([
      () => toolCall("run_target_tests", {}, "call-1"),
      () => finalReport(report("no-bug")),
    ]);

    const result = await verifier(fixture, model, { events })(
      fixture.input,
      "single-agent",
      "verify",
    );

    expect(result).toMatchObject({
      status: "success",
      targetFunction: { name: "targetFn", executed: true },
    });
    expect(result.issue).toBeUndefined();
    expect(model.toolNames[0]).toEqual(expect.arrayContaining([
      "list_source_files", "read_source_file", "list_target_files",
      "read_target_file", "write_target_test", "run_target_tests",
    ]));
    expect(model.toolDescriptions[0]!.join("\n")).not.toContain(fixture.root);
    expect(JSON.stringify(model.observations[0]![0]?.content)).toContain("verdict");
    expect(JSON.stringify(model.observations[0]![0]?.content)).toContain("no-bug");
    expect(model.observations[1]!.some(message =>
      message instanceof ToolMessage && String(message.content).includes('"executed":1'),
    )).toBe(true);
    expect(events.map(event => event.event)).toEqual(expect.arrayContaining([
      "agent.invocation.completed", "host.revalidation.completed",
    ]));
    // The Host owns the definitive complete-suite run: tool run plus revalidation.
    expect(events.filter(event => event.event === "host.revalidation.completed")).toHaveLength(1);
  });

  it("maps an evidenced bug report to a translation failure with the observed coverage", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { /* FAILING */ } }");
    const model = new ScriptedChatModel([
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "targetFn accepts input the requirement rejects." },
        affectedTargets: [{ path: TARGET_PATH, name: "targetFn" }],
      })),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("failure");
    expect(result.issue).toEqual({
      kind: "translation",
      description: "targetFn accepts input the requirement rejects.",
    });
    expect(result.targetFunction).toMatchObject({ name: "targetFn", executed: true });
  });

  it("maps an evidenced uncertain report to a failure with an unknown issue", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
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
    expect(result.issue).toEqual({
      kind: "unknown",
      description: "The requirement does not define the rounding mode for negative values.",
    });
    expect(result.targetFunction).toMatchObject({ name: "targetFn", executed: true });
  });
});

describe("LangChain Host feedback continuation", () => {
  it("rejects a no-bug report while a protocol check is failed or ambiguous", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug", {
        protocolChecks: [
          { ruleId: "module-contract", status: "failed", note: "price went negative" },
          { ruleId: "error-shape", status: "ambiguous" },
        ],
      })),
      () => finalReport(report("no-bug")),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("success");
    const feedback = model.observations[1]!.find(message => message instanceof HumanMessage &&
      String(message.content).includes("did not accept your final report"));
    expect(feedback).toBeDefined();
    expect(String(feedback!.content)).toContain("protocol checks are failed or ambiguous");
    expect(String(feedback!.content)).toContain("module-contract");
    expect(String(feedback!.content)).toContain("error-shape");
  });

  it("quotes the failing test case and the runner stdout in single-function feedback", async () => {
    const fixture = await createFixture(
      "class BehaviorTest { FAILING }",
      "process.stdout.write('AssertionError: expected rejection at BehaviorTest.requirement\\n');\n",
    );
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "targetFn accepts input the requirement rejects." },
        affectedTargets: [{ path: TARGET_PATH, name: "targetFn" }],
      })),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("failure");
    const feedback = String(model.observations[1]!.find(message => message instanceof HumanMessage &&
      String(message.content).includes("did not accept your final report"))?.content);
    // The Agent must see the concrete failed assertion and the runner stdout.
    expect(feedback).toContain("failed test cases");
    expect(feedback).toContain("expected rejection");
    expect(feedback).toContain("- stdout:");
    expect(feedback).toContain("AssertionError: expected rejection");
  });

  it("feeds a compile failure back to the same Agent, which repairs the same test and passes revalidation", async () => {
    const fixture = await createFixture("class BehaviorTest { BROKEN }");
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
      () => toolCall("write_target_test", { path: TEST_PATH, content: "class BehaviorTest { int requirement() { return 1; } }" }, "fix-1"),
      () => toolCall("run_target_tests", {}, "run-2"),
      () => finalReport(report("no-bug")),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result).toMatchObject({ status: "success", targetFunction: { executed: true } });
    expect(await readFile(join(fixture.root, TEST_PATH), "utf8")).toContain("return 1;");
    const second = model.observations[2]!;
    expect(second.filter(message => message instanceof HumanMessage &&
      String(message.content).includes("Source reference function"))).toHaveLength(1);
    expect(second.some(message => message instanceof HumanMessage &&
      String(message.content).includes("did not accept your final report"))).toBe(true);
    expect(second.some(message => String(message.content).includes("compile and execute"))).toBe(true);
    expect(model.observations[3]!.some(message =>
      message instanceof ToolMessage && String(message.content).includes('"executed":1'))).toBe(true);
  });

  it("rejects a no-bug report with a failing assertion and accepts the evidenced bug report", async () => {
    const fixture = await createFixture("class BehaviorTest { FAILING }");
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "targetFn accepts input the requirement rejects." },
        affectedTargets: [{ path: TARGET_PATH, name: "targetFn" }],
      })),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("failure");
    expect(result.issue?.kind).toBe("translation");
    expect(model.observations[1]!.some(message => String(message.content)
      .includes("no-bug report requires every test"))).toBe(true);
  });

  it("returns report-shape feedback to the same session when the final message is not JSON", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
    const model = new ScriptedChatModel([
      () => new AIMessage("I think the translation looks fine."),
      () => finalReport(report("no-bug")),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("success");
    expect(model.observations[1]!.some(message => String(message.content)
      .includes("not valid JSON"))).toBe(true);
  });

  it("returns recoverable tool errors through framework tool messages and keeps running", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
    const model = new ScriptedChatModel([
      () => toolCall("write_target_test", { path: "other/Test.java", content: "x" }, "bad-write"),
      () => finalReport(report("no-bug")),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("success");
    const toolMessage = model.observations[1]!.find(
      (message): message is ToolMessage => message instanceof ToolMessage,
    );
    // The framework keeps the tool-call correlation for the refused call.
    expect(toolMessage?.tool_call_id).toBe("bad-write");
    expect(toolMessage?.status).toBe("error");
    expect(/authorized test roots|outside/i.test(String(toolMessage?.content))).toBe(true);
  });

  it("hands a schema rejection back to the same tool call without spending the run", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
    const model = new ScriptedChatModel([
      () => toolCall("run_target_tests", { command: "mvn -q verify" }, "bad-args"),
      () => finalReport(report("no-bug")),
    ]);

    const result = await verifier(fixture, model)(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("success");
    const toolMessage = model.observations[1]!.find(
      (message): message is ToolMessage => message instanceof ToolMessage && message.tool_call_id === "bad-args",
    );
    // Zod rejects the fixed-command override; the framework reports it back on
    // the same tool call instead of failing the verification run.
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.status).toBe("error");
    expect(String(toolMessage?.content)).toMatch(/did not match expected schema|invalid/i);
  });

  it("stops before invoking the model when the run is already cancelled", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
    const model = new ScriptedChatModel([() => finalReport(report("no-bug"))]);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));

    await expect(verifier(fixture, model, { signal: controller.signal })(
      fixture.input,
      "single-agent",
      "verify",
    )).rejects.toThrow();
    expect(model.observations).toHaveLength(0);
  });
});
