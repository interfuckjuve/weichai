import type { VerificationIssue, VerificationIssueKind } from "../../types.js";
import {
  type HostTool,
  type HostToolFactory,
  type TargetTestResult,
  type ToolContext,
} from "./common.js";

export type TranslationStatus = "success" | "failure";
export type IssueKind = VerificationIssueKind;
export type FinishIssue = VerificationIssue;

export type FinishInput = {
  testExecutionStatus: TargetTestResult["status"];
  translationStatus: TranslationStatus;
  issue?: FinishIssue;
};

export type FinishResult = {
  testExecutionStatus: TargetTestResult["status"];
  translationStatus: TranslationStatus;
  issue?: FinishIssue;
  /** Host-observed test status; Agent input never controls this field. */
  targetTest: TargetTestResult;
};

const testStatuses = new Set<TargetTestResult["status"]>([
  "success",
  "failure",
]);
const translationStatuses = new Set<TranslationStatus>([
  "success",
  "failure",
]);
const issueKinds = new Set<IssueKind>([
  "translation",
  "test",
  "environment",
  "unknown",
]);

function parseFinishInput(value: unknown): FinishInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        key !== "testExecutionStatus" &&
        key !== "translationStatus" &&
        key !== "issue",
    ) ||
    !("testExecutionStatus" in value) ||
    !("translationStatus" in value)
  ) {
    throw new Error(
      "finish requires testExecutionStatus and translationStatus.",
    );
  }
  const input = value as {
    testExecutionStatus: unknown;
    translationStatus: unknown;
    issue?: unknown;
  };
  if (
    typeof input.testExecutionStatus !== "string" ||
    !testStatuses.has(input.testExecutionStatus as TargetTestResult["status"])
  ) {
    throw new Error("finish.testExecutionStatus is invalid.");
  }
  if (
    typeof input.translationStatus !== "string" ||
    !translationStatuses.has(input.translationStatus as TranslationStatus)
  ) {
    throw new Error(
      "finish.translationStatus must be success or failure.",
    );
  }

  const issue = parseIssue(input.issue);
  const translationStatus = input.translationStatus as TranslationStatus;
  if (translationStatus === "success" && issue !== undefined) {
    throw new Error("A successful translation cannot include an issue.");
  }
  if (translationStatus !== "success" && issue === undefined) {
    throw new Error(
      "finish.issue is required when translationStatus is failure.",
    );
  }
  if (translationStatus === "failure" && issue?.kind !== "translation") {
    throw new Error("A failed translation requires a translation issue.");
  }

  return {
    testExecutionStatus: input.testExecutionStatus as TargetTestResult["status"],
    translationStatus,
    ...(issue ? { issue } : {}),
  };
}

function parseIssue(value: unknown): FinishIssue | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "kind" && key !== "description") ||
    !("kind" in value) ||
    !("description" in value)
  ) {
    throw new Error("finish.issue must contain kind and description.");
  }
  const issue = value as { kind: unknown; description: unknown };
  if (
    typeof issue.kind !== "string" ||
    !issueKinds.has(issue.kind as IssueKind)
  ) {
    throw new Error("finish.issue.kind is invalid.");
  }
  if (typeof issue.description !== "string" || !issue.description.trim()) {
    throw new Error("finish.issue.description must be non-empty.");
  }
  return {
    kind: issue.kind as IssueKind,
    description: issue.description,
  };
}

export function createFinishTool(): HostToolFactory {
  return (context: ToolContext): HostTool<FinishInput, FinishResult> => ({
    name: "finish",
    description: `Finish ${context.runtime.sourceLanguage} to ${context.runtime.targetLanguage} verification after reporting the Host-observed test status and translation assessment.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["testExecutionStatus", "translationStatus"],
      properties: {
        testExecutionStatus: {
          enum: ["success", "failure"],
        },
        translationStatus: {
          enum: ["success", "failure"],
        },
        issue: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "description"],
          properties: {
            kind: {
              enum: ["translation", "test", "environment", "unknown"],
            },
            description: { type: "string" },
          },
        },
      },
    },
    parse: parseFinishInput,
    async execute(input) {
      const targetTest = context.state.lastTargetTest;
      if (targetTest === undefined) {
        throw new Error("Run run_target_tests before finish.");
      }
      if (input.testExecutionStatus !== targetTest.status) {
        throw new Error(
          [
            `finish.testExecutionStatus does not match the Host result: expected ${targetTest.status}.`,
            `Host target test result: ${JSON.stringify(targetTest)}`,
          ].join("\n"),
        );
      }
      if (input.translationStatus !== targetTest.status) {
        throw new Error(
          [
            `finish.translationStatus does not match the Host result: expected ${targetTest.status}.`,
            `Host target test result: ${JSON.stringify(targetTest)}`,
          ].join("\n"),
        );
      }
      return {
        testExecutionStatus: targetTest.status,
        translationStatus: input.translationStatus,
        ...(input.issue ? { issue: { ...input.issue } } : {}),
        targetTest,
      };
    },
  });
}
