import type { ProtocolCheck, VerificationIssue } from "../../types.js";
import { revalidateFunctionGroup } from "../revalidation.js";
import {
  type FinishFeedback,
  type FunctionGroupTestRun,
  type HostTool,
  type HostToolFactory,
  type ToolContext,
} from "./common.js";

export type FinishFunctionGroupInput = {
  testExecutionStatus: FunctionGroupTestRun["status"];
  translationStatus: "success" | "failure";
  issue?: VerificationIssue;
  protocolChecks?: ProtocolCheck[];
};

export type FinishFunctionGroupResult = FinishFunctionGroupInput & {
  functionGroupTest: FunctionGroupTestRun;
};

export type FinishFunctionGroupResponse = FinishFunctionGroupResult | (FinishFeedback & { functionGroupTest: FunctionGroupTestRun });

function parseFinishFunctionGroupInput(value: unknown): FinishFunctionGroupInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("testExecutionStatus" in value) ||
    !("translationStatus" in value)
  ) {
    throw new Error("finish_function_group requires testExecutionStatus and translationStatus.");
  }
  const input = value as Record<string, unknown>;
  if (!(["success", "failure"] as const).includes(input.testExecutionStatus as "success" | "failure")) {
    throw new Error("finish_function_group.testExecutionStatus is invalid.");
  }
  if (!(["success", "failure"] as const).includes(input.translationStatus as "success" | "failure")) {
    throw new Error("finish_function_group.translationStatus is invalid.");
  }
  if (Object.keys(input).some((key) => !["testExecutionStatus", "translationStatus", "issue", "protocolChecks"].includes(key))) {
    throw new Error("finish_function_group contains unknown fields.");
  }
  const noIssue = input.issue === null || (
    input.testExecutionStatus === "success" && input.translationStatus === "success" &&
    typeof input.issue === "object" && input.issue !== null && !Array.isArray(input.issue) &&
    (input.issue as Record<string, unknown>).kind === "none" &&
    Object.keys(input.issue).every(key => key === "kind" || key === "description")
  );
  // Some providers include a no-issue sentinel even when this optional field
  // should be omitted. It adds no facts; execution still checks Host evidence.
  const issue = parseIssue(noIssue ? undefined : input.issue);
  const translationStatus = input.translationStatus as "success" | "failure";
  if (translationStatus === "success" && issue !== undefined) {
    throw new Error("A successful function-group verification cannot include an issue.");
  }
  if (translationStatus === "failure" && issue === undefined) {
    throw new Error("finish_function_group.issue is required when translationStatus is failure.");
  }
  const protocolChecks = input.protocolChecks === undefined ? undefined : parseProtocolChecks(input.protocolChecks);
  return {
    testExecutionStatus: input.testExecutionStatus as "success" | "failure",
    translationStatus,
    ...(issue ? { issue } : {}),
    ...(protocolChecks ? { protocolChecks } : {}),
  };
}

function parseProtocolChecks(value: unknown): ProtocolCheck[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error("finish_function_group.protocolChecks must contain at most three checks.");
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid protocol check.");
    const item = raw as Record<string, unknown>;
    if (typeof item.ruleId !== "string" || !item.ruleId.trim() || !["passed", "failed", "ambiguous", "not-applicable"].includes(String(item.status))) throw new Error("Invalid protocol check.");
    if (item.testName !== undefined && typeof item.testName !== "string") throw new Error("Invalid protocol check testName.");
    if (item.note !== undefined && typeof item.note !== "string") throw new Error("Invalid protocol check note.");
    return { ruleId: item.ruleId.trim().slice(0, 200), status: item.status as ProtocolCheck["status"], ...(typeof item.testName === "string" ? { testName: item.testName.slice(0, 200) } : {}), ...(typeof item.note === "string" ? { note: item.note.slice(0, 500) } : {}) };
  });
}

function parseIssue(value: unknown): VerificationIssue | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("finish_function_group.issue must contain kind and description.");
  }
  const issue = value as Record<string, unknown>;
  if (Object.keys(issue).some((key) => !["kind", "description"].includes(key)) ||
      !["translation", "test", "environment", "unknown"].includes(String(issue.kind)) ||
      typeof issue.description !== "string" || !issue.description.trim()) {
    throw new Error("finish_function_group.issue is invalid.");
  }
  return {
    kind: issue.kind as VerificationIssue["kind"],
    description: issue.description,
  };
}

export function createFinishFunctionGroupTool(): HostToolFactory {
  return (context: ToolContext): HostTool<FinishFunctionGroupInput, FinishFunctionGroupResponse> => ({
    name: "finish_function_group",
    description: `Rerun every test in the dedicated folder and finish ${context.runtime.sourceLanguage} to ${context.runtime.targetLanguage} verification. All tests must compile and every upstream target function must execute. Success requires all tests to pass; failing assertions may establish a production bug. Include up to three protocolChecks when supplied. Unmet completion checks return feedback and the current Host result so you can continue debugging.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["testExecutionStatus", "translationStatus"],
      properties: {
        testExecutionStatus: { enum: ["success", "failure"] },
        translationStatus: { enum: ["success", "failure"] },
        issue: { anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false, required: ["kind", "description"],
          properties: {
            kind: { enum: ["translation", "test", "environment", "unknown"] },
            description: { type: "string", minLength: 1 },
          },
        }] },
        protocolChecks: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["ruleId", "status"], properties: { ruleId: { type: "string", minLength: 1 }, status: { enum: ["passed", "failed", "ambiguous", "not-applicable"] }, testName: { type: "string" }, note: { type: "string" } } } },
      },
    },
    parse: parseFinishFunctionGroupInput,
    isTerminal: output => !("outcome" in output),
    async execute(input) {
      const { observation: result, feedback } = await revalidateFunctionGroup(context, input);
      if (feedback.length > 0) return { outcome: "continue" as const, feedback, functionGroupTest: result };
      return {
        ...input,
        functionGroupTest: result,
      };
    },
  });
}
