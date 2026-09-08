import { markVerificationPhase } from "../run-output/measure-legacy-run.js";
import type { VerificationStrategyFactory } from "./select-strategy.js";
import { assertVerificationInput } from "../schemas/validate-verification-input.js";
import { type VerificationInput, type VerificationStrategyProvider } from "../schemas/verification-types.js";

export function validateInput(
  input: VerificationInput,
  factory: VerificationStrategyFactory,
  strategyId: string,
): VerificationStrategyProvider {
  markVerificationPhase("request-validation-and-strategy-selection");
  assertVerificationInput(input);
  return factory.resolve(strategyId);
}
