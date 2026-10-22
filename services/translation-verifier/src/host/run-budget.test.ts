import { describe, expect, it } from "vitest";
import {
  createAgentRunBudget,
  DEFAULT_AGENT_RUN_LIMITS,
  validateAgentRunLimits,
} from "./run-budget.js";

describe("AgentRunBudget", () => {
  it('propagates project cancellation to model and test tool budgets', () => {
    const controller = new AbortController();
    const budget = createAgentRunBudget({}, Date.now(), controller.signal);
    try {
      controller.abort(new Error('project cancelled'));
      expect(budget.signal.aborted).toBe(true);
      expect(() => budget.assertActive()).toThrow('project cancelled');
    } finally { budget.dispose(); }
  });
  it("aborts when the run time budget expires", async () => {
    const budget = createAgentRunBudget({ maxDurationMs: 5 });
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(budget.signal.aborted).toBe(true);
      expect(() => budget.assertActive()).toThrow("time budget");
    } finally { budget.dispose(); }
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
