import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";

export function normalizeArtifactPath(value: string): string {
  return normalizeRepositoryRelativePath(value, "Verification artifact path");
}

export function normalizeRepositoryRelativePath(
  value: unknown,
  label: string,
): string {
  const pathValue = requireString(value, label);
  if (
    pathValue.startsWith("/") ||
    pathValue.startsWith("\\") ||
    /^[A-Za-z]:/.test(pathValue) ||
    /^\\\\/.test(pathValue)
  ) {
    throw new Error(
      `${label} must be a normalized safe repository-relative POSIX path.`,
    );
  }
  if (pathValue.includes("\\")) {
    throw new Error(
      `${label} must be a normalized safe repository-relative POSIX path.`,
    );
  }
  const normalized = pathPosix.normalize(pathValue);
  if (
    normalized !== pathValue ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error(
      `${label} must be a normalized safe repository-relative POSIX path.`,
    );
  }
  return normalized;
}

export function cloneJsonValue<T>(value: T, label: string): T {
  assertJsonCompatible(value, label);
  return structuredClone(value);
}

export function assertJsonCompatible(value: unknown, label: string): void {
  assertJsonCompatibleValue(value, label, new Set<object>());
}

function assertJsonCompatibleValue(
  value: unknown,
  label: string,
  active: Set<object>,
): void {
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(
          `${label} must be JSON-compatible; non-finite numbers are not allowed.`,
        );
      }
      return;
    case "undefined":
      throw new Error(
        `${label} must be JSON-compatible; undefined is not allowed.`,
      );
    case "function":
      throw new Error(
        `${label} must be JSON-compatible; functions are not allowed.`,
      );
    case "symbol":
      throw new Error(
        `${label} must be JSON-compatible; symbols are not allowed.`,
      );
    case "bigint":
      throw new Error(
        `${label} must be JSON-compatible; bigints are not allowed.`,
      );
    case "object":
      break;
    default:
      throw new Error(
        `${label} must be JSON-compatible; unsupported values are not allowed.`,
      );
  }

  if (value === null) {
    return;
  }

  if (Array.isArray(value)) {
    if (active.has(value)) {
      throw new Error(
        `${label} must be JSON-compatible; cyclic references are not allowed.`,
      );
    }
    active.add(value);
    try {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new Error(
          `${label} must be JSON-compatible; symbol keys are not allowed.`,
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        assertJsonCompatibleValue(value[index], `${label}[${index}]`, active);
      }
    } finally {
      active.delete(value);
    }
    return;
  }

  if (!isPlainObject(value)) {
    throw new Error(
      `${label} must be JSON-compatible; non-plain objects are not allowed.`,
    );
  }
  if (active.has(value)) {
    throw new Error(
      `${label} must be JSON-compatible; cyclic references are not allowed.`,
    );
  }
  active.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error(
        `${label} must be JSON-compatible; symbol keys are not allowed.`,
      );
    }
    for (const key of Object.keys(value)) {
      assertJsonCompatibleValue(value[key], `${label}.${key}`, active);
    }
  } finally {
    active.delete(value);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string.`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
