import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import { VerificationArtifactPersistenceError } from "../run-output/verification-artifact-store.js";
import { normalizeVerificationStrategyOutput } from "../schemas/materialize-verification-result.js";
import { assertArtifactsMatch } from "../schemas/validate-verification-artifacts.js";
import {
  assertSchema,
  validateStrategyOutputSchema,
} from "../schemas/compile-schema-validators.js";
import { assertVerificationAssessment } from "../schemas/verification-assessment.js";
import type {
  VerificationInput,
  VerificationStrategyContext,
  VerificationStrategyOutput,
  VerificationStrategyProvider,
  VerificationArtifact,
  VerificationPreparation,
} from "../schemas/verification-types.js";

export type StrategyExecutionOutcome =
  | { kind: "output"; output: VerificationStrategyOutput }
  | {
      kind: "failure";
      error: unknown;
      discardArtifacts: boolean;
      shutdownConfirmed: boolean;
    };

export async function runStrategy(
  provider: VerificationStrategyProvider,
  input: VerificationInput,
  context: VerificationStrategyContext,
  signal: AbortSignal,
  writtenArtifacts: () => VerificationArtifact[],
  callerSignal?: AbortSignal,
  shutdownTimeoutMs = 5_000,
  preparation?: VerificationPreparation,
): Promise<StrategyExecutionOutcome> {
  try {
    signal.throwIfAborted();
    const execution = (() => {
      if (provider.lifecycle === "two-phase") {
        const strategy = provider.create();
        signal.throwIfAborted();
        return strategy.verifyTranslation(input, context, preparation, signal);
      }
      const strategy = provider.create();
      signal.throwIfAborted();
      return strategy.verify(input, context, signal);
    })();
    const settled = await waitForStrategy(execution, signal, shutdownTimeoutMs);
    if (!settled.confirmed) {
      return {
        ...strategyExecutionFailure(signal.reason, callerSignal),
        shutdownConfirmed: false,
      };
    }
    const rawOutput = settled.value;
    markVerificationPhase("result-normalization-and-artifact-validation");
    const output = normalizeVerificationStrategyOutput(input, rawOutput);
    if (signal.aborted || callerSignal?.aborted) {
      normalizeStrategyInterruption(
        { kind: "output", output },
        signal,
        callerSignal,
      );
      assertSchema(validateStrategyOutputSchema, output, "Verification result");
      assertVerificationAssessment(output, input);
    }
    assertArtifactsMatch(output.artifacts, writtenArtifacts());
    return { kind: "output", output };
  } catch (error) {
    return strategyExecutionFailure(error, callerSignal);
  }
}

/** Recheck Host interruption without rebuilding findings or losing artifact-disposal requirements. */
export function normalizeStrategyInterruption(
  outcome: StrategyExecutionOutcome,
  signal?: AbortSignal,
  callerSignal?: AbortSignal,
): StrategyExecutionOutcome {
  if (outcome.kind === "failure") {
    return callerSignal?.aborted
      ? { ...outcome, error: callerCancellation(callerSignal) }
      : outcome;
  }
  if (!signal?.aborted && !callerSignal?.aborted) return outcome;
  const { output } = outcome;
  const cancelled = callerSignal?.aborted === true;
  const code = cancelled ? "cancelled" : "agent_timeout";
  output.executionStatus = cancelled
    ? "cancelled"
    : output.executionStatus === "completed"
      ? "partial"
      : output.executionStatus;
  if (!output.problems.some((problem) => problem.code === code)) {
    output.problems.push({
      code,
      message: cancelled
        ? callerCancellation(callerSignal).message
        : "Verification strategy timed out",
    });
  }
  return outcome;
}

/** Also used for Host failures before a strategy workspace is available. */
export function strategyExecutionFailure(
  error: unknown,
  callerSignal?: AbortSignal,
): Extract<StrategyExecutionOutcome, { kind: "failure" }> {
  return {
    kind: "failure",
    error: callerSignal?.aborted ? callerCancellation(callerSignal) : error,
    discardArtifacts: error instanceof VerificationArtifactPersistenceError,
    shutdownConfirmed: true,
  };
}

function callerCancellation(signal: AbortSignal): DOMException {
  return new DOMException(
    signal.reason instanceof Error && signal.reason.message
      ? signal.reason.message
      : "Verification cancelled by caller",
    "AbortError",
  );
}

export function waitForStrategy<T>(
  strategyPromise: Promise<T>,
  signal: AbortSignal,
  shutdownTimeoutMs: number,
): Promise<{ confirmed: true; value: T } | { confirmed: false }> {
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
      // Expiry ends the Host wait, not the strategy's resource ownership.
      abortTimer ??= setTimeout(
        () => finish(() => resolve({ confirmed: false })),
        shutdownTimeoutMs,
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    strategyPromise.then(
      (value) => finish(() => resolve({ confirmed: true, value })),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}
