import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createSingleFunctionFixture, TEST_PATH } from "../../../test-support/single-function-fixture.js";
import { createVerifier } from "../../verify.js";
import { createTranslationVerifierChatModel } from "./chat-model.js";
import { createLangChainAgentHost } from "./langchain-runtime.js";

type WireMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Host tool-call protocol", () => {
  it.each([
    { scenario: "invalid batch", mixed: false },
    { scenario: "mixed batch", mixed: true },
    { scenario: "per-turn budget", mixed: true, turnLimit: 1 },
    { scenario: "missing identifier", mixed: false, omitId: true },
    { scenario: "repeated invalid batches", mixed: false, repeat: true },
  ])("handles $scenario without executing rejected tools", async ({ mixed, turnLimit, omitId, repeat }) => {
    const originalTest = "class BehaviorTest { int requirement() { return 1; } }";
    const fixture = await createSingleFunctionFixture(roots, originalTest);
    const frames: WireMessage[][] = [];
    const calls = [{ id: "malformed-call", type: "function", function: {
      name: "write_target_test", arguments: '{"path":"tests/agent/BehaviorTest.java","content":',
    } }];
    if (mixed) calls.push({ id: "valid-call", type: "function", function: {
      name: "write_target_test", arguments: JSON.stringify({ path: TEST_PATH, content: "BROKEN" }),
    } });
    if (omitId) delete (calls[0] as { id?: string }).id;
    const request: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
      frames.push(body.messages);
      const pending = new Set<string>();
      for (const message of body.messages) {
        for (const call of message.tool_calls ?? []) pending.add(call.id);
        if (message.role === "tool") pending.delete(message.tool_call_id!);
      }
      if (pending.size) return new Response(JSON.stringify({ error: {
        message: "An assistant message with tool_calls must be followed by tool messages responding to each tool_call_id.",
        type: "invalid_request_error",
      } }), { status: 400, headers: { "Content-Type": "application/json" } });
      const first = frames.length === 1 || repeat;
      return new Response(JSON.stringify({
        id: `completion-${frames.length}`, object: "chat.completion", created: 0, model: "deepseek-test",
        choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", message: {
          role: "assistant", content: first ? "I will write the test." : JSON.stringify({
            verdict: "no-bug", summary: "The existing meaningful test passes with target execution evidence.",
          }), ...(first ? { tool_calls: calls } : {}),
        } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const model = createTranslationVerifierChatModel({ apiKey: "test-key", request });
    const verify = createVerifier(createLangChainAgentHost({
      model, resolveToolContext: fixture.resolveToolContext,
      limits: { maxTurns: 2, ...(turnLimit ? { maxToolCallsPerTurn: turnLimit } : {}) },
    }));

    if (turnLimit) {
      await expect(verify(fixture.input, "single-agent", "verify")).rejects.toThrow("per-turn limit");
      expect(await readFile(join(fixture.root, TEST_PATH), "utf8")).toBe(originalTest);
      expect(frames).toHaveLength(1);
      return;
    }
    if (omitId || repeat) {
      await expect(verify(fixture.input, "single-agent", "verify")).rejects.toThrow(omitId ? "unique IDs" : "Model call limits exceeded");
      expect(await readFile(join(fixture.root, TEST_PATH), "utf8")).toBe(originalTest);
      expect(frames).toHaveLength(omitId ? 1 : 2);
      return;
    }

    const result = await verify(fixture.input, "single-agent", "verify");

    expect(result.status).toBe("success");
    expect(await readFile(join(fixture.root, TEST_PATH), "utf8")).toBe(originalTest);
    expect(frames).toHaveLength(2);
    const feedback = frames[1]!.filter(message => message.role === "tool");
    expect(feedback.map(message => message.tool_call_id).sort()).toEqual(calls.map(call => call.id).sort());
    expect(JSON.stringify(feedback)).toContain("invalid");
    expect(JSON.stringify(feedback)).toContain("not executed");
  });
});
