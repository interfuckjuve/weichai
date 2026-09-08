import type { VerificationStrategyFactory } from "./select-strategy.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
  VerificationStrategyOutput,
} from "../schemas/verification-types.js";

export async function runStrategy(
  factory: VerificationStrategyFactory,
  strategyId: string,
  input: VerificationInput,
  context: VerificationStrategyContext,
  signal: AbortSignal,
): Promise<VerificationStrategyOutput> {
  signal.throwIfAborted();
  const strategy = factory.create(strategyId);
  signal.throwIfAborted();
  return waitForStrategy(strategy.verify(input, context, signal), signal);
}

function waitForStrategy<T>(
  strategyPromise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  // Always consume the promise, including synchronous caller cancellation during verify().
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(abortTimer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      // Allow cooperative strategies to validate and persist partial reports, without waiting indefinitely.
      abortTimer ??= setTimeout(
        () =>
          finish(() =>
            reject(
              signal.reason ??
                new DOMException("This operation was aborted", "AbortError"),
            ),
          ),
        250,
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    strategyPromise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}
