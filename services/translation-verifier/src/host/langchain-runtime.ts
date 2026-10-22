import {
  createAgent,
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
  createAgentRunBudget,
  DEFAULT_AGENT_RUN_LIMITS,
  type AgentHost,
  type AgentRunLimits,
  type AgentTask,
} from "./agent.js";
import { bindTestRunner } from "./test-runner.js";
import {
  revalidateTargetReport,
  type FinalReportClaim,
} from "./revalidation.js";
import type {
  HostTool,
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

const DEFAULT_MAX_FEEDBACK_ROUNDS = 4;
/** Host tools that touch the shared dedicated test folder run one at a time. */
const SERIAL_TOOLS = new Set([
  "write_target_test",
  "run_target_tests",
  "run_function_group_tests",
]);

/**
 * Create the LangChain Host: it runs the framework Agent loop (model, tools,
 * message history) and keeps only the application-level cycle of
 * "invoke -> revalidate the complete folder -> append feedback -> invoke again".
 */
export function createLangChainAgentHost(
  options: LangChainAgentHostOptions,
): AgentHost<LangChainAgentHostResult> {
  const limits: AgentRunLimits = { ...DEFAULT_AGENT_RUN_LIMITS, ...options.limits };
  const maxFeedbackRounds = options.maxFeedbackRounds ?? DEFAULT_MAX_FEEDBACK_ROUNDS;
  const resolveToolContext = options.resolveToolContext ?? defaultToolContextResolver;

  return {
    taskProtocol: "final-report",
    async run(task) {
      const runId = randomUUID();
      const startedAt = performance.now();
      const budget = createAgentRunBudget(limits, Date.now(), options.signal);
      emitAgentWorkLog(options.workLogger, { ...workEvent(runId, "run.started") });
      emitAgentTrace(options.traceLogger, traceEvent(runId, "run.started"));
      let cleanup: (() => Promise<void>) | undefined;
      try {
        budget.assertActive();
        const runtime = await resolveToolContext(task.taskContext);
        cleanup = runtime.cleanup;
        budget.assertActive();
        const context: ToolContext = {
          state: {},
          budget,
          runtime,
          runner: bindTestRunner({ budget, runtime }),
        };
        const tools = bindLangChainTools(task, context, options, runId);
        const agent = createAgent({
          model: options.model,
          tools,
          systemPrompt: withRuntimeInstructions(task.systemPrompt, runtime),
          checkpointer: new MemorySaver(),
          middleware: [
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

          const revalidation = await revalidateTargetReport(context, parsed.report);
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
            const result = acceptedResult(parsed.report, revalidation.observation);
            emitAgentWorkLog(options.workLogger, {
              ...workEvent(runId, "run.completed", {
                elapsedMs: elapsedMs(startedAt),
                outcome: result.verdict,
              }),
            });
            emitAgentTrace(options.traceLogger, traceEvent(runId, "run.completed", {
              elapsedMs: elapsedMs(startedAt),
              verdict: result.verdict,
            }));
            return result;
          }
          if (round > maxFeedbackRounds) {
            throw new Error(
              `Agent did not produce an accepted final report within ${maxFeedbackRounds} feedback rounds.`,
            );
          }
          input = new HumanMessage(feedbackMessage(feedback, revalidation.observation));
          emitAgentWorkLog(options.workLogger, {
            ...workEvent(runId, "agent.feedback.appended"),
            turn: round,
            messageCount: feedback.length,
          });
        }
      } catch (error) {
        emitAgentWorkLog(options.workLogger, {
          ...workEvent(runId, "run.failed", {
            elapsedMs: elapsedMs(startedAt),
            ...errorFields(error),
          }),
        });
        emitAgentTrace(options.traceLogger, traceEvent(runId, "run.failed", {
          elapsedMs: elapsedMs(startedAt),
          error: errorMessage(error),
        }));
        throw error;
      } finally {
        try {
          await cleanup?.();
        } finally {
          budget.dispose();
        }
      }
    },
  };
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
    },
    problems,
  };
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

function bindLangChainTools(
  task: AgentTask,
  context: ToolContext,
  options: LangChainAgentHostOptions,
  runId: string,
): ClientTool[] {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  return task.tools.map((factory) => {
    const hostTool: HostTool<unknown, unknown> = factory(context);
    const execute = async (input: unknown): Promise<unknown> => {
      const run = async () => hostTool.execute(hostTool.parse(input));
      const output = SERIAL_TOOLS.has(hostTool.name) ? await serialize(run) : await run();
      emitAgentTrace(options.traceLogger, traceEvent(runId, "tool.completed", {
        toolName: hostTool.name,
      }));
      return output;
    };
    return frameworkTool(execute, {
      name: hostTool.name,
      description: hostTool.description,
      schema: hostTool.inputSchema as JsonSchema7Type,
    });
  });
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
    ...(report.verdict === "bug-found" && report.issue
      ? { issue: { kind: "translation" as const, description: report.issue.description } }
      : {}),
    ...(report.verdict === "uncertain" && report.issue
      ? { issue: { kind: "unknown" as const, description: report.issue.description } }
      : {}),
    ...(targetFunction ? { targetFunction: { ...targetFunction } } : {}),
  };
}

function feedbackMessage(
  feedback: readonly string[],
  observation: Awaited<ReturnType<typeof revalidateTargetReport>>["observation"],
): string {
  const tests = observation.tests;
  const coverage = observation.coverage;
  return [
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
}

function withRuntimeInstructions(
  systemPrompt: string,
  runtime: ToolRuntimeContext,
): string {
  return [
    systemPrompt,
    "",
    "Host test setup (authoritative):",
    `- Test framework: ${runtime.testRunner}`,
    `- Authorized test roots: ${runtime.testRoots.join(", ")}`,
    "- Every test path passed to write_target_test and run_target_tests must start with one of those exact roots.",
    "- Write and run tests only inside that dedicated folder. Start by running ALL existing tests in it with run_target_tests and path omitted.",
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
  return { error: errorMessage(error) };
}
