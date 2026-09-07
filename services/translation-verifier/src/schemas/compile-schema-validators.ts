import { createRequire } from "node:module";
import { Ajv, type ValidateFunction } from "ajv";
import type InputSchema from "./verification-input.schema.json";
import type OutputSchema from "./verification-output.schema.json";
import type RunSchema from "./verification-run.schema.json";
import type { VerificationRun, VerificationRunEvent, VerificationInput, VerificationReceipt, VerificationResult, VerificationStrategyDescriptor, VerificationStrategyOutput } from "./verification-types.js";

// Keep loading compatible with consumers using module=ES2022; type imports also include JSON in tsc output.
const require = createRequire(import.meta.url);
const inputSchema: typeof InputSchema = require("./verification-input.schema.json");
const outputSchema: typeof OutputSchema = require("./verification-output.schema.json");

const runSchema: typeof RunSchema = require("./verification-run.schema.json");

// Compile trusted local schemas once without custom validation keywords.
const ajv = new Ajv({
  strict: true, ownProperties: true,
  coerceTypes: false, useDefaults: false, removeAdditional: false,
});
ajv.addSchema(inputSchema, new URL("verification-input.schema.json", runSchema.$id).href);
ajv.addSchema(outputSchema, new URL("verification-output.schema.json", runSchema.$id).href);
ajv.addSchema(runSchema);
export const validateRunSchema = ajv.getSchema<VerificationRun>(runSchema.$id)!;
export const validateRunEventSchema = ajv.compile<VerificationRunEvent>({
  $ref: `${runSchema.$id}#/definitions/event`,
});
export const validateInputSchema = ajv.getSchema<VerificationInput>(inputSchema.$id)!;
export const validateResultSchema = ajv.getSchema<VerificationResult>(
  outputSchema.$id,
)!;
export const validateStrategyOutputSchema =
  ajv.compile<VerificationStrategyOutput>({
    $ref: `${outputSchema.$id}#/definitions/strategyOutput`,
  });
export const validateDescriptorSchema =
  ajv.compile<VerificationStrategyDescriptor>({
    $ref: `${outputSchema.$id}#/definitions/strategyDescriptor`,
  });
export const validateReceiptSchema = ajv.compile<VerificationReceipt>({
  $ref: `${outputSchema.$id}#/definitions/receipt`,
});

export function assertSchema<T>(
  validate: ValidateFunction<T>,
  value: unknown,
  label: string,
): asserts value is T {
  if (validate(value)) return;
  const error = validate.errors?.[0];
  const segments = (error?.instancePath ?? "").split("/").slice(1);
  if (error?.keyword === "required")
    segments.push(String(error.params.missingProperty));
  const location = segments
    .map((part) =>
      /^\d+$/.test(part)
        ? `[${part}]`
        : `.${part.replaceAll("~1", "/").replaceAll("~0", "~")}`,
    )
    .join("");
  throw new Error(
    `${label}${location} ${error?.message ?? "does not match its JSON Schema"}.`,
  );
}
