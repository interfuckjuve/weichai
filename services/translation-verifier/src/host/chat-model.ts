import { ChatOpenAI } from "@langchain/openai";
import type {
  TranslationVerifierApiKey,
  TranslationVerifierRequestRetry,
} from "./model-client.js";

/** Keep these aligned with the legacy adapter defaults. */
const DEFAULT_API_BASE = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const DEFAULT_MAX_REQUEST_ATTEMPTS = 3;

export type TranslationVerifierChatModelOptions = {
  apiKey: TranslationVerifierApiKey;
  apiBase?: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  request?: typeof globalThis.fetch;
  /** Total HTTP attempts kept for parity with the legacy adapter; the SDK owns the retry loop. */
  requestRetry?: TranslationVerifierRequestRetry;
};

const MAX_REQUEST_ATTEMPTS = 10;

/**
 * Build the framework chat model for the LangChain Host.
 *
 * The OpenAI-compatible DeepSeek endpoint is configured through the official
 * SDK client options: base URL, optional fetch implementation, and retries.
 * Retries stay in the SDK so the application does not retry the same request
 * twice; the exact backoff interval is refined separately.
 */
export function createTranslationVerifierChatModel(
  options: TranslationVerifierChatModelOptions,
): ChatOpenAI {
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE)
    .replace(/\/+$/, "");
  const maxAttempts = options.requestRetry?.maxAttempts
    ?? DEFAULT_MAX_REQUEST_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_REQUEST_ATTEMPTS) {
    throw new Error("requestRetry.maxAttempts must be an integer between 1 and 10.");
  }
  const apiKey = options.apiKey;

  return new ChatOpenAI({
    apiKey: typeof apiKey === "function"
      ? async () => apiKey()
      : apiKey,
    model: options.model ?? DEFAULT_MODEL,
    maxTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    configuration: {
      baseURL: apiBase,
      maxRetries: maxAttempts - 1,
      ...(options.request ? { fetch: options.request } : {}),
    },
    modelKwargs: { thinking: { type: "disabled" } },
  });
}
