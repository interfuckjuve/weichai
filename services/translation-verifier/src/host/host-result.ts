import type {
  FunctionGroupFunctionResult,
  ProtocolCheck,
  TargetFunctionCoverage,
  VerificationIssue,
  VerificationReason,
  VerificationTestCase,
} from "../types.js";
import type { FinalReportClaim } from "./final-report.js";
import type { FunctionGroupTestRun, TargetTestResult } from "./tools/common.js";

/** Accepted Agent report plus the Host's fresh observation of the target function. */
export type AgentHostResult = {
  verdict: FinalReportClaim["verdict"];
  summary: string;
  issue?: VerificationIssue;
  targetFunction?: TargetFunctionCoverage;
};

/** Accepted function-group report plus the Host's fresh per-function observation. */
export type FunctionGroupHostResult = {
  verdict: FinalReportClaim["verdict"];
  summary: string;
  issue?: VerificationIssue;
  functions: FunctionGroupFunctionResult[];
  reason?: VerificationReason;
  protocolChecks?: ProtocolCheck[];
};

/** Keep the model-visible feedback bounded; the full observation stays in the trace. */
const MAX_FEEDBACK_CHARS = 12_000;

export function acceptedResult(
  report: FinalReportClaim,
  observation: TargetTestResult,
): AgentHostResult {
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

export function acceptedFunctionGroupResult(
  report: FinalReportClaim,
  observation: FunctionGroupTestRun,
): FunctionGroupHostResult {
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

/** One Host observation rendered for the model; both task shapes share these lines. */
type FeedbackObservation = {
  status: "success" | "failure";
  exitCode: number | null;
  timedOut?: boolean;
  executionErrors?: number;
  tests?: { executed: number; passed: number; failed: number; skipped: number };
  testCases?: VerificationTestCase[];
  stdout: string;
  stderr: string;
  reportPaths?: string[];
};

/**
 * Concrete diagnostics the Agent needs to repair the same tests: counts,
 * failed cases, report locations and the runner output (Maven and other JVM
 * runners usually report compilation problems on stdout).
 */
function observationFeedbackLines(observation: FeedbackObservation): string[] {
  const failedCases = (observation.testCases ?? []).filter(item => item.status === "failed").slice(0, 5);
  return [
    `- status: ${observation.status}`,
    `- timed out: ${observation.timedOut === true}`,
    `- execution errors: ${observation.executionErrors ?? 0}`,
    observation.tests
      ? `- tests executed: ${observation.tests.executed}, passed: ${observation.tests.passed}, failed: ${observation.tests.failed}, skipped: ${observation.tests.skipped}`
      : "- no test summary was parsed",
    ...(failedCases.length > 0
      ? [
        "- failed test cases:",
        ...failedCases.map(item => `  - ${item.id}${item.message ? `: ${boundedText(item.message, 500)}` : ""}`),
      ]
      : []),
    `- report paths: ${observation.reportPaths?.join(", ") || "(none)"}`,
    ...(observation.stdout.trim() ? [`- stdout: ${boundedText(observation.stdout.trim(), 2_000)}`] : []),
    ...(observation.stderr.trim() ? [`- stderr: ${boundedText(observation.stderr.trim(), 2_000)}`] : []),
  ];
}

/** One bounded feedback message per round; the complete observation stays in the trace. */
function hostFeedbackMessage(details: readonly string[], feedback: readonly string[]): string {
  const message = [
    "The Host did not accept your final report. Continue in this same task, fix the same tests in the same working directory, and end with a corrected final JSON report.",
    "",
    "Fresh Host revalidation of the complete dedicated test folder:",
    ...details,
    "",
    "Unmet completion conditions:",
    ...feedback.map(item => `- ${item}`),
  ].join("\n");
  return message.length <= MAX_FEEDBACK_CHARS
    ? message
    : `${message.slice(0, MAX_FEEDBACK_CHARS)}\n...(feedback truncated; the complete Host observation is in the run trace)`;
}

/** Bound model-visible diagnostics; the Host trace keeps the complete observation. */
function boundedText(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Host retained ${text.length - limit} additional diagnostic characters]`;
}

export function feedbackMessage(
  feedback: readonly string[],
  observation: TargetTestResult,
): string {
  const coverage = observation.coverage;
  return hostFeedbackMessage([
    ...observationFeedbackLines(observation),
    `- target function executed: ${coverage?.status === "available" ? String(coverage.targetFunction.executed) : "unknown"}`,
  ], feedback);
}

export function functionGroupFeedbackMessage(
  feedback: readonly string[],
  observation: FunctionGroupTestRun,
): string {
  return hostFeedbackMessage([
    ...observationFeedbackLines(observation),
    "- target function coverage from this run:",
    ...observation.functions.map(item =>
      `  - ${item.target.path}#${item.target.name}${item.target.signature ? ` (${item.target.signature})` : ""}: executed=${item.executed}, status=${item.status}, line=${item.lineCoverage ?? "null"}, branch=${item.branchCoverage ?? "null"}${item.coverageIssue ? `, issue=${item.coverageIssue}` : ""}`,
    ),
  ], feedback);
}
