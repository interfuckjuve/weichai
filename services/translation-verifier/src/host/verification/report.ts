import type { BaseMessage } from "@langchain/core/messages";
import type {
  FunctionGroupFunctionResult,
  ProtocolCheck,
  TargetFunctionCoverage,
  VerificationFunction,
  VerificationIssue,
  VerificationReason,
} from "../../types.js";
import type { FunctionGroupTestRun, TargetTestResult } from "../tools/common.js";
import { messageText } from "../agent/messages.js";

/** The Agent's own conclusion in a plain final assistant message. */
export type FinalReportClaim = {
  verdict: "no-bug" | "bug-found" | "uncertain";
  summary: string;
  issue?: VerificationIssue;
  /** Target functions the Agent identifies as affected by a reported bug. */
  affectedTargets?: VerificationFunction[];
  /** Up to three bounded module-protocol checks. */
  protocolChecks?: ProtocolCheck[];
};

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

export type ParsedReport = {
  report?: FinalReportClaim;
  problems: string[];
};

const VERDICTS = new Set(["no-bug", "bug-found", "uncertain"]);

/**
 * Parse and shape-check the ordinary final assistant message. Only the plain
 * report is accepted: the Agent never ends the run through a tool call.
 */
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

/** Protocol checks stay bounded, mirroring the existing public shape. */
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
