import {
  createAgent,
  createMiddleware,
  HumanMessage,
  modelCallLimitMiddleware,
  tool as frameworkTool,
  toolCallLimitMiddleware,
} from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ClientTool } from "@langchain/core/tools";
import type { JsonSchema7Type } from "@langchain/core/utils/json_schema";
import type { TargetFunctionCoverage, VerificationIssue } from "../types.js";
import {
  AgentRunFailure,
  createAgentRunBudget,
  DEFAULT_AGENT_RUN_LIMITS,
  type AgentHost,
  type AgentRunBudget,
  type AgentRunLimits,
  type AgentTask,
} from "./agent.js";
import { bindFunctionGroupTestRunner, bindTestRunner } from "./test-runner.js";
import {
  revalidateFunctionGroupReport,
  revalidateTargetReport,
  type FinalReportClaim,
} from "./revalidation.js";
import type {
  FunctionGroupFunctionResult,
  ProtocolCheck,
  VerificationReason,
} from "../types.js";
import type {
  FunctionGroupTestRun,
  HostTool,
  TargetTestResult,
  ToolContext,
  ToolRuntimeContext,
} from "./tools/common.js";
import {
  emitAgentTrace,
  type AgentTraceLogger,
} from "./trace-log.js";
import { emitAgentWorkLog, type AgentWorkLogger } from "./work-log.js";
import {
  defaultToolContextResolver,
  type ToolContextResolver,
} from "./runtime.js";
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

/** Accepted Agent report plus the Host's fresh observation of the target function. */
export type LangChainAgentHostResult = {
  verdict: FinalReportClaim["verdict"];
  summary: string;
  issue?: VerificationIssue;
  targetFunction?: TargetFunctionCoverage;
};

/** Accepted function-group report plus the Host's fresh per-function observation. */
export type LangChainFunctionGroupHostResult = {
  verdict: FinalReportClaim["verdict"];
  summary: string;
  issue?: VerificationIssue;
  functions: FunctionGroupFunctionResult[];
  reason?: VerificationReason;
  protocolChecks?: ProtocolCheck[];
};

const DEFAULT_MAX_FEEDBACK_ROUNDS = 4;
/** Keep the model-visible feedback bounded; the full observation stays in the trace. */
const MAX_FEEDBACK_CHARS = 12_000;
const MAX_TRACE_PAYLOAD_CHARS = 4_000;
/**
 * Host tools that touch the target working directory run one at a time, so a
 * batched framework tool call cannot read a half-written test file, rewrite a
 * test while its process runs, or release the harness mid-operation.
 */
const SERIAL_TOOLS = new Set([
  "write_target_test",
  "run_target_tests",
  "run_function_group_tests",
  "read_target_file",
  "list_target_files",
]);

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
  bindRunner(context: Omit<ToolContext, "state" | "runner" | "functionGroupRunner">): Pick<ToolContext, "runner" | "functionGroupRunner">;
  revalidate(
    context: ToolContext,
    report?: FinalReportClaim,
  ): Promise<{ observation: Observation; feedback: string[] }>;
  accept(report: FinalReportClaim, observation: Observation): Result;
  feedback(feedback: readonly string[], observation: Observation): string;
  /** Extra Host setup lines for the model-visible task. */
  setup: readonly string[];
};

const TARGET_ACCEPTANCE: Acceptance<TargetTestResult, LangChainAgentHostResult> = {
  bindRunner: context => ({ runner: bindTestRunner(context) }),
  revalidate: (context, report) => revalidateTargetReport(context, report),
  accept: (report, observation) => acceptedResult(report, observation),
  feedback: (feedback, observation) => feedbackMessage(feedback, observation),
  setup: [
    "- Every test path passed to write_target_test and run_target_tests must start with one of those exact roots.",
    "- Write and run tests only inside that dedicated folder. Start by running ALL existing tests in it with run_target_tests and path omitted.",
  ],
};

const FUNCTION_GROUP_ACCEPTANCE: Acceptance<FunctionGroupTestRun, LangChainFunctionGroupHostResult> = {
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

/**
 * Create the LangChain Host: it runs the framework Agent loop (model, tools,
 * message history) and keeps only the application-level cycle of
 * "invoke -> revalidate the complete folder -> append feedback -> invoke again".
 */
export function createLangChainAgentHost(
  options: LangChainAgentHostOptions,
): AgentHost<LangChainAgentHostResult> {
  return {
    taskProtocol: "final-report",
    run: task => runLangChainTask(options, task, TARGET_ACCEPTANCE),
  };
}

/** The same Host loop for translation-fidelity and requirement function groups. */
export function createLangChainFunctionGroupAgentHost(
  options: LangChainAgentHostOptions,
): AgentHost<LangChainFunctionGroupHostResult> {
  return {
    taskProtocol: "final-report",
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
      state: {},
      budget,
      runtime,
      ...acceptance.bindRunner({ budget, runtime }),
    };
    const bound = bindLangChainTools(task, context, options, runId);
    serializer = bound.serializer;
    const agent = createAgent({
      model: options.model,
      tools: bound.tools,
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
        { configurable: { thread_id: threadId }, signal: budget.signal },
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

type ParsedReport = {
  report?: FinalReportClaim;
  problems: string[];
};

const VERDICTS = new Set(["no-bug", "bug-found", "uncertain"]);

/** Parse and shape-check the ordinary final assistant message. */
export function parseFinalReport(message: BaseMessage | undefined): ParsedReport {
  if (message === undefined) {
    return { problems: ["The Agent ended without a final assistant message."] };
  }
  const text = messageText(message).trim();
  if (text.length === 0) {
    return { problems: ["The final assistant message is empty; end with the JSON verification report described in the task."] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problems: ["The final assistant message is not valid JSON. End with the JSON verification report described in the task."] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problems: ["The final report must be a JSON object with verdict and summary."] };
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  const verdict = record.verdict;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict)) {
    problems.push("The final report verdict must be one of: no-bug, bug-found, uncertain.");
  }
  const summary = record.summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    problems.push("The final report must include a non-empty summary.");
  }
  const issue = parseIssue(record.issue);
  if (issue !== undefined && "problem" in issue) problems.push(issue.problem);
  const issueValue = issue !== undefined && "issue" in issue ? issue.issue : undefined;
  const affectedTargets = parseAffectedTargets(record.affectedTargets);
  if (affectedTargets !== undefined && "problem" in affectedTargets) {
    problems.push(affectedTargets.problem);
  }
  const targets = affectedTargets !== undefined && "targets" in affectedTargets
    ? affectedTargets.targets
    : undefined;
  const protocolChecks = parseProtocolChecks(record.protocolChecks);
  if (protocolChecks !== undefined && "problem" in protocolChecks) {
    problems.push(protocolChecks.problem);
  }
  const checks = protocolChecks !== undefined && "checks" in protocolChecks
    ? protocolChecks.checks
    : undefined;

  if (verdict === "no-bug" && issueValue !== undefined) {
    problems.push("A no-bug report must not include an issue.");
  }
  if (verdict === "bug-found") {
    if (issueValue?.kind !== "translation") {
      problems.push("A bug-found report needs an issue with kind \"translation\" and a concrete description.");
    }
    if (targets === undefined || targets.length === 0) {
      problems.push("A bug-found report needs a non-empty affectedTargets list.");
    }
  }
  if (verdict === "uncertain") {
    if (issueValue?.kind !== "unknown") {
      problems.push("An uncertain report needs an issue with kind \"unknown\" explaining the missing requirement evidence.");
    } else if (/^(uncertain|unknown|无法确定)[.。]?$/i.test(issueValue.description.trim())) {
      problems.push("An uncertain report must explain the concrete ambiguity or missing evidence, not only state that the result is unknown.");
    }
  }
  if (problems.length > 0) return { problems };
  return {
    report: {
      verdict: verdict as FinalReportClaim["verdict"],
      summary: (summary as string).trim(),
      ...(issueValue ? { issue: issueValue } : {}),
      ...(targets ? { affectedTargets: targets } : {}),
      ...(checks ? { protocolChecks: checks } : {}),
    },
    problems,
  };
}

/** Function-group protocol checks stay bounded, mirroring the existing public shape. */
function parseProtocolChecks(value: unknown):
  | { checks: ProtocolCheck[] }
  | { problem: string }
  | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) {
    return { problem: "protocolChecks must be a list of at most three checks." };
  }
  const checks: ProtocolCheck[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { problem: "Each protocolChecks entry needs ruleId and status." };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.ruleId !== "string" || record.ruleId.trim().length === 0) {
      return { problem: "Each protocolChecks entry needs a non-empty ruleId." };
    }
    if (!["passed", "failed", "ambiguous", "not-applicable"].includes(String(record.status))) {
      return { problem: "Each protocolChecks status must be passed, failed, ambiguous, or not-applicable." };
    }
    checks.push({
      ruleId: record.ruleId.trim(),
      status: record.status as ProtocolCheck["status"],
      ...(typeof record.testName === "string" ? { testName: record.testName } : {}),
      ...(typeof record.note === "string" ? { note: record.note } : {}),
    });
  }
  return { checks };
}

function parseIssue(value: unknown):
  | { issue: VerificationIssue }
  | { problem: string }
  | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { problem: "The final report issue must be an object with kind and description." };
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  const description = record.description;
  if (kind !== "translation" && kind !== "test" && kind !== "environment" && kind !== "unknown") {
    return { problem: "The final report issue kind is not supported." };
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return { problem: "The final report issue needs a concrete description." };
  }
  return { issue: { kind, description: description.trim() } };
}

function parseAffectedTargets(value: unknown):
  | { targets: FinalReportClaim["affectedTargets"] }
  | { problem: string }
  | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    return { problem: "affectedTargets must be a non-empty list of requested target functions." };
  }
  const targets: NonNullable<FinalReportClaim["affectedTargets"]> = [];
  for (const item of value) {
    if (
      typeof item !== "object" || item === null || Array.isArray(item) ||
      typeof (item as Record<string, unknown>).path !== "string" ||
      typeof (item as Record<string, unknown>).name !== "string"
    ) {
      return { problem: "Each affectedTargets entry needs a path and name." };
    }
    const record = item as Record<string, unknown>;
    targets.push({
      path: record.path as string,
      name: record.name as string,
      ...(typeof record.signature === "string" ? { signature: record.signature } : {}),
    });
  }
  return { targets };
}

type WorkspaceSerializer = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** One queue per run: serializes shared-directory tools and can close before cleanup. */
function createWorkspaceSerializer(budget: AgentRunBudget): WorkspaceSerializer {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const enter = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      throw new Error("The Agent run is finishing; workspace operations are closed.");
    }
    budget.assertActive();
    return operation();
  };
  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const next = tail.then(
        () => enter(operation),
        () => enter(operation),
      );
      tail = next.catch(() => undefined);
      return next;
    },
    async close(): Promise<void> {
      closed = true;
      await tail;
    },
  };
}

function bindLangChainTools(
  task: AgentTask,
  context: ToolContext,
  options: LangChainAgentHostOptions,
  runId: string,
): { tools: ClientTool[]; serializer: WorkspaceSerializer } {
  const serializer = createWorkspaceSerializer(context.budget!);
  const tools = task.tools.map((factory) => {
    const hostTool: HostTool<unknown, unknown> = factory(context);
    const execute = async (input: unknown, config?: FrameworkToolConfig): Promise<unknown> => {
      const toolCallId = config?.toolCall?.id;
      const startedAt = performance.now();
      emitAgentWorkLog(options.workLogger, {
        ...workEvent(runId, "tool.started"),
        toolName: hostTool.name,
        ...(toolCallId ? { toolCallId } : {}),
        argumentCharacters: valueCharacters(input),
      });
      emitAgentTrace(options.traceLogger, traceEvent(runId, "tool.started", {
        toolName: hostTool.name,
        ...(toolCallId ? { toolCallId } : {}),
        input: boundedValue(input, MAX_TRACE_PAYLOAD_CHARS),
      }));
      try {
        const run = async () => hostTool.execute(hostTool.parse(input));
        const output = SERIAL_TOOLS.has(hostTool.name)
          ? await serializer.run(run)
          : await run();
        emitAgentWorkLog(options.workLogger, {
          ...workEvent(runId, "tool.completed"),
          toolName: hostTool.name,
          ...(toolCallId ? { toolCallId } : {}),
          outputCharacters: valueCharacters(output),
          elapsedMs: Math.round(performance.now() - startedAt),
        });
        emitAgentTrace(options.traceLogger, traceEvent(runId, "tool.completed", {
          toolName: hostTool.name,
          ...(toolCallId ? { toolCallId } : {}),
          elapsedMs: Math.round(performance.now() - startedAt),
          output: boundedValue(output, MAX_TRACE_PAYLOAD_CHARS),
        }));
        return output;
      } catch (error) {
        emitAgentWorkLog(options.workLogger, {
          ...workEvent(runId, "tool.failed"),
          toolName: hostTool.name,
          ...(toolCallId ? { toolCallId } : {}),
          elapsedMs: Math.round(performance.now() - startedAt),
          ...errorFields(error),
        });
        emitAgentTrace(options.traceLogger, traceEvent(runId, "tool.failed", {
          toolName: hostTool.name,
          ...(toolCallId ? { toolCallId } : {}),
          elapsedMs: Math.round(performance.now() - startedAt),
          ...errorFields(error),
        }));
        throw error;
      }
    };
    return frameworkTool(execute, {
      name: hostTool.name,
      description: hostTool.description,
      schema: hostTool.inputSchema as JsonSchema7Type,
    });
  });
  return { tools, serializer };
}

type FrameworkToolConfig = { toolCall?: { id?: string } };

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

function messageCharacters(message: BaseMessage): number {
  let characters = messageText(message).length;
  const calls = (message as { tool_calls?: Array<{ name?: string; args?: unknown }> }).tool_calls;
  if (Array.isArray(calls)) {
    for (const call of calls) {
      characters += (call?.name?.length ?? 0) + valueCharacters(call?.args);
    }
  }
  return characters;
}

function valueCharacters(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function boundedValue(value: unknown, maximum: number): unknown {
  if (typeof value === "string") {
    return value.length <= maximum ? value : `${value.slice(0, maximum)}...(truncated)`;
  }
  try {
    const text = JSON.stringify(value) ?? "";
    return text.length <= maximum
      ? value
      : `${text.slice(0, maximum)}...(truncated)`;
  } catch {
    return "(unserializable value)";
  }
}

/**
 * Operational failures must stay distinguishable from a reported production
 * defect upstream: budget/context/time exhaustion, model failures and
 * cancellation are not verification results.
 */
function classifyRunFailure(error: unknown, budget: AgentRunBudget): unknown {
  if (budget.signal.aborted) return budget.signal.reason ?? error;
  const message = errorMessage(error);
  if (error instanceof AgentRunFailure) return error;
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

function acceptedResult(
  report: FinalReportClaim,
  observation: Awaited<ReturnType<typeof revalidateTargetReport>>["observation"],
): LangChainAgentHostResult {
  const targetFunction = observation.coverage?.status === "available"
    ? observation.coverage.targetFunction
    : undefined;
  return {
    verdict: report.verdict,
    summary: report.summary,
    ...acceptedIssue(report),
    ...(targetFunction ? { targetFunction: { ...targetFunction } } : {}),
  };
}

/** The public issue kind follows the accepted verdict, never the model's self-description. */
function acceptedIssue(report: FinalReportClaim): { issue?: VerificationIssue } {
  if (report.verdict === "bug-found" && report.issue) {
    return { issue: { kind: "translation", description: report.issue.description } };
  }
  if (report.verdict === "uncertain" && report.issue) {
    return { issue: { kind: "unknown", description: report.issue.description } };
  }
  return {};
}

function acceptedFunctionGroupResult(
  report: FinalReportClaim,
  observation: FunctionGroupTestRun,
): LangChainFunctionGroupHostResult {
  return {
    verdict: report.verdict,
    summary: report.summary,
    ...acceptedIssue(report),
    functions: observation.functions.map(item => ({
      ...item,
      ...(item.source ? { source: { ...item.source } } : {}),
      target: { ...item.target },
    })),
    ...(observation.reason && observation.reason !== "verified" ? { reason: observation.reason } : {}),
    ...(report.protocolChecks ? { protocolChecks: report.protocolChecks } : {}),
  };
}

function functionGroupFeedbackMessage(
  feedback: readonly string[],
  observation: FunctionGroupTestRun,
): string {
  const failedCases = (observation.testCases ?? []).filter(item => item.status === "failed").slice(0, 5);
  return [
    "The Host did not accept your final report. Continue in this same task, fix the same tests in the same working directory, and end with a corrected final JSON report.",
    "",
    "Fresh Host revalidation of the complete dedicated test folder:",
    `- status: ${observation.status}`,
    `- timed out: ${observation.timedOut === true}`,
    `- execution errors: ${observation.executionErrors ?? 0}`,
    `- tests executed: ${observation.tests.executed}, passed: ${observation.tests.passed}, failed: ${observation.tests.failed}, skipped: ${observation.tests.skipped}`,
    ...(failedCases.length > 0
      ? [
        "- failed test cases:",
        ...failedCases.map(item => `  - ${item.id}${item.message ? `: ${boundedText(item.message, 500)}` : ""}`),
      ]
      : []),
    "- target function coverage from this run:",
    ...observation.functions.map(item =>
      `  - ${item.target.path}#${item.target.name}${item.target.signature ? ` (${item.target.signature})` : ""}: executed=${item.executed}, status=${item.status}, line=${item.lineCoverage ?? "null"}, branch=${item.branchCoverage ?? "null"}${item.coverageIssue ? `, issue=${item.coverageIssue}` : ""}`,
    ),
    `- report paths: ${observation.reportPaths?.join(", ") || "(none)"}`,
    // Maven and other JVM runners usually report compilation problems on stdout.
    ...(observation.stdout.trim() ? [`- stdout: ${boundedText(observation.stdout.trim(), 2_000)}`] : []),
    ...(observation.stderr.trim() ? [`- stderr: ${boundedText(observation.stderr.trim(), 2_000)}`] : []),
    "",
    "Unmet completion conditions:",
    ...feedback.map(item => `- ${item}`),
  ].join("\n");
}

/** Bound model-visible diagnostics; the Host trace keeps the complete observation. */
function boundedText(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Host retained ${text.length - limit} additional diagnostic characters]`;
}

function feedbackMessage(
  feedback: readonly string[],
  observation: Awaited<ReturnType<typeof revalidateTargetReport>>["observation"],
): string {
  const tests = observation.tests;
  const coverage = observation.coverage;
  const message = [
    "The Host did not accept your final report. Continue in this same task, fix the same tests in the same working directory, and end with a corrected final JSON report.",
    "",
    "Fresh Host revalidation of the complete dedicated test folder:",
    `- status: ${observation.status}`,
    `- timed out: ${observation.timedOut}`,
    `- execution errors: ${observation.executionErrors ?? 0}`,
    ...(tests
      ? [`- tests executed: ${tests.executed}, passed: ${tests.passed}, failed: ${tests.failed}, skipped: ${tests.skipped}`]
      : ["- no test summary was parsed"]),
    `- target function executed: ${coverage?.status === "available" ? String(coverage.targetFunction.executed) : "unknown"}`,
    `- report paths: ${observation.reportPaths?.join(", ") || "(none)"}`,
    ...(observation.stderr.trim() ? [`- stderr: ${observation.stderr.trim().slice(0, 2_000)}`] : []),
    "",
    "Unmet completion conditions:",
    ...feedback.map(item => `- ${item}`),
  ].join("\n");
  return message.length <= MAX_FEEDBACK_CHARS
    ? message
    : `${message.slice(0, MAX_FEEDBACK_CHARS)}\n...(feedback truncated; the complete Host observation is in the run trace)`;
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

function messageText(message: BaseMessage | undefined): string {
  if (message === undefined) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(block => {
    if (typeof block === "string") return block;
    if (typeof block === "object" && block !== null && "text" in block) {
      return String((block as { text: unknown }).text ?? "");
    }
    return "";
  }).join("");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFields(error: unknown): Record<string, unknown> {
  return {
    error: errorMessage(error),
    errorType: error instanceof Error ? error.name : typeof error,
  };
}
