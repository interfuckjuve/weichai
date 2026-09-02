import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const defaultProjectPath = fileURLToPath(
  new URL("../../../fixtures/target-system/commons-fileupload-java-skeleton", import.meta.url),
);

export interface AdaptationServiceConfig {
  host: string;
  port: number;
  /** Optional explicit browser origin. Extension-host requests do not need CORS. */
  corsOrigin?: string;
  apiKey: string;
  skeletonProjectPath: string;
  projectRoot: string;
  /** Server-owned analysis snapshot location used by the read-only planner. */
  analysisRoot: string;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdaptationServiceConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required to start the adaptation service.");
  }

  const skeletonProjectPath = resolveConfiguredPath(
    env.ADAPTATION_SKELETON_PROJECT_PATH?.trim() ||
      env.ADAPTATION_SKELETON_PATH?.trim(),
    defaultProjectPath,
  );

  const projectRoot = resolveConfiguredPath(
    env.ADAPTATION_PROJECT_ROOT?.trim(),
    skeletonProjectPath,
  );

  return {
    host: env.ADAPTATION_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env.ADAPTATION_PORT, 8788, "ADAPTATION_PORT"),
    corsOrigin: env.ADAPTATION_CORS_ORIGIN?.trim() || undefined,
    apiKey,
    skeletonProjectPath,
    projectRoot,
    analysisRoot: resolveConfiguredPath(
      env.ADAPTATION_ANALYSIS_ROOT?.trim(),
      join(projectRoot, ".forexplore", "analysis"),
    ),
  };
}

function resolveConfiguredPath(value: string | undefined, fallback: string): string {
  if (!value) return resolve(fallback);
  // Preserve POSIX paths supplied by WSL-oriented configurations on Windows;
  // Node can still consume them, and this keeps environment values portable.
  if (process.platform === "win32" && /^\/[^/]/.test(value)) return value;
  return resolve(value);
}
