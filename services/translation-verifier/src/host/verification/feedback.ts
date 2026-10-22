import type { VerificationTestCase } from "../../types.js";
import type { FunctionGroupTestRun, TargetTestResult, TestSummary } from "../tools/common.js";

/** Keep the model-visible feedback bounded; the full observation stays in the trace. */
const MAX_FEEDBACK_CHARS = 12_000;

/** One Host observation rendered for the model; both task shapes share these lines. */
type FeedbackObservation = {
  status: "success" | "failure";
  exitCode: number | null;
  timedOut?: boolean;
  executionErrors?: number;
  tests?: TestSummary;
  testCases?: VerificationTestCase[];
  stdout: string;
  stderr: string;
  reportPaths?: string[];
};

const TRUNCATION_MARKER = "...(feedback truncated; the complete Host observation and unmet-condition list are in the run trace)";
/** The unmet conditions are the actionable part; diagnostics may only use what is left. */
const MAX_CONDITION_CHARS = 5_000;
const MAX_CONDITION_ITEM_CHARS = 600;
const MIN_CONDITION_SUMMARY_CHARS = 160;

/** Host-owned facts the Agent always needs: counts and where the fresh reports are. */
function observationFacts(observation: FeedbackObservation): string[] {
  return [
    `- status: ${observation.status}`,
    `- timed out: ${observation.timedOut === true}`,
    `- execution errors: ${observation.executionErrors ?? 0}`,
    observation.tests
      ? `- tests executed: ${observation.tests.executed}, passed: ${observation.tests.passed}, failed: ${observation.tests.failed}, skipped: ${observation.tests.skipped}`
      : "- no test summary was parsed",
    `- report paths: ${observation.reportPaths?.join(", ") || "(none)"}`,
  ];
}

/**
 * Concrete diagnostics that help repair the same tests, ordered by usefulness:
 * failed cases first, then runner output, then the per-function coverage list.
 * They are the only section rendered with the remaining character budget.
 */
function observationDiagnostics(observation: FeedbackObservation): string[] {
  const failedCases = (observation.testCases ?? []).filter(item => item.status === "failed").slice(0, 5);
  return [
    ...(failedCases.length > 0
      ? [
        "- failed test cases:",
        ...failedCases.map(item => `  - ${item.id}${item.message ? `: ${boundedText(item.message, 500)}` : ""}`),
      ]
      : []),
    ...(observation.stdout.trim() ? [`- stdout: ${boundedText(observation.stdout.trim(), 2_000)}`] : []),
    ...(observation.stderr.trim() ? [`- stderr: ${boundedText(observation.stderr.trim(), 2_000)}`] : []),
  ];
}

/** Bound model-visible diagnostics; the Host trace keeps the complete observation. */
function boundedText(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Host retained ${text.length - limit} additional diagnostic characters]`;
}

/** One-line bound for a condition, so a single long reason cannot eat the section. */
function boundedCondition(item: string): string {
  return item.length <= MAX_CONDITION_ITEM_CHARS
    ? item
    : `${item.slice(0, MAX_CONDITION_ITEM_CHARS)}… [Host retained ${item.length - MAX_CONDITION_ITEM_CHARS} additional characters]`;
}

/**
 * Render the unmet conditions within their own budget. Each reason keeps a
 * bounded summary and the complete list stays in the trace, so moving one long
 * reason into the message can never hide the following ones.
 */
function boundedConditions(conditions: readonly string[]): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let used = 0;
  let boundedAny = false;
  for (const [index, condition] of conditions.entries()) {
    const line = `- ${boundedCondition(condition)}`;
    boundedAny ||= line.length !== condition.length + 2;
    if (used + line.length + 1 <= MAX_CONDITION_CHARS) {
      lines.push(line);
      used += line.length + 1;
      continue;
    }
    // A single over-long reason is first reduced to a summary; whatever still
    // does not fit is reported as a count instead of silently disappearing.
    const summary = `- ${condition.slice(0, MIN_CONDITION_SUMMARY_CHARS)}…`;
    if (used + summary.length + 1 <= MAX_CONDITION_CHARS) {
      lines.push(summary);
    }
    const omitted = conditions.length - index - (used + summary.length + 1 <= MAX_CONDITION_CHARS ? 1 : 0);
    lines.push(`- (+${Math.max(1, omitted)} further unmet conditions are in the run trace)`);
    return { lines, truncated: true };
  }
  return { lines, truncated: boundedAny };
}

function boundedDiagnostics(lines: readonly string[], budget: number): { lines: string[]; truncated: boolean } {
  if (budget <= 0 || lines.length === 0) {
    return { lines: [], truncated: lines.length > 0 };
  }
  const kept: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    if (used + line.length + 1 > budget) {
      return { lines: [...kept, `- (+${lines.length - index} further diagnostic lines are in the run trace)`], truncated: true };
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { lines: kept, truncated: false };
}

/**
 * One bounded feedback message per round with explicit section priority: the
 * instruction, the unmet conditions, the Host-owned counts and report paths are
 * reserved first, and long runner output or coverage lists only fill the rest.
 */
function hostFeedbackMessage(
  facts: readonly string[],
  diagnostics: readonly string[],
  conditions: readonly string[],
): string {
  const bounded = boundedConditions(conditions);
  const head = [
    "The Host did not accept your final report. Continue in this same task, fix the same tests in the same working directory, and end with a corrected final JSON report.",
    "",
    "Unmet completion conditions (highest priority; the complete list is in the run trace):",
    ...bounded.lines,
    "",
    "Fresh Host revalidation of the complete dedicated test folder:",
    ...facts,
    "",
  ].join("\n");
  const remaining = MAX_FEEDBACK_CHARS - head.length - TRUNCATION_MARKER.length - "Bounded diagnostics from this run:.\n".length;
  const rendered = boundedDiagnostics(diagnostics, remaining);
  const message = [
    head,
    "Bounded diagnostics from this run:",
    ...rendered.lines,
  ].join("\n");
  return bounded.truncated || rendered.truncated
    ? `${message}\n${TRUNCATION_MARKER}`
    : message;
}

export function feedbackMessage(
  feedback: readonly string[],
  observation: TargetTestResult,
): string {
  const coverage = observation.coverage;
  return hostFeedbackMessage(
    [
      ...observationFacts(observation),
      `- target function executed: ${coverage?.status === "available" ? String(coverage.targetFunction.executed) : "unknown"}`,
    ],
    observationDiagnostics(observation),
    feedback,
  );
}

export function functionGroupFeedbackMessage(
  feedback: readonly string[],
  observation: FunctionGroupTestRun,
): string {
  return hostFeedbackMessage(
    observationFacts(observation),
    [
      ...observationDiagnostics(observation),
      "- target function coverage from this run:",
      ...observation.functions.map(item =>
        `  - ${item.target.path}#${item.target.name}${item.target.signature ? ` (${item.target.signature})` : ""}: executed=${item.executed}, status=${item.status}, line=${item.lineCoverage ?? "null"}, branch=${item.branchCoverage ?? "null"}${item.coverageIssue ? `, issue=${item.coverageIssue}` : ""}`,
      ),
    ],
    feedback,
  );
}
