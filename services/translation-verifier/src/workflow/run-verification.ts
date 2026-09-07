import { randomUUID } from "node:crypto";
import { markVerificationPhase, withVerificationTimingRecorder } from "../run-output/measure-legacy-run.js";
import { createRunRecorder } from "../run-output/record-run.js";
import { validateInput, preflightStrategy } from "./validate-input.js";
import { createVerificationWorkspace } from "./prepare-projects.js";
import { createVerificationArtifactStore, VerificationArtifactPersistenceError, type VerificationArtifactStore } from "../run-output/verification-artifact-store.js";
import { saveReport } from "./save-report.js";
import type { VerificationServiceConfiguration } from "../verification-service.js";
import { assertVerificationReceipt } from "../schemas/validate-verification-receipt.js";
import { createVerificationResult, createUnverifiedResult } from "../run-output/create-verification-result.js";
import { assertArtifactsMatch } from "../schemas/validate-verification-artifacts.js";
import { type VerificationInput, type VerificationReceipt, type VerificationResult, type VerificationStrategy, type VerificationStrategyOutput } from "../schemas/verification-types.js";

/** Host owns stages 1, 2 and 6; capable strategies own 3-5. Legacy verify runs in stage 4. */
export async function runVerification(
  config: VerificationServiceConfiguration,
  input: VerificationInput,
  options: { strategyId?: string; keepWorkspace?: boolean } = {},
  signal?: AbortSignal,
): Promise<VerificationReceipt> {
  const recorder = createRunRecorder({ runId: randomUUID() });
  return withVerificationTimingRecorder(recorder, async () => {
    let store:
      | Pick<
          VerificationArtifactStore,
          "writtenArtifacts" | "writeFrameworkResult" | "cleanup"
        >
      | undefined;
    let receiptPersisted = false;
    let failure: unknown;
    const closeExecution = (error?: unknown): void => {
      for (const stage of recorder.snapshot().stages.slice(0, 5)) {
        if (stage.state === "running")
          recorder.endStage(
            stage.id,
            isAbortError(error) ? "cancelled" : "failed",
            error,
          );
        else if (stage.state === "not-started")
          recorder.skipStage(stage.id, "Execution did not reach this stage.");
      }
    };
    try {
      recorder.startStage("validate-input");
      const strategyId = options.strategyId ?? config.defaultStrategyId;
      const descriptor = validateInput(input, config.factory, strategyId);
      let strategy: VerificationStrategy | undefined;
      let output: VerificationStrategyOutput | undefined;
      let result: VerificationResult | undefined;
      let artifactFailure = false;
      // Caller cancellation historically bypasses provider creation, but still prepares the workspace.
      if (!signal?.aborted) {
        try {
          ({ strategy, output } = preflightStrategy(
            input,
            config.factory,
            strategyId,
          ));
          signal?.throwIfAborted();
          if (output !== undefined)
            result = createVerificationResult(
              input,
              descriptor,
              output,
              config.now,
            );
        } catch (error) {
          if (isAbortError(error)) throw error;
          recorder.endStage("validate-input", "failed", error);
          artifactFailure =
            error instanceof VerificationArtifactPersistenceError;
          result = createUnverifiedResult(
            input,
            descriptor,
            error,
            [],
            config.now,
            artifactFailure,
          );
        }
      }
      if (recorder.snapshot().stages[0].state === "running")
        recorder.endStage("validate-input", "completed");
      if (result !== undefined) {
        closeExecution();
        store = createVerificationArtifactStore({
          artifactRoot: config.artifactRoot,
          durablePrefix: "attempt-" + randomUUID(),
        });
        if (output !== undefined) {
          try {
            assertArtifactsMatch(result.artifacts, store.writtenArtifacts());
          } catch (error) {
            result = createUnverifiedResult(input, descriptor, error, [], config.now);
          }
        }
      } else {
        recorder.startStage("prepare-workspace");
        markVerificationPhase("workspace-creation");
        const workspace = createVerificationWorkspace(input, {
          workspaceRoot: config.workspaceRoot,
          artifactRoot: config.artifactRoot,
          keepWorkspace: options.keepWorkspace,
        });
        store = workspace;
        markVerificationPhase("deadline-and-strategy-dispatch");
        const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
        const combinedSignal =
          signal === undefined
            ? timeoutSignal
            : AbortSignal.any([signal, timeoutSignal]);
        workspace.context.deadlineAt = Date.now() + config.timeoutMs;
        try {
          strategy?.prepareWorkspace?.(input, workspace.context);
          recorder.endStage("prepare-workspace", "completed");
        } catch (error) {
          if (isAbortError(error)) throw error;
          recorder.endStage("prepare-workspace", "failed", error);
          artifactFailure =
            error instanceof VerificationArtifactPersistenceError;
          result = createUnverifiedResult(
            input,
            descriptor,
            error,
            artifactFailure ? [] : store.writtenArtifacts(),
            config.now,
            artifactFailure,
          );
        }
        if (result === undefined) {
          if (signal?.aborted && !isAbortError(signal.reason)) {
            result = createUnverifiedResult(
              input,
              descriptor,
              signal.reason,
              [],
              config.now,
            );
          } else {
            if (signal?.aborted)
              throw signal.reason ?? new Error("Caller aborted verification");
            try {
              if (!strategy!.recordsExecutionStages) {
                recorder.skipStage(
                  "prepare-agent-task",
                  "Legacy provider does not expose task preparation.",
                );
                recorder.startStage("run-agent-tests");
              }
              const strategyOutput = await waitForStrategy(
                strategy!.verify(input, workspace.context, combinedSignal),
                combinedSignal,
              );
              if (!strategy!.recordsExecutionStages) {
                recorder.endStage("run-agent-tests", "completed");
                recorder.skipStage(
                  "evaluate-evidence",
                  "Legacy provider does not expose evidence evaluation.",
                );
              }
              markVerificationPhase(
                "result-normalization-and-artifact-validation",
              );
              result = createVerificationResult(
                input,
                descriptor,
                strategyOutput,
                config.now,
              );
              assertArtifactsMatch(result.artifacts, store.writtenArtifacts());
            } catch (error) {
              closeExecution(error);
              if (isAbortError(error)) throw error;
              artifactFailure =
                error instanceof VerificationArtifactPersistenceError;
              result = createUnverifiedResult(
                input,
                descriptor,
                error,
                artifactFailure ? [] : store.writtenArtifacts(),
                config.now,
                artifactFailure,
              );
            }
          }
        }
        closeExecution();
      }
      recorder.startStage("save-report");
      if (artifactFailure) {
        recorder.endStage(
          "save-report",
          "failed",
          "Required artifact persistence failed.",
        );
        return assertVerificationReceipt({ result }, input, descriptor);
      }
      try {
        const receipt = saveReport(result, input, descriptor, store);
        receiptPersisted = true;
        return receipt;
      } catch (error) {
        recorder.endStage("save-report", "failed", error);
        if (!(error instanceof VerificationArtifactPersistenceError))
          throw error;
        // No retry: the failure result is returned without an invented canonical artifact.
        return assertVerificationReceipt(
          {
            result: createUnverifiedResult(input, descriptor, error, [], config.now, true),
          },
          input,
          descriptor,
        );
      }
    } catch (error) {
      failure = error;
      closeExecution(error);
      throw error;
    } finally {
      // Cleanup is real save-report work even when the request cannot produce a receipt.
      if (recorder.snapshot().stages[5].state === "not-started")
        recorder.startStage("save-report");
      try {
        markVerificationPhase("workspace-cleanup");
        store?.cleanup({ discardArtifacts: !receiptPersisted });
        markVerificationPhase("response-ready");
        if (recorder.snapshot().stages[5].state === "running")
          recorder.endStage("save-report", "completed");
      } catch (error) {
        if (recorder.snapshot().stages[5].state === "running")
          recorder.endStage("save-report", "failed", error);
        if (failure === undefined) throw error;
      } finally {
        recorder.finish();
      }
    }
  });
}

function waitForStrategy<T>(
  strategyPromise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(
      signal.reason ??
        new DOMException("This operation was aborted", "AbortError"),
    );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void =>
      finish(() =>
        reject(
          signal.reason ??
            new DOMException("This operation was aborted", "AbortError"),
        ),
      );

    signal.addEventListener("abort", onAbort, { once: true });
    strategyPromise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error, "AbortError");
}

function isNamedError(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}
