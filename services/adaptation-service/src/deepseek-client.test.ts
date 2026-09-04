import { describe, expect, it, vi } from "vitest";
import { chatCompletionContent, completeWithDeepSeek, completeWithDeepSeekTools } from "./deepseek-client";

describe("DeepSeek chat-completions client", () => {
  it("uses the chat-completions endpoint and keeps caller-supplied messages intact", async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "completed" } }],
    }), { status: 200 }));

    await expect(
      completeWithDeepSeek(
        [
          { role: "system", content: "Keep the target contract." },
          { role: "user", content: "Translate this method." },
        ],
        {
          apiKey: "test-key",
          modelConfig: { apiBase: "https://api.deepseek.test/v1", model: "deepseek-test" },
          request: request as unknown as typeof globalThis.fetch,
          temperature: 0,
          jsonMode: true,
        },
      ),
    ).resolves.toBe("completed");

    expect(request).toHaveBeenCalledWith(
      "https://api.deepseek.test/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const init = request.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "deepseek-test",
      messages: [
        { role: "system", content: "Keep the target contract." },
        { role: "user", content: "Translate this method." },
      ],
      thinking: { type: "disabled" },
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("reads chat completion content and reports provider failures", async () => {
    expect(chatCompletionContent({ choices: [{ message: { content: " direct text " } }] })).toBe("direct text");
    expect(chatCompletionContent({ choices: [] })).toBeNull();

    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response("invalid key", { status: 401 }));
    await expect(
      completeWithDeepSeek(
        [{ role: "user", content: "Translate this method." }],
        { apiKey: "test-key", request: request as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow("DeepSeek API error 401: invalid key");
  });

  it("serializes declared functions and returns provider tool calls without executing them", async () => {
    const request = vi.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: {
        content: null,
        tool_calls: [{ id: "call-search", type: "function", function: {
          name: "search_symbols",
          arguments: '{"query":"QuoteService"}',
        } }],
      } }],
    }), { status: 200 }));

    await expect(completeWithDeepSeekTools(
      [{ role: "user", content: "Find the quote service." }],
      [{
        name: "search_symbols",
        description: "Search a revision.",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      }],
      {
        apiKey: "test-key",
        modelConfig: { apiBase: "https://api.deepseek.test/v1", model: "deepseek-test" },
        request: request as unknown as typeof globalThis.fetch,
        temperature: 0,
      },
    )).resolves.toEqual({
      toolCalls: [{ id: "call-search", name: "search_symbols", arguments: '{"query":"QuoteService"}' }],
    });

    const init = request.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      tool_choice: "auto",
      tools: [{ type: "function", function: { name: "search_symbols" } }],
    });
  });
});
