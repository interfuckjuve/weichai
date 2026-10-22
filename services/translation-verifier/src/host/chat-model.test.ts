import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslationVerifierChatModel } from "./chat-model.js";

const completion = {
  id: "completion-1",
  object: "chat.completion",
  created: 0,
  model: "deepseek-test",
  choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function recordingFetch(responses: Array<Response | Error | (() => Response)>) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const response = responses.shift();
    if (response === undefined) throw new Error("No scripted HTTP response remains.");
    if (response instanceof Error) throw response;
    return typeof response === "function" ? response() : response;
  }) as typeof globalThis.fetch;
  return { calls, request };
}

function okResponse(): Response {
  return new Response(JSON.stringify(completion), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createTranslationVerifierChatModel", () => {
  it("maps the current verifier model configuration onto the framework chat model", async () => {
    const { calls, request } = recordingFetch([okResponse()]);
    const model = createTranslationVerifierChatModel({
      apiKey: "sk-verifier-secret",
      apiBase: "https://example.test/v1/",
      model: "deepseek-test",
      maxOutputTokens: 123,
      request,
    });
    expect((model as unknown as { caller: { maxRetries: number } }).caller.maxRetries).toBe(0);

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

  it("retries a successful request after one transient failure", async () => {
    const { calls, request } = recordingFetch([
      new Response("temporary", { status: 500 }),
      okResponse(),
    ]);
    const model = createTranslationVerifierChatModel({
      apiKey: "key",
      request,
      requestRetry: { delayMs: 0 },
    });

    await expect(model.invoke("hello")).resolves.toMatchObject({ content: "ok" });
    expect(calls).toHaveLength(2);
  });

  it("makes exactly three attempts 750ms apart for consecutive transient failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const { calls, request } = recordingFetch([
      new Response("temporary", { status: 500 }),
      new Response("temporary", { status: 500 }),
      new Response("temporary", { status: 500 }),
    ]);
    const model = createTranslationVerifierChatModel({ apiKey: "key", request });

    const settled = model.invoke("hello").catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    // Three total attempts, not three attempts repeated by an outer retry layer.
    expect(calls).toHaveLength(3);
    expect(Date.now()).toBe(1_500);
  });

  it("does not retry a non-retryable status", async () => {
    const { calls, request } = recordingFetch([
      new Response("bad request", { status: 400 }),
      okResponse(),
    ]);
    const model = createTranslationVerifierChatModel({ apiKey: "key", request });

    await expect(model.invoke("hello")).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("stops retrying as soon as the request is cancelled", async () => {
    vi.useFakeTimers();
    const { calls, request } = recordingFetch([
      new Response("temporary", { status: 500 }),
      okResponse(),
    ]);
    const model = createTranslationVerifierChatModel({ apiKey: "key", request });
    const controller = new AbortController();
    const cancelled = new Error("cancelled during retry");

    const settled = model.invoke("hello", { signal: controller.signal }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(cancelled);
    await vi.runAllTimersAsync();

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
    expect(calls).toHaveLength(1);
  });
});
