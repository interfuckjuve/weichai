import type { VerificationSubject } from "../types.js";
import type {
  AgentTaskContext,
  HostToolFactory,
} from "./tools/common.js";

export type { VerificationSubject } from "../types.js";
export type { AgentTaskContext, ToolRuntimeContext } from "./tools/common.js";

export type AgentToolFactory = HostToolFactory;

export type AgentTask = {
  subject: VerificationSubject;
  taskContext: AgentTaskContext;
  systemPrompt: string;
  userPrompt: string;
  tools: readonly AgentToolFactory[];
  terminalTools: readonly string[];
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
  maxDurationMs: 300_000,
  maxTurns: 50,
  maxToolCalls: 200,
  maxToolCallsPerTurn: 16,
  maxContextCharacters: 250_000,
  maxResponseCharacters: 1_100_000,
};

export type AgentRunBudget = {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  readonly turns: number;
  readonly toolCalls: number;
  startTurn(toolCalls: number): void;
  addToolCalls(toolCalls: number): void;
  assertActive(): void;
  remainingMs(): number;
  dispose(): void;
};

export function createAgentRunBudget(
  supplied: Partial<AgentRunLimits> = {},
  now = Date.now(),
): AgentRunBudget {
  const limits = { ...DEFAULT_AGENT_RUN_LIMITS, ...supplied };
  validateAgentRunLimits(limits);
  const controller = new AbortController();
  const deadlineAt = now + limits.maxDurationMs;
  const timer = setTimeout(() => {
    controller.abort(new Error("Agent run time budget exceeded."));
  }, limits.maxDurationMs);
  let turns = 0;
  let toolCalls = 0;
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
    get turns() {
      return turns;
    },
    get toolCalls() {
      return toolCalls;
    },
    startTurn(count) {
      assertActive();
      if (turns >= limits.maxTurns) {
        throw new Error(`Agent exhausted its ${limits.maxTurns}-turn budget.`);
      }
      validateToolCallCount(count, limits.maxToolCallsPerTurn);
      if (toolCalls + count > limits.maxToolCalls) {
        throw new Error(
          `Agent exhausted its ${limits.maxToolCalls}-tool-call budget.`,
        );
      }
      turns += 1;
      toolCalls += count;
    },
    addToolCalls(count) {
      assertActive();
      validateToolCallCount(count, limits.maxToolCallsPerTurn);
      if (toolCalls + count > limits.maxToolCalls) {
        throw new Error(
          `Agent exhausted its ${limits.maxToolCalls}-tool-call budget.`,
        );
      }
      toolCalls += count;
    },
    assertActive,
    remainingMs() {
      assertActive();
      return Math.max(0, deadlineAt - Date.now());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}

function validateToolCallCount(count: number, maximum: number): void {
  if (!Number.isInteger(count) || count < 0 || count > maximum) {
    throw new Error(
      `Agent turn tool-call budget exceeded: maximum is ${maximum}.`,
    );
  }
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
