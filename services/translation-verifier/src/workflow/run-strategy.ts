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
} from "../schemas/verification-types.js";

export type StrategyExecutionOutcome =
  | { kind: "output"; output: VerificationStrategyOutput }
  | { kind: "failure"; error: unknown; discardArtifacts: boolean };

export async function runStrategy(
  provider: VerificationStrategyProvider,
  input: VerificationInput,
  context: VerificationStrategyContext,
  signal: AbortSignal,
  writtenArtifacts: () => VerificationArtifact[],
  callerSignal?: AbortSignal,
): Promise<StrategyExecutionOutcome> {
  try {
    signal.throwIfAborted();
    const strategy = provider.create();
    signal.throwIfAborted();
    const rawOutput = await waitForStrategy(
      strategy.verify(input, context, signal),
      signal,
    );
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
