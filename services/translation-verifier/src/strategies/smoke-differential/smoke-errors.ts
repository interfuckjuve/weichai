import type { VerificationProblem } from "../../schemas/verification-types.js";

export class SmokeVerificationError extends Error {
  constructor(
    readonly code: VerificationProblem["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SmokeVerificationError";
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}
