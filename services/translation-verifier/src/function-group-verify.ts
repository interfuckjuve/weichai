import {
  createRequirementFunctionGroupStrategy,
  createSingleAgentFunctionGroupStrategy,
  type SingleAgentFunctionGroupHostResult,
} from "./strategies/single-agent-function-group/strategy.js";
import type { AgentHost } from "./host/agent.js";
import type {
  FunctionGroupVerificationInput,
  FunctionGroupVerificationResult,
  FunctionGroupVerificationStrategy,
  RequirementFunctionGroupVerificationInput,
  VerificationPhase,
} from "./types.js";

export type FunctionGroupVerificationRunner = (
  input: FunctionGroupVerificationInput | RequirementFunctionGroupVerificationInput,
  strategy: "single-agent-function-group" | "requirement-function-group",
  phase: VerificationPhase,
) => Promise<FunctionGroupVerificationResult>;

function validateFunctionGroupInput(input: FunctionGroupVerificationInput): void {
  if (input.schemaVersion !== "3.1") throw new Error("Unsupported function-group verification schema version.");
  if (!input.functions.length) throw new Error("Function-group verification requires at least one function.");
  const targets = new Set<string>();
  for (const mapping of input.functions) {
    if (!mapping.source.path || !mapping.source.name || !mapping.target.path || !mapping.target.name) {
      throw new Error("Function-group verification functions require source and target paths and names.");
    }
    const key = `${mapping.target.path}\0${mapping.target.name}\0${mapping.target.signature ?? ""}`;
    if (targets.has(key)) throw new Error(`Duplicate target function in function group: ${mapping.target.path}#${mapping.target.name}`);
    targets.add(key);
  }
  const unmatched = input.unmatchedFunctions ?? [];
  const matchedTargets = new Set(input.functions.map(({ target }) => `${target.path}\0${target.name}\0${target.signature ?? ""}`));
  for (const target of unmatched) {
    const key = `${target.path}\0${target.name}\0${target.signature ?? ""}`;
    if (matchedTargets.has(key)) throw new Error(`Function appears in both matched and unmatched mappings: ${target.path}#${target.name}`);
  }
}

function validateRequirementFunctionGroupInput(input: RequirementFunctionGroupVerificationInput): void {
  if (input.schemaVersion !== "3.1" || input.mode !== "requirement") {
    throw new Error("Unsupported requirement function-group verification schema version.");
  }
  if (!input.functions.length) throw new Error("Requirement function-group verification requires at least one function.");
  const targets = new Set<string>();
  for (const mapping of input.functions) {
    if (!mapping.target.path || !mapping.target.name) {
      throw new Error("Requirement function-group verification functions require target paths and names.");
    }
    const key = `${mapping.target.path}\0${mapping.target.name}\0${mapping.target.signature ?? ""}`;
    if (targets.has(key)) throw new Error(`Duplicate target function in requirement function group: ${mapping.target.path}#${mapping.target.name}`);
    targets.add(key);
  }
}

export function createFunctionGroupVerifier(
  host: AgentHost<SingleAgentFunctionGroupHostResult>,
): FunctionGroupVerificationRunner {
  const strategies: Readonly<
    Record<string, FunctionGroupVerificationStrategy<FunctionGroupVerificationResult>>
  > = {
    "single-agent-function-group": createSingleAgentFunctionGroupStrategy(host),
    "requirement-function-group": createRequirementFunctionGroupStrategy(host),
  };

  return async (input, strategyId, phase) => {
    if (strategyId === "requirement-function-group") {
      validateRequirementFunctionGroupInput(input as RequirementFunctionGroupVerificationInput);
    } else {
      validateFunctionGroupInput(input as FunctionGroupVerificationInput);
    }
    const strategy = strategies[strategyId];
    if (strategy === undefined) {
      throw new Error(`Unknown function-group verification strategy: ${strategyId}`);
    }

    const handler = strategy[phase];
    if (handler === undefined) {
      throw new Error(
        `Function-group verification strategy ${strategyId} does not implement phase: ${phase}`,
      );
    }
    return (handler as (value: FunctionGroupVerificationInput | RequirementFunctionGroupVerificationInput) => FunctionGroupVerificationResult)(input);
  };
}
