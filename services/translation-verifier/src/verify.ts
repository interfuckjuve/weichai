import {
  createSingleAgentStrategy,
  type SingleAgentTerminalResult,
} from "./strategies/single-agent/strategy.js";
import type { AgentHost } from "./host/agent.js";
import type {
  VerificationInput,
  VerificationPhase,
  VerificationResult,
  VerificationStrategy,
} from "./types.js";

export type VerificationRunner = (
  input: VerificationInput,
  strategy: string,
  phase: VerificationPhase,
) => Promise<VerificationResult>;

/** Build the public runner and keep strategy registration inside the verifier. */
export function createVerifier(
  host: AgentHost<SingleAgentTerminalResult>,
): VerificationRunner {
  const strategies: Readonly<
    Record<string, VerificationStrategy<VerificationResult>>
  > = {
    "single-agent": createSingleAgentStrategy(host),
  };

  return async (input, strategyId, phase) => {
    const strategy = strategies[strategyId];
    if (strategy === undefined) {
      throw new Error(`Unknown verification strategy: ${strategyId}`);
    }

    const handler = strategy[phase];
    if (handler === undefined) {
      throw new Error(
        `Verification strategy ${strategyId} does not implement phase: ${phase}`,
      );
    }
    return handler(input);
  };
}
