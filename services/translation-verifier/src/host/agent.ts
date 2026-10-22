import type {
  AgentTaskContext,
  HostToolFactory,
} from "./tools/common.js";

export type { AgentTaskContext, ToolRuntimeContext } from "./tools/common.js";

export type AgentToolFactory = HostToolFactory;

/**
 * One Agent call: the Host prompt plus the tool capabilities the strategy
 * selected. The Agent ends the call by answering without a tool call.
 */
export type AgentTask = {
  taskContext: AgentTaskContext;
  systemPrompt: string;
  userPrompt: string;
  tools: readonly AgentToolFactory[];
};

export type AgentRunLimits = {
  maxDurationMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxToolCallsPerTurn: number;
  maxContextCharacters: number;
  maxResponseCharacters: number;
};

export const DEFAULT_AGENT_RUN_LIMITS: Readonly<AgentRunLimits> = {
  // Verification commonly needs inspect -> write -> compile/test -> repair.
  // Keep these limits finite, but do not make a normal repair cycle look like
  // an Agent failure simply because the first generated test needs a fix.
  maxDurationMs: 600_000,
  maxTurns: 48,
  maxToolCalls: 320,
  maxToolCallsPerTurn: 16,
  maxContextCharacters: 1_500_000,
  maxResponseCharacters: 1_100_000,
};

/**
 * A run failed for an operational reason, not because verification found a
 * production defect. Callers can classify these without parsing messages.
 * `budget` also covers time/model/tool/context exhaustion.
 */
export type AgentRunFailureReason = "budget" | "context" | "model";

export class AgentRunFailure extends Error {
  readonly name = "AgentRunFailure";

  constructor(
    readonly reason: AgentRunFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type AgentRunBudget = {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  assertActive(): void;
  remainingMs(): number;
  dispose(): void;
};

export function createAgentRunBudget(
  supplied: Partial<AgentRunLimits> = {},
  now = Date.now(),
  signal?: AbortSignal,
): AgentRunBudget {
  const limits = { ...DEFAULT_AGENT_RUN_LIMITS, ...supplied };
  validateAgentRunLimits(limits);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const deadlineAt = now + limits.maxDurationMs;
  const timer = setTimeout(() => {
    controller.abort(new Error("Agent run time budget exceeded."));
  }, limits.maxDurationMs);
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) throw new Error("Agent run budget is disposed.");
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? new Error("Agent run was aborted.");
    }
    if (Date.now() >= deadlineAt) {
      controller.abort(new Error("Agent run time budget exceeded."));
      throw controller.signal.reason;
    }
  };

  return {
    signal: controller.signal,
    deadlineAt,
    assertActive,
    remainingMs() {
      assertActive();
      return Math.max(0, deadlineAt - Date.now());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

export function validateAgentRunLimits(limits: AgentRunLimits): void {
  if (
    !Number.isInteger(limits.maxDurationMs) ||
    limits.maxDurationMs <= 0 ||
    !Number.isInteger(limits.maxTurns) ||
    limits.maxTurns <= 0 ||
    !Number.isInteger(limits.maxToolCalls) ||
    limits.maxToolCalls <= 0 ||
    !Number.isInteger(limits.maxToolCallsPerTurn) ||
    limits.maxToolCallsPerTurn <= 0 ||
    limits.maxToolCallsPerTurn > limits.maxToolCalls ||
    !Number.isInteger(limits.maxContextCharacters) ||
    limits.maxContextCharacters <= 0 ||
    !Number.isInteger(limits.maxResponseCharacters) ||
    limits.maxResponseCharacters <= 0
  ) {
    throw new Error("Invalid Agent run limits.");
  }
}

export interface AgentHost<Result = unknown> {
  run(task: AgentTask): Result | Promise<Result>;
}
