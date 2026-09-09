import { Ajv } from "ajv";
import type { RepositoryIngestionJsonValue as JsonValue } from "@forexplore/contracts";
import type {
  BehaviorCollectionManifest,
  BehaviorCaseInput,
  BehaviorTargetManifest,
  BehaviorTargetPlan,
  BehaviorCaseResult,
} from "./behavior-types.js";

const command = {
  type: "object",
  additionalProperties: false,
  required: ["executable", "args"],
  properties: {
    executable: { type: "string", minLength: 1, maxLength: 4096 },
    args: {
      type: "array",
      maxItems: 100,
      items: { type: "string", maxLength: 16000 },
    },
  },
};
const properties = {
  schemaVersion: { const: "2.0" },
  testFiles: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 1024 },
  },
  resultFile: {
    type: "string",
    pattern: "^\\.forexplore-tests/[^\\\\]+\\.json$",
    maxLength: 1024,
  },
  notes: { type: "string", maxLength: 16000 },
  commands: {
    type: "object",
    additionalProperties: false,
    required: ["setup", "run"],
    properties: {
      setup: { type: "array", maxItems: 8, items: command },
      run: command,
    },
  },
};
export const collectionManifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "testFiles", "notes", "cases"],
  properties: {
    ...properties,
    schemaVersion: { const: "3.0" },
    testFiles: { ...properties.testFiles, minItems: 0 },
    cases: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["caseId", "intent", "input", "expectation"],
        properties: {
          caseId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
          intent: { type: "string", minLength: 1, maxLength: 4000 },
          input: {},
          setup: {},
          operations: { type: "array", maxItems: 100, items: {} },
          observe: {},
          expectation: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "rationale", "provenance"],
            properties: {
              kind: { enum: ["source", "requirement", "unresolved"] },
              rationale: { type: "string", pattern: "\\S", maxLength: 4000 },
              provenance: {
                type: "array",
                minItems: 1,
                maxItems: 100,
                uniqueItems: true,
                items: { type: "string", pattern: "\\S", maxLength: 4000 },
              },
              expected: { type: "object" },
            },
            oneOf: [
              {
                properties: { kind: { const: "requirement" } },
                required: ["expected"],
              },
              {
                properties: { kind: { enum: ["source", "unresolved"] } },
                not: { required: ["expected"] },
              },
            ],
          },
        },
      },
    },
  },
};
export const targetPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "testBasis", "cases"],
  properties: {
    schemaVersion: { const: "1.0" },
    testBasis: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "evidence"],
      properties: {
        summary: { type: "string", pattern: "\\S", maxLength: 16000 },
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          uniqueItems: true,
          items: { type: "string", pattern: "\\S", maxLength: 4000 },
        },
      },
    },
    cases: {
      ...collectionManifestSchema.properties.cases,
      items: {
        ...collectionManifestSchema.properties.cases.items,
        properties: {
          ...collectionManifestSchema.properties.cases.items.properties,
          expectation: {
            ...collectionManifestSchema.properties.cases.items.properties
              .expectation,
            properties: {
              ...collectionManifestSchema.properties.cases.items.properties
                .expectation.properties,
              kind: { enum: ["requirement", "unresolved"] },
            },
            oneOf: [
              {
                properties: { kind: { const: "requirement" } },
                required: ["expected"],
              },
              {
                properties: { kind: { const: "unresolved" } },
                not: { required: ["expected"] },
              },
            ],
          },
        },
      },
    },
  },
};
export const targetManifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "testFiles", "notes", "commands"],
  properties,
};
const observationSchema = {
  type: "array",
  minItems: 1,
  maxItems: 100,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["caseId", "outcome"],
    properties: {
      caseId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
      outcome: { enum: ["return", "exception"] },
      value: {},
      error: {
        type: "object",
        additionalProperties: false,
        required: ["category", "message"],
        properties: {
          category: { type: "string", minLength: 1, maxLength: 1000 },
          message: { type: "string", maxLength: 16000 },
        },
      },
    },
    oneOf: [
      {
        properties: { outcome: { const: "return" } },
        required: ["value"],
        not: { required: ["error"] },
      },
      {
        properties: { outcome: { const: "exception" } },
        required: ["error"],
        not: { required: ["value"] },
      },
    ],
  },
};
const ajv = new Ajv({ allErrors: true, strict: false });
const sourceValidator = ajv.compile<BehaviorCollectionManifest>(
  collectionManifestSchema,
);
const planValidator = ajv.compile<BehaviorTargetPlan>(targetPlanSchema);
const targetValidator =
  ajv.compile<BehaviorTargetManifest>(targetManifestSchema);
const observationValidator =
  ajv.compile<BehaviorCaseResult[]>(observationSchema);

export function parseBehaviorJson(
  text: string,
  maxBytes = 1024 * 1024,
  maxDepth = 16,
): JsonValue {
  if (Buffer.byteLength(text) > maxBytes)
    throw new Error("Behavior JSON exceeds byte budget.");
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (cause) {
    throw new Error("Invalid behavior JSON.", { cause });
  }
  const visit = (item: unknown, depth: number): void => {
    if (depth > maxDepth) throw new Error("Behavior JSON exceeds depth limit.");
    if (typeof item === "number" && !Number.isFinite(item))
      throw new Error("Non-finite JSON number.");
    if (
      typeof item === "number" &&
      Number.isInteger(item) &&
      !Number.isSafeInteger(item)
    )
      throw new Error("Unsafe JSON integer; encode it as a string.");
    if (item && typeof item === "object")
      for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  return value;
}
export function parseCollectionManifest(
  text: string,
): BehaviorCollectionManifest {
  const value = parseBehaviorJson(text);
  if (!sourceValidator(value))
    throw new Error(
      `Invalid collection manifest: ${ajv.errorsText(sourceValidator.errors)}`,
    );
  validateCases(value.cases);
  const sourceCases = value.cases.some(
    (item) => item.expectation.kind === "source",
  );
  if (sourceCases && (!value.commands || !value.testFiles.length))
    throw new Error("Source expectations require executable source tests.");
  if (
    !sourceCases &&
    (value.commands || value.testFiles.length || value.resultFile)
  )
    throw new Error("Design-only collections cannot declare source execution.");
  return normalizeTestFiles(value);
}
export function parseTargetPlan(text: string): BehaviorTargetPlan {
  const value = parseBehaviorJson(text);
  if (!planValidator(value))
    throw new Error(
      `Invalid target plan: ${ajv.errorsText(planValidator.errors)}`,
    );
  validateCases(value.cases);
  return value;
}
function validateCases(cases: BehaviorCaseInput[]): void {
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length)
    throw new Error("Duplicate caseId.");
  for (const item of cases)
    if (item.expectation.kind === "requirement")
      parseObservations(JSON.stringify([item.expectation.expected]), [
        item.caseId,
      ]);
}
export function parseTargetManifest(text: string): BehaviorTargetManifest {
  const value = parseBehaviorJson(text);
  if (!targetValidator(value))
    throw new Error(
      `Invalid target manifest: ${ajv.errorsText(targetValidator.errors)}`,
    );
  return normalizeTestFiles(value);
}
function normalizeTestFiles<
  T extends Pick<BehaviorTargetManifest, "testFiles" | "resultFile">,
>(manifest: T): T {
  for (const path of manifest.testFiles) {
    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Test files must be canonical project-relative paths.");
  }
  if (
    manifest.resultFile &&
    ([
      ".forexplore-tests/manifest.json",
      ".forexplore-tests/inputs.json",
      ".forexplore-tests/target-plan.json",
    ].includes(manifest.resultFile) ||
      manifest.testFiles.includes(manifest.resultFile) ||
      manifest.resultFile
        .split("/")
        .some((part) => !part || part === "." || part === ".."))
  )
    throw new Error(
      "Result file must be a dedicated JSON output, not a frozen input or test file.",
    );
  return manifest;
}
export function parseObservations(
  text: string,
  caseIds: string[],
): BehaviorCaseResult[] {
  const value = parseBehaviorJson(text);
  if (!observationValidator(value))
    throw new Error(
      `Invalid observations: ${ajv.errorsText(observationValidator.errors)}`,
    );
  const ids = value.map((item) => item.caseId);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== caseIds.length ||
    ids.some((id) => !caseIds.includes(id))
  )
    throw new Error("Observations must cover every case exactly once.");
  return value;
}
