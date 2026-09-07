import { createDifferentialSmokeProvider, type DifferentialSmokeStrategyOptions, DIFFERENTIAL_SMOKE_STRATEGY } from "./strategies/differential-smoke.js";
import { VerificationService, type VerificationServiceOptions } from "./verification-service.js";
import { VerificationStrategyFactory } from "./strategies/strategy-registry.js";

export type VerificationServiceRuntimeOptions = Pick<
  VerificationServiceOptions,
  "workspaceRoot" | "artifactRoot" | "timeoutMs" | "now" | "runRoot" | "debug" | "onRunRecorded"
>;

export function createDefaultVerificationService(
  options: DifferentialSmokeStrategyOptions & VerificationServiceRuntimeOptions = {},
): VerificationService {
  const factory = new VerificationStrategyFactory([
    createDifferentialSmokeProvider(options),
  ]);
  return new VerificationService({
    factory,
    defaultStrategyId: DIFFERENTIAL_SMOKE_STRATEGY.id,
    ...runtimeOptions(options),
  });
}

function runtimeOptions(options: VerificationServiceRuntimeOptions): VerificationServiceRuntimeOptions {
  return {
    ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.artifactRoot !== undefined ? { artifactRoot: options.artifactRoot } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.runRoot !== undefined ? { runRoot: options.runRoot } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
    ...(options.onRunRecorded !== undefined ? { onRunRecorded: options.onRunRecorded } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
}
