import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createVerifier } from "../src/verify.js";
import { createFunctionGroupVerifier } from "../src/function-group-verify.js";
import {
  createLangChainAgentHost,
  createLangChainFunctionGroupAgentHost,
} from "../src/host/langchain-runtime.js";
import { AgentRunFailure } from "../src/host/run-budget.js";
import type { AgentWorkLogEvent } from "../src/host/work-log.js";
import type { AgentTraceEvent } from "../src/host/trace-log.js";
import type {
  FunctionGroupVerificationInput,
  VerificationInput,
} from "../src/types.js";
import {
  createFixtureWorkspace,
  GENERATED_TEST_PATH,
  materializeFixtureInput,
  readFixtureFile,
  runGit,
  TARGET_FUNCTION_PATH,
  type FixtureWorkspace,
} from "./fixture-workspace.js";

const GENERATED_TEST = `package org.apache.commons.fileupload;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

import org.junit.Test;

public class TranslationVerifierReadBodyDataTest {

    @Test
    public void readsBodyAndPreservesBoundaryAndOutput() throws Exception {
        byte[] boundary = "b".getBytes(StandardCharsets.US_ASCII);
        byte[] input = "payload\\r\\n--b\\r\\nnext".getBytes(StandardCharsets.ISO_8859_1);
        MultipartStream stream = new MultipartStream(
                new ByteArrayInputStream(input), boundary);
        TrackingOutputStream output = new TrackingOutputStream();

        assertEquals(7, stream.readBodyData(output));
        assertArrayEquals(
                "payload".getBytes(StandardCharsets.US_ASCII),
                output.toByteArray());
        assertFalse(output.closed);
        assertTrue(stream.readBoundary());
    }

    @Test
    public void discardsBodyWhenOutputIsNull() throws Exception {
        byte[] boundary = "b".getBytes(StandardCharsets.US_ASCII);
        byte[] input = "payload\\r\\n--b\\r\\nnext".getBytes(StandardCharsets.ISO_8859_1);
        MultipartStream stream = new MultipartStream(
                new ByteArrayInputStream(input), boundary);

        assertEquals(7, stream.readBodyData(null));
    }

    private static final class TrackingOutputStream extends ByteArrayOutputStream {
        private boolean closed;

        @Override
        public void close() throws IOException {
            closed = true;
            super.close();
        }
    }
}
`;

/** The same test file without any call into readBoundary. */
const READ_BODY_DATA_ONLY_TEST = GENERATED_TEST.replace(
  "        assertTrue(stream.readBoundary());\n",
  "",
).replace("import static org.junit.Assert.assertTrue;\n", "");

type ScriptedResponse = (messages: readonly BaseMessage[]) => AIMessage;

/** A controllable framework chat model: real LangChain execution, scripted replies. */
class ScriptedBaseChatModel extends BaseChatModel {
  readonly observations: BaseMessage[][] = [];
  readonly toolNames: string[][] = [];
  readonly toolDescriptions: string[][] = [];
  private index = 0;

  constructor(private readonly script: ScriptedResponse[]) {
    super({});
  }

  _llmType(): string {
    return "scripted";
  }

  bindTools(tools: StructuredToolInterface[]): this {
    this.toolNames.push(tools.map(tool => tool.name));
    this.toolDescriptions.push(tools.map(tool => tool.description));
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

const workspaces: FixtureWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

function toolCall(name: string, args: Record<string, unknown>, id: string): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ name, args, id, type: "tool_call" }],
  });
}

function finalReport(verdict: "no-bug" | "bug-found" | "uncertain", extra: Record<string, unknown> = {}): AIMessage {
  return new AIMessage({
    content: JSON.stringify({
      verdict,
      summary: "The dedicated test folder was checked against the requirement.",
      ...extra,
    }),
  });
}

function lastToolMessage(messages: readonly BaseMessage[]): ToolMessage | undefined {
  return [...messages].reverse().find(
    (message): message is ToolMessage => message instanceof ToolMessage,
  );
}

function promptText(messages: readonly BaseMessage[]): string {
  return messages.map(message => JSON.stringify(message.content)).join("\n");
}

function groupInput(input: VerificationInput): FunctionGroupVerificationInput {
  return {
    schemaVersion: "3.1",
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    sourceProjectPath: input.sourceProjectPath,
    targetProjectPath: input.targetProjectPath,
    requirement: input.subject.requirement,
    functions: [
      {
        source: { path: input.subject.sourceFunction.path, name: "ReadBodyData" },
        target: { path: input.subject.targetFunction.path, name: "readBodyData" },
      },
      {
        source: { path: input.subject.sourceFunction.path, name: "ReadBoundary" },
        target: { path: input.subject.targetFunction.path, name: "readBoundary" },
      },
    ],
  };
}

describe("translation verifier E2E fixture through the LangChain Host", () => {
  it("rejects passing tests that never execute the target function", async () => {
    const workspace = await createFixtureWorkspace();
    workspaces.push(workspace);
    const input = await materializeFixtureInput(workspace);
    const model = new ScriptedBaseChatModel([
      () => toolCall("write_target_test", {
        path: GENERATED_TEST_PATH,
        content: `package org.apache.commons.fileupload;
import org.junit.Test;
import static org.junit.Assert.assertTrue;
public class TranslationVerifierReadBodyDataTest {
    @Test public void unrelatedTest() { assertTrue(true); }
}`,
      }, "write-unrelated"),
      () => toolCall("run_target_tests", {}, "run-unrelated"),
      () => finalReport("no-bug"),
    ]);
    const host = createLangChainAgentHost({
      model,
      maxFeedbackRounds: 0,
      limits: { maxDurationMs: 120_000 },
    });

    // Unrelated passing tests cannot prove the target function works, so the
    // Host never accepts the no-bug report and the run stays an operational
    // failure instead of a verified success.
    const run = createVerifier(host)(input, "single-agent", "verify");
    await expect(run).rejects.toThrow(AgentRunFailure);
    await expect(run).rejects.toThrow(/feedback rounds/);

    const observation = lastToolMessage(model.observations[2]!);
    expect(observation).toBeDefined();
    expect(JSON.parse(String(observation!.content))).toMatchObject({
      status: "success",
      tests: { executed: 1, passed: 1 },
      coverage: { status: "available", targetFunction: { name: "readBodyData", executed: false } },
    });
    expect(await readFile(join(workspace.targetRoot, GENERATED_TEST_PATH), "utf8"))
      .toContain("unrelatedTest");
  }, 120_000);

  it(
    "runs the real Host, tools, target worktree and test process",
    async () => {
      const workspace = await createFixtureWorkspace();
      workspaces.push(workspace);
      const input = await materializeFixtureInput(workspace);
      const fixtureTargetBefore = await readFixtureFile(
        workspace.targetBeforeRoot,
        TARGET_FUNCTION_PATH,
      );
      const fixtureTargetAfter = await readFixtureFile(
        workspace.targetAfterRoot,
        TARGET_FUNCTION_PATH,
      );
      const events: AgentWorkLogEvent[] = [];
      const trace: AgentTraceEvent[] = [];
      const model = new ScriptedBaseChatModel([
        () => toolCall("list_source_files", { directory: "src/Commons/FileUpload", maxResults: 50 }, "list-source"),
        () => toolCall("read_source_file", { path: "src/Commons/FileUpload/MultipartStream.cs" }, "read-source"),
        () => toolCall("list_target_files", {
          directory: "src/main/java/org/apache/commons/fileupload",
          maxResults: 50,
        }, "list-target"),
        () => toolCall("read_target_file", { path: TARGET_FUNCTION_PATH }, "read-target"),
        () => toolCall("write_target_test", { path: GENERATED_TEST_PATH, content: GENERATED_TEST }, "write-test"),
        () => toolCall("run_target_tests", { path: GENERATED_TEST_PATH }, "run-test"),
        (messages) => {
          const observation = JSON.parse(String(lastToolMessage(messages)!.content)) as {
            status: string;
            coverage?: { targetFunction?: { executed?: boolean } };
          };
          return observation.status === "success" && observation.coverage?.targetFunction?.executed
            ? finalReport("no-bug")
            : finalReport("uncertain", {
              issue: { kind: "unknown", description: "The target test did not establish translation correctness." },
            });
        },
      ]);
      const host = createLangChainAgentHost({
        model,
        workLogger: event => events.push(event),
        traceLogger: event => trace.push(event),
        limits: { maxDurationMs: 120_000 },
      });

      const result = await createVerifier(host)(input, "single-agent", "verify");

      expect(model.toolNames[0]).toEqual([
        "list_source_files",
        "read_source_file",
        "list_target_files",
        "read_target_file",
        "write_target_test",
        "run_target_tests",
      ]);
      expect(model.toolNames[0]).not.toContain("finish");
      expect(model.toolNames[0]).not.toContain("report_uncertain");
      expect(result.status).toBe("success");
      expect(result.targetFunction).toMatchObject({ name: "readBodyData", executed: true, lineCoverage: 100, branchCoverage: null });
      expect(events.filter(event => event.event === "host.revalidation.completed")).toHaveLength(1);
      expect(events.at(-1)?.event).toBe("run.completed");
      expect(events.filter(event => event.event === "tool.completed")).toHaveLength(6);
      expect(trace.some(event => event.event === "tool.started" && event.input !== undefined)).toBe(true);
      expect(trace.some(event => event.event === "tool.completed" && event.output !== undefined)).toBe(true);
      expect(await runGit(workspace.targetRoot, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
      expect(
        await readFile(join(workspace.targetRoot, GENERATED_TEST_PATH), "utf8"),
      ).toBe(GENERATED_TEST);
      expect(
        await readFixtureFile(workspace.targetBeforeRoot, TARGET_FUNCTION_PATH),
      ).toBe(fixtureTargetBefore);
      expect(
        await readFixtureFile(workspace.targetAfterRoot, TARGET_FUNCTION_PATH),
      ).toBe(fixtureTargetAfter);
      for (const description of model.toolDescriptions[0]!) {
        expect(description).not.toContain(workspace.sourceRoot);
        expect(description).not.toContain(workspace.targetRoot);
        expect(description).not.toContain("You are");
      }
    },
    120_000,
  );

  it(
    "covers two real target functions and repairs the same session's test file",
    async () => {
      const workspace = await createFixtureWorkspace();
      workspaces.push(workspace);
      const input = groupInput(await materializeFixtureInput(workspace));
      const events: AgentWorkLogEvent[] = [];
      const model = new ScriptedBaseChatModel([
        () => toolCall("write_target_test", { path: GENERATED_TEST_PATH, content: READ_BODY_DATA_ONLY_TEST }, "write-first"),
        () => toolCall("run_function_group_tests", {}, "run-first"),
        () => finalReport("no-bug"),
        () => toolCall("write_target_test", { path: GENERATED_TEST_PATH, content: GENERATED_TEST }, "write-repair"),
        () => toolCall("run_function_group_tests", {}, "run-repair"),
        () => finalReport("no-bug"),
      ]);
      const host = createLangChainFunctionGroupAgentHost({
        model,
        workLogger: event => events.push(event),
        limits: { maxDurationMs: 180_000 },
      });

      const result = await createFunctionGroupVerifier(host)(
        input,
        "single-agent-function-group",
        "verify",
      );

      expect(model.toolNames[0]).toEqual([
        "list_source_files",
        "read_source_file",
        "list_target_files",
        "read_target_file",
        "write_target_test",
        "run_function_group_tests",
      ]);
      expect(model.toolNames[0]).not.toContain("finish_function_group");
      expect(model.toolNames[0]).not.toContain("report_uncertain");
      expect(result.status).toBe("success");
      expect(result.functions.map(item => item.target.name)).toEqual(["readBodyData", "readBoundary"]);
      expect(result.functions.every(item => item.executed && item.status === "passed")).toBe(true);
      expect(result.functions.map(item => item.lineCoverage)).toEqual([
        expect.any(Number), expect.any(Number),
      ]);
      // The first round did not execute readBoundary; the Host returned that
      // fact to the same session, which repaired its own test file.
      const continuation = promptText(model.observations[3]!);
      expect(continuation).toContain("did not accept your final report");
      expect(continuation).toContain("readBoundary");
      expect(model.observations[4]!.some(message =>
        message instanceof ToolMessage && String(message.content).includes("target/site/jacoco/jacoco.xml"),
      )).toBe(true);
      expect(await readFile(join(workspace.targetRoot, GENERATED_TEST_PATH), "utf8"))
        .toBe(GENERATED_TEST);
      expect(events.filter(event => event.event === "host.revalidation.completed")).toHaveLength(2);
      expect(events.filter(event => event.event === "agent.feedback.appended")).toHaveLength(1);
      expect(events.at(-1)?.event).toBe("run.completed");
    },
    180_000,
  );
});
