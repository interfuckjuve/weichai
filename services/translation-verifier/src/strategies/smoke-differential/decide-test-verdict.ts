import { isDeepStrictEqual } from "node:util";
import {
  failureAssessment,
  resolveVerificationPolicy,
} from "../../schemas/verification-assessment.js";
import type {
  VerificationAssessment,
  VerificationInput,
  VerificationProblem,
} from "../../schemas/verification-types.js";
import type {
  CaseResult,
  CommandEvidence,
  SmokeCaseVerdict,
  SmokeReport,
  SmokeSide,
} from "./differential-test-types.js";

type PolicyInput = Pick<VerificationInput, "verificationPolicy">;
export interface SmokeEvaluation extends VerificationAssessment {
  bugCases: SmokeCaseVerdict[];
  summary: string;
}

function rejected(
  input: PolicyInput,
  summary: string,
  code: VerificationProblem["code"] = "report_evidence_invalid",
): SmokeEvaluation {
  return {
    ...failureAssessment(input, code, summary),
    bugCases: [],
    summary,
  };
}

/** stdout is a structured observation, not model-authored prose or a substring match. */
function observations(stdout: string): unknown[] {
  const unpack = (value: unknown): unknown[] => {
    if (Array.isArray(value)) return value;
    if (
      value &&
      typeof value === "object" &&
      "cases" in value &&
      Array.isArray(value.cases)
    )
      return value.cases;
    return [value];
  };
  try {
    return unpack(JSON.parse(stdout));
  } catch {
    return stdout.split("\n").flatMap((line) => {
      try {
        return unpack(JSON.parse(line));
      } catch {
        return [];
      }
    });
  }
}

function aggregate(
  cases: SmokeCaseVerdict[],
  side: SmokeSide,
): VerificationAssessment["targetAssessment"] {
  const states = cases.map((item) => item[`${side}Assessment`]);
  for (const state of [
    "bug_found",
    "suspected_bug",
    "inconclusive",
    "not_checked",
  ] as const) {
    if (states.includes(state)) return state;
  }
  return "no_bug_observed";
}

export function evaluateSmokeReport(
  report: SmokeReport,
  evidence: readonly CommandEvidence[],
  input: PolicyInput = {},
): SmokeEvaluation {
  const { testBasis, ...policy } = resolveVerificationPolicy(input);
  if (!testBasis?.trim())
    return rejected(
      input,
      "Independent Host-confirmed test basis is missing.",
      "insufficient_test_basis",
    );
  if (!report.cases.length) return rejected(input, "Report contains no cases.");
  if (report.rounds !== 0 || report.targetFiles.length !== 0)
    return rejected(input, "verify-only report contains target repairs.");
  const sides: SmokeSide[] =
    policy.mode === "differential" ? ["source", "target"] : ["target"];
  if (
    evidence.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        !["source", "target"].includes(item.side) ||
        !["compile", "run"].includes(item.phase) ||
        typeof item.commandId !== "string" ||
        !item.commandId.trim() ||
        typeof item.stdout !== "string" ||
        typeof item.stderr !== "string" ||
        typeof item.baselineValid !== "boolean" ||
        typeof item.timedOut !== "boolean" ||
        !Number.isFinite(item.durationMs) ||
        item.durationMs < 0 ||
        (item.exitCode !== null &&
          (!Number.isInteger(item.exitCode) || item.exitCode < 0)),
    )
  )
    return rejected(input, "Command evidence has an invalid structure.");
  if (evidence.some((item) => item.baselineValid !== true))
    return rejected(
      input,
      "A command violated the workspace baseline.",
      "workspace_integrity_violation",
    );
  if (
    policy.mode === "target_only" &&
    (evidence.some((item) => item.side === "source") ||
      report.sourceIssues.length > 0 ||
      report.runnerFiles?.some((item) => item.side === "source"))
  )
    return rejected(
      input,
      "Target-only report contains forbidden source activity.",
    );
  const executions = report.executions ?? [];
  if (!executions.length)
    return rejected(input, "Report declares no execution evidence.");
  const claimed = new Map<string, CommandEvidence>();
  const seenClaims = new Set<string>();
  for (const claim of executions) {
    const matches = evidence.filter(
      (item) => item.commandId === claim.commandId,
    );
    if (matches.length !== 1 || seenClaims.has(claim.commandId))
      return rejected(
        input,
        `Command ${claim.commandId} does not identify exactly one execution.`,
      );
    seenClaims.add(claim.commandId);
    const record = matches[0];
    if (
      record.side !== claim.side ||
      record.phase !== claim.phase ||
      record.exitCode !== claim.exitCode ||
      record.durationMs !== claim.durationMs
    )
      return rejected(
        input,
        `Command ${claim.commandId} metadata disagrees with the report.`,
      );
    // Failed attempts remain execution problems, not evidence for a code conclusion.
    if (record.timedOut || record.exitCode !== 0) continue;
    claimed.set(claim.commandId, record);
  }
  const commandProblems: VerificationProblem[] = evidence
    .filter((item, index) => {
      if (!item.timedOut && item.exitCode === 0) return false;
      // A successful claimed compile supersedes an earlier runner compile error, not a lost test run or timeout.
      return (
        item.phase !== "compile" ||
        item.timedOut ||
        !evidence
          .slice(index + 1)
          .some(
            (retry) =>
              retry.side === item.side &&
              retry.phase === "compile" &&
              claimed.has(retry.commandId),
          )
      );
    })
    .map((item) => ({
      code: item.timedOut ? "command_timeout" : "environment_unavailable",
      message: `${item.side} ${item.phase} command did not complete successfully.`,
      side: item.side,
      commandId: item.commandId,
    }));
  for (const side of sides) {
    for (const phase of ["compile", "run"] as const) {
      if (
        ![...claimed.values()].some(
          (item) => item.side === side && item.phase === phase,
        )
      )
        return rejected(
          input,
          `Missing successful ${side} ${phase} evidence.`,
          commandProblems.find((problem) => problem.side === side)?.code ??
            "report_evidence_invalid",
        );
    }
  }
  for (const item of report.cases) {
    if (
      !item.requirement ||
      item.requirement.basis !== testBasis ||
      !item.commandIds
    )
      return rejected(
        input,
        `Case ${item.caseId} lacks Host basis or per-case run references.`,
      );
    if (
      policy.mode === "target_only" &&
      (item.source !== null ||
        item.sourceAssessment !== "not_checked" ||
        item.commandIds.source !== undefined ||
        item.requirement.expectedBySide?.source !== undefined)
    )
      return rejected(
        input,
        `Case ${item.caseId} assesses an unchecked source.`,
      );
    for (const side of sides) {
      const record = claimed.get(item.commandIds[side] ?? "");
      const observed = item[side];
      const assessment = item[`${side}Assessment`];
      if (
        !record ||
        record.side !== side ||
        record.phase !== "run" ||
        !observed ||
        !assessment ||
        assessment === "not_checked"
      )
        return rejected(
          input,
          `Case ${item.caseId} has no valid ${side} run binding or assessment.`,
        );
      const matchingCases = observations(record.stdout).filter(
        (value) =>
          value &&
          typeof value === "object" &&
          "caseId" in value &&
          value.caseId === item.caseId,
      );
      if (
        matchingCases.length !== 1 ||
        !isDeepStrictEqual(matchingCases[0], observed)
      )
        return rejected(
          input,
          `Case ${item.caseId} ${side} observation differs from actual stdout.`,
        );
      const matchesExpected = sameBehavior(
        observed,
        item.requirement.expectedBySide?.[side] ?? item.requirement.expected,
      );
      if (
        (assessment === "bug_found" && matchesExpected) ||
        (assessment === "no_bug_observed" && !matchesExpected)
      )
        return rejected(
          input,
          `Case ${item.caseId} ${side} assessment contradicts its independent expected observation.`,
        );
    }
  }
  const problems = commandProblems;
  const assessment: VerificationAssessment = {
    ...policy,
    executionStatus: problems.length ? "partial" : "completed",
    sourceAssessment:
      policy.mode === "target_only"
        ? "not_checked"
        : aggregate(report.cases, "source"),
    targetAssessment: aggregate(report.cases, "target"),
    problems,
  };
  return {
    ...assessment,
    bugCases: report.cases.filter(
      (item) => item.targetAssessment === "bug_found",
    ),
    summary: report.summary,
  };
}

function sameBehavior(observed: CaseResult, expected: CaseResult): boolean {
  return isDeepStrictEqual(observed, expected);
}
