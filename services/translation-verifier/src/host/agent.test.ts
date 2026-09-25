import { describe, expect, it } from "vitest";
import {
  createAgentRunBudget,
  DEFAULT_AGENT_RUN_LIMITS,
  validateAgentRunLimits,
} from "./agent.js";

describe("AgentRunBudget", () => {
  it("counts turns and tool calls within the configured limits", () => {
    const budget = createAgentRunBudget({
      maxDurationMs: 10_000,
      maxTurns: 2,
      maxToolCalls: 3,
      maxToolCallsPerTurn: 2,
    });
    try {
      budget.startTurn(2);
      budget.startTurn(1);
      expect(budget.turns).toBe(2);
      expect(budget.toolCalls).toBe(3);
      expect(() => budget.startTurn(0)).toThrow("2-turn budget");
    } finally {
      budget.dispose();
    }
  });

  it("rejects a model response above the per-turn call limit", () => {
    const budget = createAgentRunBudget({
      maxDurationMs: 10_000,
      maxTurns: 2,
      maxToolCalls: 10,
      maxToolCallsPerTurn: 2,
    });
    try {
      expect(() => budget.startTurn(3)).toThrow("maximum is 2");
    } finally {
      budget.dispose();
    }
  });

  it("rejects invalid limits and stops after disposal", () => {
    expect(() =>
      validateAgentRunLimits({
        ...DEFAULT_AGENT_RUN_LIMITS,
        maxToolCallsPerTurn: DEFAULT_AGENT_RUN_LIMITS.maxToolCalls + 1,
      }),
    ).toThrow("Invalid Agent run limits");

    const budget = createAgentRunBudget({ maxDurationMs: 10_000 });
    budget.dispose();
    expect(() => budget.assertActive()).toThrow("disposed");
  });
});
