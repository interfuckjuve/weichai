import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVerifier } from "../src/verify.js";
import { createAgentHost } from "../src/host/runtime.js";
import type {
  AgentCompletion,
  AgentMessage,
  AgentModelClient,
  AgentToolCall,
  AgentToolDefinition,
} from "../src/host/model.js";
import type { TargetTestResult } from "../src/host/tools/common.js";
import type { SingleAgentTerminalResult } from "../src/strategies/single-agent/strategy.js";
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

type ScriptedModel = {
  client: AgentModelClient;
  calls: string[];
  toolNames: string[];
  descriptions: string[];
  targetTestResult?: TargetTestResult;
  terminalTool?: string;
};

const workspaces: FixtureWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
});

function createScriptedModel(): ScriptedModel {
  let step = 0;
  const state: ScriptedModel = {
    client: undefined as unknown as AgentModelClient,
    calls: [],
    toolNames: [],
    descriptions: [],
  };

  function nextCall(
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): AgentCompletion {
    state.calls.push(name);
    return toolCall(id, name, input);
  }

  state.client = {
    async complete(
      messages: readonly AgentMessage[],
      tools: readonly AgentToolDefinition[],
    ): Promise<AgentCompletion> {
      if (step === 0) {
        state.toolNames = tools.map((tool) => tool.name);
        state.descriptions = tools.map((tool) => tool.description);
      } else {
        const last = messages[messages.length - 1];
        if (last?.role !== "tool") {
          throw new Error("Scripted Agent expected the previous tool result.");
        }
        const result = JSON.parse(last.content) as { error?: string };
        if (result.error !== undefined) {
          throw new Error(`Fixture tool call failed: ${result.error}`);
        }
      }

      const currentStep = step++;
      switch (currentStep) {
        case 0:
          return nextCall("list-source", "list_source_files", {
            directory: "src/Commons/FileUpload",
            maxResults: 50,
          });
        case 1:
          return nextCall("read-source", "read_source_file", {
            path: "src/Commons/FileUpload/MultipartStream.cs",
          });
        case 2:
          return nextCall("list-target", "list_target_files", {
            directory: "src/main/java/org/apache/commons/fileupload",
            maxResults: 50,
          });
        case 3:
          return nextCall("read-target", "read_target_file", {
            path: TARGET_FUNCTION_PATH,
          });
        case 4:
          return nextCall("write-test", "write_target_test", {
            path: GENERATED_TEST_PATH,
            content: GENERATED_TEST,
          });
        case 5:
          return nextCall("run-test", "run_target_tests", {
            path: GENERATED_TEST_PATH,
          });
        case 6: {
          const last = messages[messages.length - 1];
          if (last?.role !== "tool") {
            throw new Error("Scripted Agent expected the target test result.");
          }
          const result = JSON.parse(last.content) as TargetTestResult;
          state.targetTestResult = result;
          if (result.status === "success") {
            state.terminalTool = "finish";
            return nextCall("finish", "finish", {
              testExecutionStatus: "success",
              translationStatus: "success",
            });
          }
          state.terminalTool = "report_uncertain";
          return nextCall("uncertain", "report_uncertain", {
            issue: {
              kind: "test",
              description:
                "The Host target test did not establish translation correctness.",
            },
          });
        }
        default:
          throw new Error("Scripted Agent received an unexpected extra turn.");
      }
    },
  };
  return state;
}

function toolCall(
  id: string,
  name: string,
  input: Record<string, unknown>,
): AgentCompletion {
  const call: AgentToolCall = {
    id,
    name,
    arguments: JSON.stringify(input),
  };
  return { content: "", toolCalls: [call] };
}

describe("translation verifier E2E fixture", () => {
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
      const model = createScriptedModel();
      const host = createAgentHost<SingleAgentTerminalResult>({
        modelClient: model.client,
        limits: {
          maxDurationMs: 120_000,
          maxTurns: 10,
          maxToolCalls: 10,
          maxToolCallsPerTurn: 1,
        },
      });

      const result = await createVerifier(host)(input, "single-agent", "verify");

      expect(model.toolNames).toEqual([
        "list_source_files",
        "read_source_file",
        "list_target_files",
        "read_target_file",
        "write_target_test",
        "run_target_tests",
        "finish",
        "report_uncertain",
      ]);
      expect(model.calls).toEqual([
        "list_source_files",
        "read_source_file",
        "list_target_files",
        "read_target_file",
        "write_target_test",
        "run_target_tests",
        model.terminalTool,
      ]);
      expect(model.targetTestResult).toBeDefined();
      expect(model.terminalTool).toMatch(/^(finish|report_uncertain)$/);
      expect(["success", "failure"]).toContain(result.status);
      if (result.status === "failure") {
        expect(result.issue).toBeDefined();
      }
      expect(await runGit(workspace.targetRoot, ["rev-parse", "--is-inside-work-tree"])).toBe(
        "true",
      );
      expect(
        await readFile(join(workspace.targetRoot, GENERATED_TEST_PATH), "utf8"),
      ).toBe(GENERATED_TEST);
      expect(
        await readFixtureFile(workspace.targetBeforeRoot, TARGET_FUNCTION_PATH),
      ).toBe(fixtureTargetBefore);
      expect(
        await readFixtureFile(workspace.targetAfterRoot, TARGET_FUNCTION_PATH),
      ).toBe(fixtureTargetAfter);
      for (const description of model.descriptions) {
        expect(description).not.toContain(workspace.sourceRoot);
        expect(description).not.toContain(workspace.targetRoot);
        expect(description).not.toContain("You are");
      }
    },
    120_000,
  );
});
