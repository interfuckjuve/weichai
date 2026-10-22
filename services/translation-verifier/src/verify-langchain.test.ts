import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createVerifier } from "./verify.js";
import { createLangChainAgentHost } from "./host/langchain-runtime.js";
import type { AgentTraceEvent } from "./host/trace-log.js";
import type { ToolRuntimeContext } from "./host/tools/common.js";
import type { VerificationInput } from "./types.js";

type ScriptedResponse = (messages: readonly BaseMessage[]) => AIMessage;

/** A controllable framework chat model: real LangChain execution, scripted replies. */
class ScriptedChatModel extends BaseChatModel {
  readonly observations: BaseMessage[][] = [];
  readonly toolNames: string[][] = [];
  private index = 0;

  constructor(private readonly script: ScriptedResponse[]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(tools: StructuredToolInterface[]): this {
    this.toolNames.push(tools.map(tool => tool.name));
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.observations.push([...messages]);
    const next = this.script[this.index++];
    if (next === undefined) throw new Error("Scripted model ran out of responses.");
    const message = next(messages);
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

type Fixture = {
  root: string;
  input: VerificationInput;
  resolveToolContext: () => Promise<ToolRuntimeContext>;
};

async function createFixture(testContent?: string, runnerSuffix = ""): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "verifier-langchain-"));
  modelRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests/agent"), { recursive: true });
  await writeFile(join(root, "src/Source.java"), "class Source { int sourceFn() { return 1; } }");
  await writeFile(
    join(root, TARGET_PATH),
    "class Target { int targetFn() { return 1; } }",
  );
  if (testContent !== undefined) await writeFile(join(root, TEST_PATH), testContent);
  await writeFile(join(root, "fake-runner.cjs"), `${RUNNER_SCRIPT}${runnerSuffix}`);
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
  const taskContext = {
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    sourceProjectPath: root,
    targetProjectPath: root,
    sourcePath: input.subject.sourceFunction.path,
    targetPath: input.subject.targetFunction.path,
    targetFunction: input.subject.targetFunction,
  };
  return {
    root,
    input,
    resolveToolContext: async () => ({
      ...taskContext,
      sourceDirectory: "src",
      targetDirectory: "src",
      testRoots: ["tests/agent"],
      testRunner: "maven",
      targetTest: { executable: process.execPath, args: ["fake-runner.cjs"], timeoutMs: 10_000 },
    }),
  };
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

function verifier(fixture: Fixture, model: ScriptedChatModel, extra: {
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
      "run_target_tests", "write_target_test", "read_target_file",
    ]));
    expect(model.toolNames[0]).not.toContain("finish");
    expect(model.toolNames[0]).not.toContain("report_uncertain");
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
    expect(model.observations[1]!.some(message =>
      message instanceof ToolMessage && /authorized test roots|outside/i.test(String(message.content)),
    )).toBe(true);
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

  it("does not treat a framework stop produced by the model-call budget as an accepted report", async () => {
    const fixture = await createFixture("class BehaviorTest { int requirement() { return 1; } }");
    const model = new ScriptedChatModel([
      () => new AIMessage("still investigating"),
      () => finalReport(report("no-bug")),
    ]);

    await expect(verifier(fixture, model, { limits: { maxTurns: 1 } })(
      fixture.input,
      "single-agent",
      "verify",
    )).rejects.toThrow();
  });
});
