import {
  createAgent,
  createMiddleware,
  HumanMessage,
  modelCallLimitMiddleware,
  toolCallLimitMiddleware,
} from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { VerificationTestCase } from "../../types.js";
import {
  AgentRunFailure,
  createAgentRunBudget,
  DEFAULT_AGENT_RUN_LIMITS,
  type AgentRunBudget,
  type AgentRunLimits,
} from "./run-budget.js";
import type { AgentHost, AgentTask } from "./task.js";
import { bindFunctionGroupTestRunner, bindTestRunner } from "../testing/test-runner.js";
import {
  revalidateFunctionGroupReport,
  revalidateTargetReport,
} from "../verification/revalidation.js";
import {
  acceptedFunctionGroupResult,
  acceptedResult,
  parseFinalReport,
  type FinalReportClaim,
  type ParsedReport,
  type AgentHostResult,
  type FunctionGroupHostResult,
} from "../verification/report.js";
import { feedbackMessage, functionGroupFeedbackMessage } from "../verification/feedback.js";
import { messageCharacters, messageText } from "./messages.js";
import type {
  FunctionGroupTestRun,
  TargetTestResult,
  ToolContext,
  ToolRuntimeContext,
} from "../tools/common.js";
import {
  createToolCallMiddleware,
  createWorkspaceSerializer,
  type WorkspaceSerializer,
} from "./tool-middleware.js";
import {
  emitAgentTrace,
  type AgentTraceLogger,
} from "../logging/trace-log.js";
import { emitAgentWorkLog, type AgentWorkLogger } from "../logging/work-log.js";
import {
  defaultToolContextResolver,
  type ToolContextResolver,
} from "../testing/tool-context.js";
import { randomUUID } from "node:crypto";

export type LangChainAgentHostOptions = {
  /** Framework chat model instance; production callers build it with createTranslationVerifierChatModel. */
  model: BaseChatModel;
  signal?: AbortSignal;
  limits?: Partial<AgentRunLimits>;
  /** Upper bound for Host feedback continuations after natural Agent endings. */
  maxFeedbackRounds?: number;
  resolveToolContext?: ToolContextResolver;
  workLogger?: AgentWorkLogger;
  traceLogger?: AgentTraceLogger;
};

const DEFAULT_MAX_FEEDBACK_ROUNDS = 4;

/** Shared shape of the fresh Host observation both task kinds report on. */
type ObservationSummary = {
  status: "success" | "failure";
  exitCode: number | null;
  timedOut?: boolean;
  tests?: { executed: number };
};

/** One Host ownership contract per task shape: runner binding, revalidation, feedback and accepted result. */
type Acceptance<Observation extends ObservationSummary, Result> = {
  /** Host-owned runners bound for this task shape. */
  bindRunner(context: Omit<ToolContext, "runner" | "functionGroupRunner">): Pick<ToolContext, "runner" | "functionGroupRunner">;
  revalidate(
    context: ToolContext,
    report?: FinalReportClaim,
  ): Promise<{ observation: Observation; feedback: string[] }>;
  accept(report: FinalReportClaim, observation: Observation): Result;
  feedback(feedback: readonly string[], observation: Observation): string;
  /** Extra Host setup lines for the model-visible task. */
  setup: readonly string[];
};

const TARGET_ACCEPTANCE: Acceptance<TargetTestResult, AgentHostResult> = {
  bindRunner: context => ({ runner: bindTestRunner(context) }),
  revalidate: (context, report) => revalidateTargetReport(context, report),
  accept: (report, observation) => acceptedResult(report, observation),
  feedback: (feedback, observation) => feedbackMessage(feedback, observation),
  setup: [
    "- Every test path passed to write_target_test and run_target_tests must start with one of those exact roots.",
    "- Write and run tests only inside that dedicated folder. Start by running ALL existing tests in it with run_target_tests and path omitted.",
  ],
};

const FUNCTION_GROUP_ACCEPTANCE: Acceptance<FunctionGroupTestRun, FunctionGroupHostResult> = {
  bindRunner: context => ({
    runner: bindTestRunner(context),
    functionGroupRunner: bindFunctionGroupTestRunner(context),
  }),
  revalidate: (context, report) => revalidateFunctionGroupReport(context, report),
  accept: (report, observation) => acceptedFunctionGroupResult(report, observation),
  feedback: (feedback, observation) => functionGroupFeedbackMessage(feedback, observation),
  setup: [
    "- Every test path passed to write_target_test and run_function_group_tests must start with one of those exact roots.",
    "- Write and run tests only inside that dedicated folder. Start by running ALL existing tests in it with run_function_group_tests and paths omitted.",
  ],
};

export function createLangChainAgentHost(
  options: LangChainAgentHostOptions,
): AgentHost<AgentHostResult> {
  return {
    run: task => runLangChainTask(options, task, TARGET_ACCEPTANCE),
  };
}

/** The same Host loop for translation-fidelity and requirement function groups. */
export function createLangChainFunctionGroupAgentHost(
  options: LangChainAgentHostOptions,
): AgentHost<FunctionGroupHostResult> {
  return {
    run: task => runLangChainTask(options, task, FUNCTION_GROUP_ACCEPTANCE),
  };
}

async function runLangChainTask<Observation extends ObservationSummary, Result>(
  options: LangChainAgentHostOptions,
  task: AgentTask,
  acceptance: Acceptance<Observation, Result>,
): Promise<Result> {
  const limits: AgentRunLimits = { ...DEFAULT_AGENT_RUN_LIMITS, ...options.limits };
  const maxFeedbackRounds = options.maxFeedbackRounds ?? DEFAULT_MAX_FEEDBACK_ROUNDS;
  const resolveToolContext = options.resolveToolContext ?? defaultToolContextResolver;
  const runId = randomUUID();
  const startedAt = performance.now();
  const budget = createAgentRunBudget(limits, Date.now(), options.signal);
  emitAgentWorkLog(options.workLogger, { ...workEvent(runId, "run.started") });
  emitAgentTrace(options.traceLogger, traceEvent(runId, "run.started"));
  let cleanup: (() => Promise<void>) | undefined;
  let serializer: WorkspaceSerializer | undefined;
  try {
    budget.assertActive();
    const runtime = await resolveToolContext(task.taskContext);
    cleanup = runtime.cleanup;
    budget.assertActive();
    const context: ToolContext = {
      budget,
      runtime,
      ...acceptance.bindRunner({ budget, runtime }),
    };
    // Each factory returns one native LangChain tool bound to this run's
    // authorization context; the framework owns dispatch and validation.
    const tools: StructuredToolInterface[] = task.tools.map(factory => factory(context));
    serializer = createWorkspaceSerializer(budget);
    const agent = createAgent({
      model: options.model,
      tools,
      systemPrompt: withRuntimeInstructions(task.systemPrompt, runtime, acceptance.setup),
      checkpointer: new MemorySaver(),
      middleware: [
        createRunLimitMiddleware(limits),
        modelCallLimitMiddleware({
          threadLimit: limits.maxTurns,
          exitBehavior: "error",
        }),
        toolCallLimitMiddleware({
          threadLimit: limits.maxToolCalls,
          exitBehavior: "error",
        }),
        createToolCallMiddleware({
          runId,
          serializer,
          budget,
          ...(options.workLogger ? { workLogger: options.workLogger } : {}),
          ...(options.traceLogger ? { traceLogger: options.traceLogger } : {}),
        }),
      ],
    });
    const threadId = randomUUID();
    let input: BaseMessage = new HumanMessage(task.userPrompt);

    for (let round = 1; ; round += 1) {
      budget.assertActive();
      emitAgentWorkLog(options.workLogger, {
        ...workEvent(runId, "agent.invocation.started"),
        turn: round,
      });
      const response = await agent.invoke(
        { messages: [input] },
        {
          configurable: { thread_id: threadId },
          signal: budget.signal,
          // Every middleware hook and tool dispatch is a graph superstep, so
          // the framework default of 25 would stop a normal multi-tool run
          // long before the Host's own model/tool budgets. The Host budgets
          // remain the authoritative limits.
          recursionLimit: recursionLimitFor(limits),
        },
      );
      budget.assertActive();
      const messages = (response as { messages?: BaseMessage[] }).messages ?? [];
      const last = messages[messages.length - 1];
      const parsed = parseFinalReport(last);
      emitAgentWorkLog(options.workLogger, {
        ...workEvent(runId, "agent.invocation.completed"),
        turn: round,
        status: parsed.report?.verdict,
        outcome: parsed.problems.length === 0 ? "valid-report" : "invalid-report",
      });
      emitAgentTrace(options.traceLogger, traceEvent(runId, "agent.invocation.completed", {
        round,
        verdict: parsed.report?.verdict,
        content: messageText(last).slice(0, 4_000),
      }));

      const revalidation = await acceptance.revalidate(context, parsed.report);
      emitAgentWorkLog(options.workLogger, {
        ...workEvent(runId, "host.revalidation.completed"),
        turn: round,
        status: revalidation.observation.status,
        exitCode: revalidation.observation.exitCode,
        timedOut: revalidation.observation.timedOut,
        toolCallCount: revalidation.observation.tests?.executed,
        outcome: revalidation.feedback.length === 0 ? "accepted" : "feedback",
      });
      emitAgentTrace(options.traceLogger, traceEvent(runId, "host.revalidation.completed", {
        round,
        observation: revalidation.observation,
        feedback: revalidation.feedback,
      }));

      const feedback = [...parsed.problems, ...revalidation.feedback];
      if (feedback.length === 0 && parsed.report !== undefined) {
        const result = acceptance.accept(parsed.report, revalidation.observation);
        emitAgentWorkLog(options.workLogger, {
          ...workEvent(runId, "run.completed", {
            elapsedMs: elapsedMs(startedAt),
            outcome: parsed.report.verdict,
          }),
        });
        emitAgentTrace(options.traceLogger, traceEvent(runId, "run.completed", {
          elapsedMs: elapsedMs(startedAt),
          verdict: parsed.report.verdict,
        }));
        return result;
      }
      if (round > maxFeedbackRounds) {
        throw new AgentRunFailure(
          "budget",
          `Agent run budget exhausted: no accepted final report within ${maxFeedbackRounds} feedback rounds.`,
        );
      }
      budget.assertActive();
      input = new HumanMessage(acceptance.feedback(feedback, revalidation.observation));
      emitAgentWorkLog(options.workLogger, {
        ...workEvent(runId, "agent.feedback.appended"),
        turn: round,
        messageCount: feedback.length,
      });
    }
  } catch (error) {
    const failure = classifyRunFailure(error, budget);
    emitAgentWorkLog(options.workLogger, {
      ...workEvent(runId, "run.failed", {
        elapsedMs: elapsedMs(startedAt),
        ...errorFields(failure),
      }),
    });
    emitAgentTrace(options.traceLogger, traceEvent(runId, "run.failed", {
      elapsedMs: elapsedMs(startedAt),
      ...errorFields(failure),
    }));
    throw failure;
  } finally {
    try {
      // Let the in-flight workspace operation settle before the harness is
      // released; queued operations see the closed queue and never start.
      await serializer?.close();
    } finally {
      try {
        await cleanup?.();
      } finally {
        budget.dispose();
      }
    }
  }
}

/**
 * Host-side residual limits that framework middleware does not express:
 * thread context size, per-response size and per-turn tool calls. All counts
 * are derived from persisted thread state, so feedback rounds do not reset them.
 */
function createRunLimitMiddleware(limits: AgentRunLimits) {
  return createMiddleware({
    name: "TranslationVerifierRunLimit",
    beforeModel: (state: { messages?: BaseMessage[] }) => {
      const messages = state.messages ?? [];
      const characters = messages.reduce(
        (total, message) => total + messageCharacters(message),
        0,
      );
      if (characters > limits.maxContextCharacters) {
        throw new AgentRunFailure(
          "context",
          `Agent run context budget exhausted: ${characters} characters exceed the ${limits.maxContextCharacters}-character limit.`,
        );
      }
    },
    afterModel: (state: { messages?: BaseMessage[] }) => {
      const messages = state.messages ?? [];
      const last = messages[messages.length - 1];
      if (last === undefined) return;
      const characters = messageCharacters(last);
      if (characters > limits.maxResponseCharacters) {
        throw new AgentRunFailure(
          "context",
          `Agent run response budget exhausted: ${characters} characters exceed the ${limits.maxResponseCharacters}-character limit.`,
        );
      }
      const calls = (last as unknown as { tool_calls?: unknown[] }).tool_calls;
      const toolCalls = Array.isArray(calls) ? calls.length : 0;
      if (toolCalls > limits.maxToolCallsPerTurn) {
        throw new AgentRunFailure(
          "budget",
          `Agent run budget exhausted: ${toolCalls} tool calls exceed the ${limits.maxToolCallsPerTurn}-call per-turn limit.`,
        );
      }
    },
  });
}

/** Graph supersteps needed to reach the Host-enforced budgets, never a new budget. */
function recursionLimitFor(limits: AgentRunLimits): number {
  return 4 * limits.maxTurns + 2 * limits.maxToolCalls + 16;
}

/**
 * Operational failures must stay distinguishable from a reported production
 * defect upstream: budget/context/time exhaustion, model failures and
 * cancellation are not verification results.
 */
function classifyRunFailure(error: unknown, budget: AgentRunBudget): unknown {
  if (budget.signal.aborted) return budget.signal.reason ?? error;
  const message = errorMessage(error);
  // A middleware already wrapped Host failures once; the typed reason still
  // identifies an operational failure without re-deriving it from its text.
  const typed = typedRunFailure(error);
  if (typed !== undefined) return typed;
  if (/context budget exhausted|response budget exhausted/i.test(message)) {
    return new AgentRunFailure("context", message, { cause: error });
  }
  const name = error instanceof Error ? error.name : "";
  if (
    name === "ModelCallLimitMiddlewareError" ||
    name === "ToolCallLimitExceededError" ||
    /call limits? exceeded/i.test(message)
  ) {
    return new AgentRunFailure("budget", `Agent run budget exhausted: ${message}`, { cause: error });
  }
  if (
    typeof (error as { status?: unknown })?.status === "number" ||
    /APIError|APIConnection|Authentication|RateLimit|OpenAI/i.test(name) ||
    (/model|completion|api key/i.test(message) && !/budget/i.test(message))
  ) {
    return new AgentRunFailure("model", `Agent run model failure: ${message}`, { cause: error });
  }
  return error;
}

function withRuntimeInstructions(
  systemPrompt: string,
  runtime: ToolRuntimeContext,
  setup: readonly string[],
): string {
  return [
    systemPrompt,
    "",
    "Host test setup (authoritative):",
    `- Test framework: ${runtime.testRunner}`,
    `- Authorized test roots: ${runtime.testRoots.join(", ")}`,
    ...setup,
    "- After your final report the Host reruns the complete dedicated folder itself and may append feedback; your report is a candidate conclusion, not an accepted result.",
  ].join("\n");
}

function traceEvent(runId: string, event: string, fields: Record<string, unknown> = {}) {
  return { at: new Date().toISOString(), runId, event, ...fields };
}

function workEvent(
  runId: string,
  event: Parameters<typeof emitAgentWorkLog>[1]["event"],
  fields: Record<string, unknown> = {},
) {
  return { at: new Date().toISOString(), runId, event, ...fields };
}

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** The Host failure type may be wrapped by framework middleware; follow the cause chain. */
function typedRunFailure(error: unknown): AgentRunFailure | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof AgentRunFailure) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFields(error: unknown): Record<string, unknown> {
  return {
    error: errorMessage(error),
    errorType: error instanceof Error ? error.name : typeof error,
  };
}
