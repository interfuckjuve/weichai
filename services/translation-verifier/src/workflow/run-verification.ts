import { randomUUID } from "node:crypto";
import {
  markVerificationPhase,
  withVerificationTimingRecorder,
} from "../run-output/measure-legacy-run.js";
import {
  createRunRecorder,
  stepFailureState,
  type StepHandle,
} from "../run-output/record-run.js";
import { validateInput } from "./validate-input.js";
import { createVerificationWorkspace } from "./prepare-strategy-workspace.js";
import { runStrategy } from "./run-strategy.js";
import {
  createVerificationArtifactStore,
  VerificationArtifactPersistenceError,
  type VerificationArtifactStore,
} from "../run-output/verification-artifact-store.js";
import { saveReport } from "./save-report.js";
import type { VerificationServiceConfiguration } from "../verification-service.js";
import { assertVerificationReceipt } from "../schemas/validate-verification-receipt.js";
import {
  createVerificationResult,
  createUnverifiedResult,
} from "../run-output/create-verification-result.js";
import { deriveCompatibilityStatus } from "../schemas/verification-assessment.js";
import { assertArtifactsMatch } from "../schemas/validate-verification-artifacts.js";
import type {
  VerificationInput,
  VerificationReceipt,
  VerificationResult,
} from "../schemas/verification-types.js";

/** The Host observes input, strategy execution and output, never strategy-private sequencing. */
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
    let saveHandle: StepHandle | undefined;
    let saveFailure: unknown;
    try {
      const strategyId = options.strategyId ?? config.defaultStrategyId;
      const descriptor = await recorder.measureStep(
        "validate-input",
        { scope: "framework" },
        () => validateInput(input, config.factory, strategyId),
      );
      store = createVerificationArtifactStore({
        artifactRoot: config.artifactRoot,
        durablePrefix: `attempt-${randomUUID()}`,
      });
      let artifactFailure = false;
      let normalizedFailure: VerificationResult | undefined;
      const result = await recorder
        .measureStep("execute-strategy", { scope: "framework" }, async () => {
          markVerificationPhase("workspace-creation");
          const workspace = await recorder.measureStep(
            "prepare-strategy-workspace",
            { scope: "framework" },
            () =>
              createVerificationWorkspace(input, {
                workspaceRoot: config.workspaceRoot,
                artifactRoot: config.artifactRoot,
                keepWorkspace: options.keepWorkspace,
              }),
          );
          store = workspace;
          markVerificationPhase("deadline-and-strategy-dispatch");
          const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
          const combinedSignal =
            signal === undefined
              ? timeoutSignal
              : AbortSignal.any([signal, timeoutSignal]);
          workspace.context.deadlineAt = Date.now() + config.timeoutMs;
          workspace.context.measureStep = (name, work) =>
            recorder.measureStep(name, { scope: "strategy" }, work);
          try {
            const output = await runStrategy(
              config.factory,
              strategyId,
              input,
              workspace.context,
              combinedSignal,
            );
            markVerificationPhase(
              "result-normalization-and-artifact-validation",
            );
            let normalized = createVerificationResult(
              input,
              descriptor,
              output,
              config.now,
            );
            if (combinedSignal.aborted) {
              const cancelled = signal?.aborted === true;
              const code = cancelled ? "cancelled" : "agent_timeout";
              const interrupted = {
                ...normalized,
                executionStatus: cancelled
                  ? ("cancelled" as const)
                  : normalized.executionStatus === "completed"
                    ? ("partial" as const)
                    : normalized.executionStatus,
                problems: normalized.problems.some(
                  (problem) => problem.code === code,
                )
                  ? normalized.problems
                  : [
                      ...normalized.problems,
                      {
                        code,
                        message: cancelled
                          ? signal.reason instanceof Error
                            ? signal.reason.message ||
                              "Verification cancelled by caller"
                            : "Verification cancelled by caller"
                          : "Verification strategy timed out",
                      } as const,
                    ],
              };
              normalized = createVerificationResult(
                input,
                descriptor,
                {
                  ...interrupted,
                  status: deriveCompatibilityStatus(interrupted),
                },
                config.now,
              );
            }
            assertArtifactsMatch(
              normalized.artifacts,
              workspace.writtenArtifacts(),
            );
            return normalized;
          } catch (error) {
            const failureError = signal?.aborted
              ? new DOMException(
                  signal.reason instanceof Error
                    ? signal.reason.message
                    : "Verification cancelled by caller",
                  "AbortError",
                )
              : error;
            artifactFailure =
              error instanceof VerificationArtifactPersistenceError;
            normalizedFailure = createUnverifiedResult(
              input,
              descriptor,
              failureError,
              artifactFailure ? [] : workspace.writtenArtifacts(),
              config.now,
              artifactFailure,
            );
            throw error;
          }
        })
        .catch((error: unknown) => {
          // Valid requests still receive a Host report when workspace setup or dispatch fails.
          return (
            normalizedFailure ??
            createUnverifiedResult(
              input,
              descriptor,
              error,
              store?.writtenArtifacts() ?? [],
              config.now,
            )
          );
        });
      saveHandle = recorder.startStep("save-report", { scope: "framework" });
      if (artifactFailure) {
        saveFailure = "Required artifact persistence failed.";
        return assertVerificationReceipt({ result }, input, descriptor);
      }
      try {
        const receipt = saveReport(result, input, descriptor, store!);
        receiptPersisted = true;
        return receipt;
      } catch (error) {
        saveFailure = error;
        if (!(error instanceof VerificationArtifactPersistenceError))
          throw error;
        // No retry: return the failure without inventing a canonical artifact.
        return assertVerificationReceipt(
          {
            result: createUnverifiedResult(
              input,
              descriptor,
              error,
              [],
              config.now,
              true,
            ),
          },
          input,
          descriptor,
        );
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // Cleanup remains measured output work even when no receipt can be produced.
      saveHandle ??= recorder.startStep("save-report", { scope: "framework" });
      const cleanup = recorder.startStep("workspace-cleanup", {
        scope: "framework",
        parentId: saveHandle?.id,
      });
      try {
        markVerificationPhase("workspace-cleanup");
        store?.cleanup({ discardArtifacts: !receiptPersisted });
        recorder.endStep(cleanup, "completed");
        markVerificationPhase("response-ready");
      } catch (error) {
        recorder.endStep(cleanup, stepFailureState(error), error);
        saveFailure ??= error;
        if (failure === undefined) throw error;
      } finally {
        recorder.endStep(
          saveHandle,
          saveFailure === undefined
            ? "completed"
            : stepFailureState(saveFailure),
          saveFailure,
        );
        recorder.finish();
      }
    }
  });
}
