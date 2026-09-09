import { Ajv } from "ajv";
import type { RepositoryIngestionJsonValue as JsonValue } from "@forexplore/contracts";
import type { BehaviorCaseResult } from "../multi-agent-differential/behavior-types.js";
import {
  parseBehaviorJson,
  parseObservations,
} from "../multi-agent-differential/behavior-schema.js";

export interface SingleAgentPlan {
  schemaVersion: "1.0";
  mode: "target_only" | "differential";
  referenceReason: string;
  testBasis: { summary: string; evidence: string[] };
  cases: {
    caseId: string;
    intent: string;
    input: JsonValue;
    expectationBasis: "source_observation" | "requirement";
    evidence: string[];
    expected: BehaviorCaseResult;
    sourceCommandId?: string;
  }[];
}
export interface SingleAgentManifest {
  schemaVersion: "1.0";
  targetCommandId: string;
  testFiles: { source: string[]; target: string[] };
  notes: string;
}
const text = { type: "string", minLength: 1, maxLength: 16000, pattern: "\\S" };
const id = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" };
const paths = { type: "array", maxItems: 100, uniqueItems: true, items: text };
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePlan = ajv.compile<SingleAgentPlan>({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "mode", "referenceReason", "testBasis", "cases"],
  properties: {
    schemaVersion: { const: "1.0" },
    mode: { enum: ["target_only", "differential"] },
    referenceReason: text,
    testBasis: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "evidence"],
      properties: {
        summary: text,
        evidence: { type: "array", minItems: 1, maxItems: 100, items: text },
      },
    },
    cases: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "caseId",
          "intent",
          "input",
          "expected",
          "expectationBasis",
          "evidence",
        ],
        properties: {
          caseId: id,
          intent: text,
          input: {},
          expectationBasis: { enum: ["source_observation", "requirement"] },
          evidence: { type: "array", minItems: 1, maxItems: 100, items: text },
          expected: { type: "object" },
          sourceCommandId: id,
        },
      },
    },
  },
});
const validateManifest = ajv.compile<SingleAgentManifest>({
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "targetCommandId", "testFiles", "notes"],
  properties: {
    schemaVersion: { const: "1.0" },
    targetCommandId: id,
    notes: { type: "string", maxLength: 16000 },
    testFiles: {
      type: "object",
      additionalProperties: false,
      required: ["source", "target"],
      properties: { source: paths, target: { ...paths, minItems: 1 } },
    },
  },
});
export function parseSingleAgentPlan(text: string): SingleAgentPlan {
  const value = parseBehaviorJson(text);
  if (!validatePlan(value))
    throw new Error(
      `Invalid single-agent plan: ${ajv.errorsText(validatePlan.errors)}`,
    );
  const ids = value.cases.map((c) => c.caseId);
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate caseId in plan.");
  parseObservations(JSON.stringify(value.cases.map((c) => c.expected)), ids);
  for (const item of value.cases) {
    if (item.expected.caseId !== item.caseId)
      throw new Error("Expected caseId does not match its input.");
    if (value.mode === "target_only" && item.expectationBasis !== "requirement")
      throw new Error("Target-only expectations must be requirement-derived.");
    if ((value.mode === "differential") !== Boolean(item.sourceCommandId))
      throw new Error("Reference command does not match verification mode.");
  }
  return value;
}
export function parseSingleAgentManifest(text: string): SingleAgentManifest {
  const value = parseBehaviorJson(text);
  if (!validateManifest(value))
    throw new Error(
      `Invalid single-agent report: ${ajv.errorsText(validateManifest.errors)}`,
    );
  return value;
}
