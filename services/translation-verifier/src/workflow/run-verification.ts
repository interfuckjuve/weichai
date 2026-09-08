import { randomUUID } from "node:crypto";
import {
  markVerificationPhase,
  withVerificationTimingRecorder,
} from "../run-output/measure-legacy-run.js";
import {
  createRunRecorder,
  stepFailureState,
  withStepContext,
  type StepHandle,
} from "../run-output/record-run.js";
import { validateInput } from "./validate-input.js";
import { createVerificationWorkspace } from "./prepare-strategy-workspace.js";
import { runStrategy, strategyExecutionFailure } from "./run-strategy.js";
import {
  createVerificationArtifactStore,
  VerificationArtifactPersistenceError,
  type VerificationArtifactStore,
} from "../run-output/verification-artifact-store.js";
import { saveReport } from "./save-report.js";
import type { VerificationServiceConfiguration } from "../verification-service.js";
import { assertVerificationReceipt } from "../schemas/validate-verification-receipt.js";
import { createVerificationResult } from "../schemas/materialize-verification-result.js";
import { createFailureResult } from "../run-output/create-failure-result.js";
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
      | Pick<VerificationArtifactStore, "writtenArtifacts" | "writeFrameworkResult" | "cleanup">
      | undefined;
    let receiptPersisted = false;
    let failure: unknown;
    let saveHandle: StepHandle | undefined;
    let saveFailure: unknown;
    try {
      const strategyId = options.strategyId ?? config.defaultStrategyId;
      const provider = await recorder.measureStep(
        "validate-input",
        { scope: "framework" },
        () => validateInput(input, config.factory, strategyId),
      );
      const executeHandle = recorder.startStep("execute-strategy", { scope: "framework" });
      const outcome = await withStepContext(recorder, executeHandle, async () => {
        try {
          markVerificationPhase("workspace-creation");
          const workspace = await recorder.measureStep(
            "prepare-strategy-workspace",
            { scope: "framework" },
            () => createVerificationWorkspace(input, {
              workspaceRoot: config.workspaceRoot,
              artifactRoot: config.artifactRoot,
              keepWorkspace: options.keepWorkspace,
            }),
          );
          store = workspace;
          markVerificationPhase("deadline-and-strategy-dispatch");
          const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
          const combinedSignal = signal === undefined
            ? timeoutSignal
            : AbortSignal.any([signal, timeoutSignal]);
          workspace.context.deadlineAt = Date.now() + config.timeoutMs;
          workspace.context.measureStep = (name, work) =>
            recorder.measureStep(name, { scope: "strategy" }, work);
          return await runStrategy(
            provider,
            input,
            workspace.context,
            combinedSignal,
            workspace.writtenArtifacts,
            signal,
          );
        } catch (error) {
          return strategyExecutionFailure(error, signal);
        }
      });
      // Valid requests still receive an isolated Host report if workspace preparation failed.
      store ??= createVerificationArtifactStore({
        artifactRoot: config.artifactRoot,
        durablePrefix: `attempt-${randomUUID()}`,
      });
      const { descriptor } = provider;
      let result: VerificationResult;
      try {
        result = outcome.kind === "output"
          ? createVerificationResult(input, descriptor, outcome.output, config.now)
          : createFailureResult(
              input,
              descriptor,
              outcome.error,
              outcome.discardArtifacts ? [] : store.writtenArtifacts(),
              config.now,
              outcome.discardArtifacts,
            );
      } catch (error) {
        recorder.endStep(executeHandle, stepFailureState(error), error);
        throw error;
      }
      recorder.endStep(
        executeHandle,
        outcome.kind === "failure" ? stepFailureState(outcome.error) : "completed",
        outcome.kind === "failure" ? outcome.error : undefined,
      );
      saveHandle = recorder.startStep("save-report", { scope: "framework" });
      if (outcome.kind === "failure" && outcome.discardArtifacts) {
        saveFailure = "Required artifact persistence failed.";
        return assertVerificationReceipt({ result }, input, descriptor);
      }
      try {
        const receipt = saveReport(result, input, descriptor, store);
        receiptPersisted = true;
        return receipt;
      } catch (error) {
        saveFailure = error;
        if (!(error instanceof VerificationArtifactPersistenceError)) throw error;
        // No retry: return the failure without inventing a canonical artifact.
        return assertVerificationReceipt(
          { result: createFailureResult(input, descriptor, error, [], config.now, true) },
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
          saveFailure === undefined ? "completed" : stepFailureState(saveFailure),
          saveFailure,
        );
        recorder.finish();
      }
    }
  });
}
