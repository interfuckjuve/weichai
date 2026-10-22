import { ChatOpenAI } from "@langchain/openai";

/** Credential is a caller-owned value or a late resolver; it never becomes prompt text. */
export type TranslationVerifierApiKey = string | (() => string);

/** Total transport attempts and delay for one model request. */
export type TranslationVerifierRequestRetry = {
  maxAttempts?: number;
  delayMs?: number;
};

/** Keep these aligned with the legacy adapter defaults. */
const DEFAULT_API_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 750;
const MAX_REQUEST_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Transient failures the one transport retry loop may repeat. This mirrors the
 * legacy adapter so behaviour does not change during the migration.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type TranslationVerifierChatModelOptions = {
  apiKey: TranslationVerifierApiKey;
  apiBase?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  request?: typeof globalThis.fetch;
  /** Total transport attempts for one model call; the transport owns the only retry loop. */
  requestRetry?: TranslationVerifierRequestRetry;
};

/**
 * Build the framework chat model for the LangChain Host.
 *
 * The OpenAI-compatible DeepSeek endpoint is configured through the official
 * SDK client options, but every framework/SDK retry layer is disabled:
 * ChatOpenAI's outer AsyncCaller and the OpenAI client both stay at zero
 * retries. The injected fetch wrapper is the single place that performs the
 * existing "at most 3 attempts, 750ms apart" policy, so retries never stack and
 * one request stays one Agent decision round.
 */
export function createTranslationVerifierChatModel(
  options: TranslationVerifierChatModelOptions,
): ChatOpenAI {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const retry = normalizeRequestRetry(options.requestRetry);
  const transport = options.request ?? globalThis.fetch.bind(globalThis);
  const request = createRetryingFetch(transport, retry);
  const apiKey = options.apiKey;

  return new ChatOpenAI({
    apiKey: typeof apiKey === "function" ? async () => apiKey() : apiKey,
    model: options.model ?? DEFAULT_MODEL,
    maxTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    // ChatOpenAI defaults its outer AsyncCaller to six retries; disable it.
    maxRetries: 0,
    configuration: {
      baseURL: apiBase,
      // The official SDK defaults to two retries; disable it explicitly.
      maxRetries: 0,
      fetch: request,
    },
    modelKwargs: { thinking: { type: "disabled" } },
  });
}

type NormalizedRetry = { maxAttempts: number; delayMs: number };

function normalizeRequestRetry(
  value: TranslationVerifierRequestRetry | undefined,
): NormalizedRetry {
  const maxAttempts = value?.maxAttempts ?? DEFAULT_MAX_REQUEST_ATTEMPTS;
  const delayMs = value?.delayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_REQUEST_ATTEMPTS ||
    !Number.isInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > MAX_RETRY_DELAY_MS
  ) {
    throw new Error("Invalid translation verifier model request retry options.");
  }
  return { maxAttempts, delayMs };
}

/**
 * Wrap the transport used by the OpenAI SDK with the verifier's transient
 * retry policy. It is the only retry loop in the model path.
 */
function createRetryingFetch(
  request: typeof globalThis.fetch,
  retry: NormalizedRetry,
): typeof globalThis.fetch {
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    for (let attempt = 1; ; attempt += 1) {
      // Cancellation can arrive between attempts or while a zero delay resolves.
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request was aborted.");
      }
      let response: Response;
      try {
        response = await request(input, init);
      } catch (error) {
        if (isAbort(signal, error)) throw abortReason(signal, error);
        if (attempt >= retry.maxAttempts) throw error;
        await delay(retry.delayMs, signal);
        continue;
      }
      if (
        response.ok ||
        attempt >= retry.maxAttempts ||
        !RETRYABLE_STATUS.has(response.status)
      ) {
        return response;
      }
      // Release the connection before waiting for the next attempt.
      void response.body?.cancel().catch(() => undefined);
      await delay(retry.delayMs, signal);
    }
  };
}

function isAbort(signal: AbortSignal | null | undefined, error: unknown): boolean {
  if (signal?.aborted) return true;
  return typeof error === "object" && error !== null &&
    "name" in error && (error as { name?: unknown }).name === "AbortError";
}

function abortReason(signal: AbortSignal | null | undefined, error: unknown): unknown {
  if (signal?.aborted && signal.reason !== undefined) return signal.reason;
  if (error !== undefined) return error;
  return new Error("Model request was aborted.");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Model request was aborted.");
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Model request was aborted."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
