import { Ajv } from "ajv";
import type { RepositoryIngestionJsonValue as JsonValue } from "@forexplore/contracts";
import type {
  BehaviorCollectionManifest,
  BehaviorTargetManifest,
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
  schemaVersion: { const: "1.0" },
  testFiles: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    items: { type: "string", minLength: 1, maxLength: 1024 },
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
  required: ["schemaVersion", "testFiles", "notes", "commands", "cases"],
  properties: {
    ...properties,
    cases: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["caseId", "intent", "input"],
        properties: {
          caseId: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" },
          intent: { type: "string", minLength: 1, maxLength: 4000 },
          input: {},
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
  if (
    new Set(value.cases.map((item) => item.caseId)).size !== value.cases.length
  )
    throw new Error("Duplicate caseId.");
  return normalizeTestFiles(value);
}
export function parseTargetManifest(text: string): BehaviorTargetManifest {
  const value = parseBehaviorJson(text);
  if (!targetValidator(value))
    throw new Error(
      `Invalid target manifest: ${ajv.errorsText(targetValidator.errors)}`,
    );
  return normalizeTestFiles(value);
}
function normalizeTestFiles<T extends BehaviorTargetManifest>(manifest: T): T {
  const prefix = ".forexplore-tests/";
  const testFiles = manifest.testFiles.map((path) =>
    path.startsWith(prefix) ? path.slice(prefix.length) : path,
  );
  if (new Set(testFiles).size !== testFiles.length)
    throw new Error("Duplicate canonical test file.");
  return { ...manifest, testFiles };
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
