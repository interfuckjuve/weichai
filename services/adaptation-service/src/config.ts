import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type { WorkspaceCompileCommand } from "@forexplore/contracts";
import { validateWorkspaceCompileCommand } from "./workspace-compiler";

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
  workspaceTranslation?: {
    bearerToken: string;
    compileCommand: WorkspaceCompileCommand;
    verification?: { command: WorkspaceCompileCommand; protectedFiles: string[] };
    maxModelTurns: number;
    timeoutMs: number;
  };
  /**
   * Optional host-owned read-only semantic-query endpoint for revision-scoped
   * plans. The adaptation process never receives a database or index-runtime
   * configuration.
   */
  semanticQueryPort?: {
    endpoint: string;
    bearerToken?: string;
  };
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

  const semanticPlanningEnabled = env.ADAPTATION_SEMANTIC_INDEX_ENABLED?.trim().toLowerCase() === "true";
  const semanticQueryPort = semanticPlanningEnabled
    ? loadSemanticQueryPortConfig(env)
    : undefined;
  const workspaceTranslation = env.ADAPTATION_WORKSPACE_TRANSLATION_ENABLED?.trim().toLowerCase() === "true"
    ? loadWorkspaceTranslationConfig(env) : undefined;
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
    ...(semanticQueryPort ? { semanticQueryPort } : {}),
    ...(workspaceTranslation ? { workspaceTranslation } : {}),
  };
}

function loadWorkspaceTranslationConfig(env: NodeJS.ProcessEnv): NonNullable<AdaptationServiceConfig["workspaceTranslation"]> {
  const bearerToken = env.ADAPTATION_WORKSPACE_TRANSLATION_TOKEN?.trim() ?? "";
  if (bearerToken.length < 32) throw new Error("ADAPTATION_WORKSPACE_TRANSLATION_TOKEN must contain at least 32 characters.");
  let compileCommand: unknown;
  try { compileCommand = JSON.parse(env.ADAPTATION_WORKSPACE_COMPILE_COMMAND ?? ""); }
  catch { throw new Error("ADAPTATION_WORKSPACE_COMPILE_COMMAND must be a JSON command object."); }
  validateWorkspaceCompileCommand(compileCommand);
  let verification: NonNullable<AdaptationServiceConfig["workspaceTranslation"]>["verification"];
  if (env.ADAPTATION_WORKSPACE_VERIFICATION) {
    const value = JSON.parse(env.ADAPTATION_WORKSPACE_VERIFICATION);
    validateWorkspaceCompileCommand(value.command);
    if (!Array.isArray(value.protectedFiles) || !value.protectedFiles.length || value.protectedFiles.some((path: unknown) => typeof path !== "string")) throw new Error("Verification protectedFiles must be a nonempty path array.");
    verification = value;
  }
  return {
    bearerToken, compileCommand, ...(verification ? { verification } : {}),
    maxModelTurns: positiveInteger(env.ADAPTATION_WORKSPACE_MAX_TURNS, 80, "ADAPTATION_WORKSPACE_MAX_TURNS"),
    timeoutMs: positiveInteger(env.ADAPTATION_WORKSPACE_TIMEOUT_MS, 1_800_000, "ADAPTATION_WORKSPACE_TIMEOUT_MS"),
  };
}

function loadSemanticQueryPortConfig(
  env: NodeJS.ProcessEnv,
): NonNullable<AdaptationServiceConfig["semanticQueryPort"]> {
  const endpoint = env.SEMANTIC_QUERY_PORT_URL?.trim();
  if (!endpoint) {
    throw new Error(
      "SEMANTIC_QUERY_PORT_URL is required when ADAPTATION_SEMANTIC_INDEX_ENABLED=true.",
    );
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error("SEMANTIC_QUERY_PORT_URL must be an http(s) URL.");
  }
  // Constructing a URL rejects malformed hosts and credentials before the
  // executable can start. The transport itself applies the same guard so it
  // is also safe when constructed programmatically.
  try {
    new URL(endpoint);
  } catch {
    throw new Error("SEMANTIC_QUERY_PORT_URL must be an http(s) URL.");
  }

  return {
    endpoint,
    ...(env.SEMANTIC_QUERY_PORT_TOKEN?.trim()
      ? { bearerToken: env.SEMANTIC_QUERY_PORT_TOKEN.trim() }
      : {}),
  };
}

function resolveConfiguredPath(value: string | undefined, fallback: string): string {
  if (!value) return resolve(fallback);
  // Preserve POSIX paths supplied by WSL-oriented configurations on Windows;
  // Node can still consume them, and this keeps environment values portable.
  if (process.platform === "win32" && /^\/[^/]/.test(value)) return value;
  return resolve(value);
}
