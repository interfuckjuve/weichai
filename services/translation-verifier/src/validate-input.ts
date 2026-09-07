import { markVerificationPhase } from "./verification-timing.js";
import type { VerificationStrategyFactory } from "./verification-strategy-factory.js";
import {
  assertVerificationInput,
  type VerificationInput,
  type VerificationStrategyDescriptor,
} from "./verification-types.js";

export function validateInput(
  input: VerificationInput,
  factory: VerificationStrategyFactory,
  strategyId: string,
): VerificationStrategyDescriptor {
  markVerificationPhase("request-validation-and-strategy-selection");
  assertVerificationInput(input);
  const descriptor = factory.list().find((item) => item.id === strategyId);
  if (descriptor === undefined) {
    factory.create(strategyId);
    throw new Error(`Unknown verification strategy: ${strategyId}`);
  }
  return descriptor;
}

export function preflightStrategy(
  input: VerificationInput,
  factory: VerificationStrategyFactory,
  strategyId: string,
) {
  const strategy = factory.create(strategyId);
  return { strategy, output: strategy.preflight?.(input) };
}
