import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createFunctionGroupVerifier } from "./function-group-verify.js";
import { createLangChainFunctionGroupAgentHost } from "./host/langchain-runtime.js";
import type { AgentTraceEvent } from "./host/trace-log.js";
import type { ToolRuntimeContext } from "./host/tools/common.js";
import type {
  FunctionGroupVerificationInput,
  RequirementFunctionGroupVerificationInput,
} from "./types.js";

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

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const TEST_PATH = "tests/agent/GroupTest.java";
const ORDER_PATH = "src/Order.java";
const PRICE_RULE_PATH = "src/PriceRule.java";
const FUNCTION_GROUP_TOOLS = ["run_function_group_tests", "write_target_test"];

const RUNNER_SCRIPT = `const fs = require('node:fs');
const testPath = ${JSON.stringify(TEST_PATH)};
const content = fs.existsSync(testPath) ? fs.readFileSync(testPath, 'utf8') : '';
fs.rmSync('target', { recursive: true, force: true });
fs.mkdirSync('target/surefire-reports', { recursive: true });
fs.mkdirSync('target/site/jacoco', { recursive: true });
const surefire = 'target/surefire-reports/TEST-GroupTest.xml';
const jacoco = 'target/site/jacoco/jacoco.xml';
const method = (name, desc, missed, covered, branch) =>
  '<method name="' + name + '" desc="' + desc + '"><counter type="METHOD" missed="0" covered="1"/><counter type="LINE" missed="' + missed + '" covered="' + covered + '"/>' + branch + '</method>';
const orderMethods = [method('calculatePrice', '()I', 0, 4, '<counter type="BRANCH" missed="1" covered="1"/>')];
if (content.includes('COVER_B')) orderMethods.push(method('applyDiscount', '(I)I', 1, 3, ''));
const classes = ['<class name="Order" sourcefilename="Order.java">' + orderMethods.join('') + '</class>'];
if (content.includes('COVER_C')) {
  classes.push('<class name="PriceRule" sourcefilename="PriceRule.java">' + method('apply', '(I)I', 1, 1, '') + '</class>');
}
if (content.includes('SIGNATURE_MISMATCH')) {
  classes.push('<class name="PriceRule" sourcefilename="PriceRule.java">' + method('apply', '(Ljava/lang/String;)V', 1, 1, '') + '</class>');
}
fs.writeFileSync(jacoco, '<report><package name="">' + classes.join('') + '</package></report>');
if (content.includes('BROKEN')) {
  fs.writeFileSync(surefire, '<testsuite name="GroupTest" tests="1" failures="0" errors="1" skipped="0"><testcase classname="GroupTest" name="compile"><error message="cannot find symbol"/></testcase></testsuite>');
} else if (content.includes('FAIL_A')) {
  fs.writeFileSync(surefire, '<testsuite name="GroupTest" tests="1" failures="1" errors="0" skipped="0"><testcase classname="GroupTest" name="requirement"><failure message="expected rejection">trace</failure></testcase></testsuite>');
  process.exitCode = 1;
} else {
  fs.writeFileSync(surefire, '<testsuite name="GroupTest" tests="1" failures="0" errors="0" skipped="0"><testcase classname="GroupTest" name="requirement"/></testsuite>');
}
`;

type Fixture = {
  root: string;
  input: FunctionGroupVerificationInput;
  requirementInput: RequirementFunctionGroupVerificationInput;
  resolveToolContext: (taskContext: unknown) => Promise<ToolRuntimeContext>;
};

async function createFixture(testContent?: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "verifier-group-langchain-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "tests/agent"), { recursive: true });
  await writeFile(join(root, ORDER_PATH), "class Order { int calculatePrice() { return 1; } int applyDiscount(int v) { return v; } }");
  await writeFile(join(root, PRICE_RULE_PATH), "class PriceRule { int apply(int v) { return v; } }");
  if (testContent !== undefined) await writeFile(join(root, TEST_PATH), testContent);
  await writeFile(join(root, "fake-runner.cjs"), RUNNER_SCRIPT);
  const functions = [
    { source: { path: "src/Order.cs", name: "CalculatePrice" }, target: { path: ORDER_PATH, name: "calculatePrice" } },
    { source: { path: "src/Order.cs", name: "ApplyDiscount" }, target: { path: ORDER_PATH, name: "applyDiscount", signature: "Order.applyDiscount(int)" } },
    { source: { path: "src/PriceRule.cs", name: "Apply" }, target: { path: PRICE_RULE_PATH, name: "apply", signature: "PriceRule.apply(int)" } },
  ];
  const input: FunctionGroupVerificationInput = {
    schemaVersion: "3.1",
    sourceLanguage: "C#",
    targetLanguage: "Java",
    sourceProjectPath: root,
    targetProjectPath: root,
    requirement: "Preserve order pricing behavior.",
    functions,
    moduleProtocol: {
      version: 1,
      moduleId: "pricing",
      sourceVersion: 1,
      invariants: [{ id: "R1", rule: "Discounts are monotonic.", source: "requirement", status: "fixed" }],
      boundaries: [],
      sharedContracts: [],
      openQuestions: [],
    },
  };
  const requirementInput: RequirementFunctionGroupVerificationInput = {
    schemaVersion: "3.1",
    mode: "requirement",
    sourceLanguage: "Java",
    targetLanguage: "Java",
    targetProjectPath: root,
    requirement: "Reject expired tenant scopes.",
    functions: functions.map(({ target }) => ({ target })),
    moduleProtocol: input.moduleProtocol,
  };
  return {
    root,
    input,
    requirementInput,
    // The strategy builds the task context (including the function group); the
    // fixture only binds the Host-owned test environment.
    resolveToolContext: async (taskContext) => ({
      ...(taskContext as ToolRuntimeContext),
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
    summary: "The target function group was checked against the requirement.",
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

function groupVerifier(fixture: Fixture, model: ScriptedChatModel, extra: {
  events?: AgentTraceEvent[];
} = {}) {
  return createFunctionGroupVerifier(createLangChainFunctionGroupAgentHost({
    model,
    resolveToolContext: fixture.resolveToolContext,
    ...(extra.events ? { traceLogger: event => extra.events!.push(event) } : {}),
  }));
}

describe("LangChain translation function-group verification", () => {
  it("accepts a no-bug report only after the Host revalidates every target", async () => {
    const fixture = await createFixture("class GroupTest { /* COVER_B COVER_C */ }");
    const events: AgentTraceEvent[] = [];
    const model = new ScriptedChatModel([
      () => toolCall("run_function_group_tests", {}, "run-1"),
      () => finalReport(report("no-bug", { protocolChecks: [{ ruleId: "R1", status: "passed" }] })),
    ]);

    const result = await groupVerifier(fixture, model, { events })(
      fixture.input,
      "single-agent-function-group",
      "verify",
    );

    expect(result.status).toBe("success");
    expect(result.issue).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(result.functions.map(item => item.target.name)).toEqual([
      "calculatePrice", "applyDiscount", "apply",
    ]);
    expect(result.functions.every(item => item.executed && item.status === "passed")).toBe(true);
    expect(result.functions[0]).toMatchObject({
      source: { path: "src/Order.cs", name: "CalculatePrice" },
      target: { path: ORDER_PATH, name: "calculatePrice" },
      lineCoverage: 100,
      branchCoverage: 50,
    });
    expect(result.functions[2]).toMatchObject({ lineCoverage: 50, branchCoverage: null });
    expect(result.protocolChecks).toEqual([{ ruleId: "R1", status: "passed" }]);
    expect(model.toolNames[0]).toEqual(expect.arrayContaining([
      ...FUNCTION_GROUP_TOOLS, "read_source_file", "read_target_file",
    ]));
    expect(model.toolNames[0]).not.toContain("finish_function_group");
    expect(model.toolNames[0]).not.toContain("report_uncertain");
    const prompt = model.observations[0]!.map(message => JSON.stringify(message.content)).join("\n");
    expect(prompt).toContain("Preserve order pricing behavior.");
    expect(prompt).toContain("calculatePrice");
    expect(prompt).toContain("applyDiscount");
    expect(prompt).toContain("Discounts are monotonic.");
    expect(prompt).toContain("no-bug");
    expect(model.observations[1]!.some(message =>
      message instanceof ToolMessage && String(message.content).includes('"executed":1'),
    )).toBe(true);
    expect(events.filter(event => event.event === "host.revalidation.completed")).toHaveLength(1);
  });

  it("keeps requirement mode target-only with the full requested scope in context", async () => {
    const fixture = await createFixture("class GroupTest { /* COVER_B COVER_C */ }");
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
    ]);

    const result = await groupVerifier(fixture, model)(
      fixture.requirementInput,
      "requirement-function-group",
      "verify",
    );

    expect(result.status).toBe("success");
    expect(result.functions.map(item => item.target.name)).toEqual([
      "calculatePrice", "applyDiscount", "apply",
    ]);
    expect(result.functions.every(item => item.executed)).toBe(true);
    expect(result.functions.some(item => "source" in item)).toBe(false);
    expect(model.toolNames[0]).toEqual(expect.arrayContaining(FUNCTION_GROUP_TOOLS));
    expect(model.toolNames[0]).not.toContain("read_source_file");
    expect(model.toolNames[0]).not.toContain("list_source_files");
    const prompt = model.observations[0]!.map(message => JSON.stringify(message.content)).join("\n");
    expect(prompt).toContain("Reject expired tenant scopes.");
    expect(prompt).toContain("Discounts are monotonic.");
  });
});

describe("LangChain function-group conclusion matrix", () => {
  it("returns an evidenced bug while leaving unexecuted targets unverified without more rounds", async () => {
    const fixture = await createFixture("class GroupTest { /* FAIL_A */ }");
    const model = new ScriptedChatModel([
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "calculatePrice accepts a negative amount the requirement rejects." },
        affectedTargets: [{ path: ORDER_PATH, name: "calculatePrice" }],
        protocolChecks: [{ ruleId: "R1", status: "failed", note: "discount went negative" }],
      })),
    ]);

    const result = await groupVerifier(fixture, model)(
      fixture.input,
      "single-agent-function-group",
      "verify",
    );

    expect(result.status).toBe("failure");
    expect(result.issue).toEqual({
      kind: "translation",
      description: "calculatePrice accepts a negative amount the requirement rejects.",
    });
    expect(result.functions.map(item => [item.target.name, item.executed]))
      .toEqual([["calculatePrice", true], ["applyDiscount", false], ["apply", false]]);
    expect(result.functions[1]).toMatchObject({ status: "unverified", executed: false, lineCoverage: null, coverageIssue: expect.any(String) });
    expect(result.functions[2]).toMatchObject({ status: "unverified", executed: false, lineCoverage: null, coverageIssue: expect.any(String) });
    expect(result.protocolChecks).toEqual([{ ruleId: "R1", status: "failed", note: "discount went negative" }]);
    expect(result.reason).toBe("test-failed");
    // No continuation is spent on completing the unexecuted targets.
    expect(model.observations).toHaveLength(1);
  });

  it("accepts uncertain with passing tests and a concrete ambiguity instead of success", async () => {
    const fixture = await createFixture("class GroupTest { /* COVER_B COVER_C */ }");
    const model = new ScriptedChatModel([
      () => finalReport(report("uncertain", {
        issue: {
          kind: "unknown",
          description: "The requirement never defines the rounding mode for discounted prices.",
        },
      })),
    ]);

    const result = await groupVerifier(fixture, model)(
      fixture.input,
      "single-agent-function-group",
      "verify",
    );

    expect(result.status).toBe("failure");
    expect(result.issue).toEqual({
      kind: "unknown",
      description: "The requirement never defines the rounding mode for discounted prices.",
    });
    expect(result.functions.every(item => item.executed && item.status === "passed")).toBe(true);
    expect(model.observations).toHaveLength(1);
  });

  it("feeds missing target evidence and a signature mismatch back to the same session", async () => {
    const fixture = await createFixture("class GroupTest { /* COVER_B SIGNATURE_MISMATCH */ }");
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug")),
      () => toolCall("write_target_test", { path: TEST_PATH, content: "class GroupTest { /* COVER_B COVER_C */ }" }, "fix-1"),
      () => finalReport(report("no-bug")),
    ]);

    const result = await groupVerifier(fixture, model)(
      fixture.input,
      "single-agent-function-group",
      "verify",
    );

    expect(result.status).toBe("success");
    expect(result.functions.every(item => item.executed)).toBe(true);
    const continuation = model.observations[1]!.map(message => JSON.stringify(message.content)).join("\n");
    expect(continuation).toContain("did not accept your final report");
    expect(continuation).toContain("requires execution evidence for every requested target function");
    expect(continuation).toContain(PRICE_RULE_PATH);
    expect(continuation).toContain("report paths: target/site/jacoco/jacoco.xml");
    // The repaired test file is still in the same working directory and session.
    expect(model.observations[2]!.some(message =>
      message instanceof ToolMessage && String(message.content).includes(TEST_PATH))).toBe(true);
    expect(await readFile(join(fixture.root, TEST_PATH), "utf8")).toContain("COVER_C");
  });

  it("requires a failing assertion, in-scope targets and this round's evidence for bug reports", async () => {
    const fixture = await createFixture("class GroupTest { /* COVER_B COVER_C */ }");
    const model = new ScriptedChatModel([
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "Pricing is wrong." },
        affectedTargets: [{ path: "src/Elsewhere.java", name: "other" }],
      })),
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "Pricing is wrong." },
        affectedTargets: [{ path: ORDER_PATH, name: "applyDiscount", signature: "Order.applyDiscount(int)" }],
      })),
      () => toolCall("write_target_test", { path: TEST_PATH, content: "class GroupTest { /* FAIL_A COVER_B */ }" }, "repro-1"),
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "applyDiscount violates the monotonic discount rule." },
        affectedTargets: [{ path: ORDER_PATH, name: "applyDiscount", signature: "Order.applyDiscount(int)" }],
      })),
    ]);

    const result = await groupVerifier(fixture, model)(
      fixture.input,
      "single-agent-function-group",
      "verify",
    );

    expect(result.status).toBe("failure");
    expect(result.issue?.description).toBe("applyDiscount violates the monotonic discount rule.");
    const first = model.observations[1]!.map(message => JSON.stringify(message.content)).join("\n");
    expect(first).toContain("requires at least one valid failing assertion");
    expect(first).toContain("must stay inside the requested function-group scope");
    const second = model.observations[2]!.map(message => JSON.stringify(message.content)).join("\n");
    expect(second).toContain("needs execution evidence from this Host run");
    expect(result.functions[1]).toMatchObject({ executed: true });
  });

  it("rejects a no-bug report with failed protocol checks and never reuses an earlier round's coverage", async () => {
    const fixture = await createFixture("class GroupTest { /* COVER_B COVER_C */ }");
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug", {
        protocolChecks: [{ ruleId: "R1", status: "failed", note: "discount went negative" }],
      })),
      () => toolCall("write_target_test", { path: TEST_PATH, content: "class GroupTest { /* FAIL_A */ }" }, "repro-2"),
      () => finalReport(report("bug-found", {
        issue: { kind: "translation", description: "calculatePrice accepts a negative amount." },
        affectedTargets: [{ path: ORDER_PATH, name: "calculatePrice" }],
        protocolChecks: [{ ruleId: "R1", status: "failed", note: "discount went negative" }],
      })),
    ]);

    const result = await groupVerifier(fixture, model)(
      fixture.input,
      "single-agent-function-group",
      "verify",
    );

    expect(result.status).toBe("failure");
    expect(model.observations[1]!.map(message => JSON.stringify(message.content)).join("\n"))
      .toContain("cannot be accepted while protocol checks are failed or ambiguous");
    // applyDiscount and apply executed in the first round but not in the accepted run.
    expect(result.functions[1]).toMatchObject({ executed: false, lineCoverage: null });
    expect(result.functions[2]).toMatchObject({ executed: false, lineCoverage: null });
    expect(result.functions[1]?.coverageIssue).toBeDefined();
    expect(result.functions[0]).toMatchObject({ executed: true });
  });
});

describe("LangChain function-group report shape", () => {
  it("rejects more than three protocol checks before revalidating and accepts the bounded report", async () => {
    const fixture = await createFixture("class GroupTest { /* COVER_B COVER_C */ }");
    const checks = ["R1", "R2", "R3", "R4"].map(ruleId => ({ ruleId, status: "passed" }));
    const model = new ScriptedChatModel([
      () => finalReport(report("no-bug", { protocolChecks: checks })),
      () => finalReport(report("no-bug", { protocolChecks: checks.slice(0, 3) })),
    ]);

    const result = await groupVerifier(fixture, model)(
      fixture.input,
      "single-agent-function-group",
      "verify",
    );

    expect(result.status).toBe("success");
    expect(result.protocolChecks?.map(check => check.ruleId)).toEqual(["R1", "R2", "R3"]);
    expect(model.observations[1]!.map(message => JSON.stringify(message.content)).join("\n"))
      .toContain("at most three");
  });
});
