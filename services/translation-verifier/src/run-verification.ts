import { randomUUID } from "node:crypto";
import {
  markVerificationPhase,
  withVerificationTimingRecorder,
} from "./verification-timing.js";
import { createRunRecorder } from "./record-run-events.js";
import { validateInput, preflightStrategy } from "./validate-input.js";
import { createVerificationWorkspace } from "./prepare-workspace.js";
import {
  createVerificationArtifactStore,
  VerificationArtifactPersistenceError,
  saveReport,
  type VerificationArtifactStore,
} from "./save-report.js";
import type { VerificationServiceConfiguration } from "./verification-service.js";
import {
  assertVerificationReceipt,
  createVerificationResult,
  type VerificationInput,
  type VerificationReceipt,
  type VerificationResult,
  type VerificationStrategy,
  type VerificationStrategyDescriptor,
  type VerificationStrategyOutput,
} from "./verification-types.js";

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
          result = unverified(
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
            result = unverified(input, descriptor, error, [], config.now);
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
          result = unverified(
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
            result = unverified(
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
              result = unverified(
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
            result: unverified(input, descriptor, error, [], config.now, true),
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

function unverified(
  input: VerificationInput,
  descriptor: VerificationStrategyDescriptor,
  error: unknown,
  artifacts: VerificationResult["artifacts"],
  now: () => string,
  artifactFailure = false,
): VerificationResult {
  const message = errorMessage(error);
  const timeout = isNamedError(error, "TimeoutError");
  const persistence =
    artifactFailure || error instanceof VerificationArtifactPersistenceError;

  return createVerificationResult(
    input,
    descriptor,
    {
      status: "unverified",
      summary: `Verification framework could not complete: ${message}`,
      issues: [
        {
          id: persistence
            ? "artifact-persistence-failed"
            : timeout
              ? "strategy-timeout"
              : "framework-error",
          kind: persistence
            ? "artifact-persistence-failed"
            : timeout
              ? "strategy-timeout"
              : "framework-error",
          message,
          evidenceArtifactIds: [],
        },
      ],
      artifacts,
      strategyReport: {
        frameworkError: message,
        errorName: errorName(error),
      },
    },
    now,
  );
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

function assertArtifactsMatch(
  resultArtifacts: VerificationResult["artifacts"],
  writtenArtifacts: VerificationResult["artifacts"],
): void {
  if (resultArtifacts.length !== writtenArtifacts.length) {
    throw new Error(
      "Verification result artifacts must match artifacts written through the workspace.",
    );
  }
  const writtenById = new Map<
    string,
    VerificationResult["artifacts"][number]
  >();
  for (const artifact of writtenArtifacts) {
    if (writtenById.has(artifact.id))
      throw new Error("Verification workspace artifact IDs must be unique.");
    writtenById.set(artifact.id, artifact);
  }
  for (const artifact of resultArtifacts) {
    const written = writtenById.get(artifact.id);
    if (
      written === undefined ||
      written.kind !== artifact.kind ||
      written.path !== artifact.path ||
      written.contentHash !== artifact.contentHash ||
      written.mediaType !== artifact.mediaType
    ) {
      throw new Error(
        "Verification result artifacts must match artifacts written through the workspace.",
      );
    }
  }
}

function isAbortError(error: unknown): boolean {
  return isNamedError(error, "AbortError");
}

function errorName(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string"
    ? error.name
    : "Error";
}

function errorMessage(error: unknown): string {
  if (isNamedError(error, "TimeoutError"))
    return "Verification strategy timed out";
  if (error instanceof Error && error.message.trim().length > 0)
    return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "Unknown verification error";
}

function isNamedError(error: unknown, name: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === name
  );
}
