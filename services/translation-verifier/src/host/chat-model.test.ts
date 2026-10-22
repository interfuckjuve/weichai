import { describe, expect, it } from "vitest";
import { createTranslationVerifierChatModel } from "./chat-model.js";

const completion = {
  id: "completion-1",
  object: "chat.completion",
  created: 0,
  model: "deepseek-test",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function recordingFetch(responses: Response[]) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const response = responses.shift();
    if (response === undefined) throw new Error("No scripted HTTP response remains.");
    return response;
  }) as typeof globalThis.fetch;
  return { calls, request };
}

describe("createTranslationVerifierChatModel", () => {
  it("maps the current verifier model configuration onto the framework chat model", async () => {
    const { calls, request } = recordingFetch([
      new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } }),
    ]);
    const model = createTranslationVerifierChatModel({
      apiKey: "sk-verifier-secret",
      apiBase: "https://example.test/v1/",
      model: "deepseek-test",
      maxOutputTokens: 123,
      request,
    });

    await expect(model.invoke("hello")).resolves.toMatchObject({ content: "ok" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-verifier-secret");
    expect(calls[0]!.body).toMatchObject({
      model: "deepseek-test",
      max_tokens: 123,
      thinking: { type: "disabled" },
    });
    expect(JSON.stringify(calls[0]!.body)).not.toContain("sk-verifier-secret");
  });

  it("keeps transient HTTP retries inside the SDK", async () => {
    const { calls, request } = recordingFetch([
      new Response("temporary", { status: 500 }),
      new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } }),
    ]);
    const model = createTranslationVerifierChatModel({ apiKey: "key", request });

    await expect(model.invoke("hello")).resolves.toMatchObject({ content: "ok" });
    expect(calls).toHaveLength(2);
  });
});
