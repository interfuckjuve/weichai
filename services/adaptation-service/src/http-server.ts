import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { parseModuleHierarchyDecision, parseModuleHierarchyDecisionRequest } from '@forexplore/code-intelligence-service/module-hierarchy-planner';
import { WorkspaceTranslationError, type WorkspaceTranslationRuntime } from "./workspace-translation-runtime";
import {
  moduleMigrationSchemaVersion,
  type AdaptationRequest,
  type Language,
  type ModuleHierarchyPlanner,
  type RepositoryArchitectureRequest,
  type RepositoryStaticAnalysis,
} from "@forexplore/contracts";
import type {
  CodeAdaptationPort,
  RepositoryArchitecturePort,
} from "@forexplore/workflow-core";
import type {
  RevisionScopedArchitecturePort,
  ToolCallingArchitectRequest,
} from "./tool-calling-architect-runtime";

export interface StaticAnalysisSnapshotStore {
  /** Returns only a server-persisted snapshot; HTTP never supplies source or paths. */
  getSnapshot(snapshotId: string, signal?: AbortSignal): Promise<RepositoryStaticAnalysis | null>;
}

export interface HttpServerOptions {
  adapter: CodeAdaptationPort;
  /** Optional read-only module-planning endpoint. It has no write-back path. */
  architecturePort?: RepositoryArchitecturePort;
  /** Server-owned static-analysis snapshots addressed by their immutable ID. */
  staticAnalysisSnapshots?: StaticAnalysisSnapshotStore;
  /** Revision-native planning path backed only by SemanticQueryPort tools. */
  semanticArchitecturePort?: RevisionScopedArchitecturePort;
  /** Optional evidence-only node decisions; the injected planner owns model configuration. */
  moduleHierarchyPlanner?: ModuleHierarchyPlanner;
  /** Explicitly configured in-place translation, authenticated separately from read-only routes. */
  workspaceTranslation?: { runtime: WorkspaceTranslationRuntime; bearerToken: string };
  /** Browser CORS is opt-in; the VS Code extension host uses local HTTP directly. */
  corsOrigin?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const maxBodyBytes = 2 * 1024 * 1024;
const languages = new Set<Language>([
  "TypeScript",
  "Python",
  "Java",
  "C#",
  "Rust",
  "Go",
]);

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  corsOrigin: string | undefined,
): void {
  const headers: Record<string, string> = {
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-type": "application/json; charset=utf-8",
  };
  if (corsOrigin) headers["access-control-allow-origin"] = corsOrigin;
  response.writeHead(status, headers);
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HttpError(413, "Request body exceeds 2 MiB.");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBodyBytes) {
      throw new HttpError(413, "Request body exceeds 2 MiB.");
    }
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAdaptationRequest(value: unknown): value is AdaptationRequest {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<AdaptationRequest>;
  const target = body.target as Partial<AdaptationRequest["target"]> | undefined;
  const candidate = body.candidate as
    | Partial<AdaptationRequest["candidate"]>
    | undefined;

  return (
    typeof body.requirement === "string" &&
    typeof body.decisionNotes === "string" &&
    ["translate", "bridge", "wrap", "reuse"].includes(String(body.strategy)) &&
    typeof target === "object" &&
    target !== null &&
    typeof target.id === "string" &&
    typeof target.name === "string" &&
    ["class", "function"].includes(String(target.kind)) &&
    typeof target.path === "string" &&
    typeof target.language === "string" &&
    languages.has(target.language as Language) &&
    typeof target.signature === "string" &&
    (target.documentation === undefined || typeof target.documentation === "string") &&
    (target.line === undefined || Number.isInteger(target.line)) &&
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.repository === "string" &&
    typeof candidate.license === "string" &&
    typeof candidate.language === "string" &&
    languages.has(candidate.language as Language) &&
    ["class", "function"].includes(String(candidate.kind)) &&
    typeof candidate.path === "string" &&
    typeof candidate.signature === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.preview === "string" &&
    isStringArray(candidate.dependencies) &&
    isStringArray(candidate.compatibility) &&
    isStringArray(candidate.risks) &&
    typeof candidate.score === "object" &&
    candidate.score !== null
  );
}

export interface ModulePlanHttpRequest {
  snapshotId: string;
  objective: string;
  immutableConstraints?: string[];
}

export interface SemanticModulePlanHttpRequest {
  repositoryId: string;
  analysisRevision: string;
  projectId?: string;
  objective: string;
  immutableConstraints?: string[];
}

const maxPlanningObjectiveChars = 16_000;
const maxPlanningConstraints = 64;
const maxPlanningConstraintChars = 2_000;

/**
 * Deliberately accept a small, exact shape. In particular, analysis/source/
 * path/files fields are rejected so a browser cannot supply a repository for
 * the model to inspect; it can only select an already persisted snapshot.
 */
function isModulePlanHttpRequest(value: unknown): value is ModulePlanHttpRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const allowedKeys = new Set(["snapshotId", "objective", "immutableConstraints"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return false;
  if (
    typeof body.snapshotId !== "string" ||
    !body.snapshotId.trim() ||
    typeof body.objective !== "string" ||
    !body.objective.trim() ||
    body.objective.length > maxPlanningObjectiveChars
  ) {
    return false;
  }
  if (body.immutableConstraints === undefined) return true;
  return (
    isStringArray(body.immutableConstraints) &&
    body.immutableConstraints.length <= maxPlanningConstraints &&
    body.immutableConstraints.every(
      (constraint) => constraint.trim() && constraint.length <= maxPlanningConstraintChars,
    )
  );
}

/**
 * This route deliberately receives only a stable index scope and planning
 * intent.  It cannot upload a legacy snapshot, analysis hash, source text, or
 * local path; the ToolCallingArchitectRuntime reads those facts from the
 * revision-scoped SemanticQueryPort itself.
 */
function isSemanticModulePlanHttpRequest(value: unknown): value is SemanticModulePlanHttpRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const allowedKeys = new Set(["repositoryId", "analysisRevision", "projectId", "objective", "immutableConstraints"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return false;
  if (
    typeof body.repositoryId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(body.repositoryId) ||
    typeof body.analysisRevision !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(body.analysisRevision) ||
    (body.projectId !== undefined && (
      typeof body.projectId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(body.projectId)
    )) ||
    typeof body.objective !== "string" ||
    !body.objective.trim() ||
    body.objective.length > maxPlanningObjectiveChars
  ) {
    return false;
  }
  if (body.immutableConstraints === undefined) return true;
  return (
    isStringArray(body.immutableConstraints) &&
    body.immutableConstraints.length <= maxPlanningConstraints &&
    body.immutableConstraints.every(
      (constraint) => constraint.trim() && constraint.length <= maxPlanningConstraintChars,
    )
  );
}

function requireJson(request: IncomingMessage): void {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
}

function requestSignal(request: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  return controller.signal;
}

export function createHttpServer(options: HttpServerOptions): Server {
  if (options.workspaceTranslation && options.workspaceTranslation.bearerToken.trim().length < 32) {
    throw new Error("Workspace translation requires a bearer token of at least 32 characters.");
  }
  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      json(response, 204, null, options.corsOrigin);
      return;
    }

    try {
      if (request.url?.startsWith("/v1/workspace-translations")) {
        const translation = options.workspaceTranslation;
        if (!translation) throw new HttpError(404, "Workspace translation is not configured.");
        const supplied = Buffer.from(request.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${translation.bearerToken}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          throw new HttpError(401, "Workspace translation requires a valid bearer token.");
        }
        if (request.headers.origin && request.headers.origin !== options.corsOrigin) {
          throw new HttpError(403, "Browser origin is not configured for workspace translation.");
        }
        const route = /^\/v1\/workspace-translations(?:\/([a-f0-9-]{36})(?:\/(cancel|resume|rollback))?)?$/.exec(request.url);
        if (!route) throw new HttpError(404, "Not found.");
        const [, id, action] = route;
        if (request.method === "POST" && !id) {
          requireJson(request);
          const run = translation.runtime.start(await readBody(request));
          json(response, 202, run, options.corsOrigin);
          return;
        }
        if (request.method === "GET" && id && !action) {
          json(response, 200, translation.runtime.get(id), options.corsOrigin);
          return;
        }
        if (request.method === "POST" && id && action) {
          const run = action === "cancel" ? await translation.runtime.cancel(id)
            : action === "resume" ? translation.runtime.resume(id) : translation.runtime.rollback(id);
          json(response, action === "resume" ? 202 : 200, run, options.corsOrigin);
          return;
        }
        throw new HttpError(405, "Method not allowed.");
      }
      if (request.method === "GET" && request.url === "/health") {
        json(
          response,
          200,
          { status: "ok", provider: "deepseek", capabilities: {
            semanticModulePlanning: Boolean(options.semanticArchitecturePort),
            moduleHierarchyPlanning: Boolean(options.moduleHierarchyPlanner),
          } },
          options.corsOrigin,
        );
        return;
      }

      if (request.method === "POST" && request.url === "/v1/adapt") {
        requireJson(request);
        const body = await readBody(request);
        if (!isAdaptationRequest(body)) {
          json(
            response,
            400,
            { error: "Invalid AdaptationRequest payload." },
            options.corsOrigin,
          );
          return;
        }
        const result = await options.adapter.adapt(body, requestSignal(request));
        json(response, 200, result, options.corsOrigin);
        return;
      }

      if (request.method === "POST" && request.url === "/v1/module-plan") {
        if (!options.architecturePort || !options.staticAnalysisSnapshots) {
          json(
            response,
            404,
            { error: "Module planning is not configured." },
            options.corsOrigin,
          );
          return;
        }
        requireJson(request);
        const body = await readBody(request);
        if (!isModulePlanHttpRequest(body)) {
          json(
            response,
            400,
            { error: "Invalid module planning payload. Submit only snapshotId, objective, and immutableConstraints." },
            options.corsOrigin,
          );
          return;
        }

        const signal = requestSignal(request);
        const analysis = await options.staticAnalysisSnapshots.getSnapshot(body.snapshotId, signal);
        if (!analysis) {
          json(response, 404, { error: "Static analysis snapshot was not found." }, options.corsOrigin);
          return;
        }
        if (analysis.snapshotId !== body.snapshotId) {
          throw new Error("Static analysis snapshot store returned a mismatched snapshot ID.");
        }

        const architectureRequest: RepositoryArchitectureRequest = {
          schemaVersion: moduleMigrationSchemaVersion,
          analysis,
          objective: body.objective,
          immutableConstraints: body.immutableConstraints,
        };
        const result = await options.architecturePort.proposeModulePlan(architectureRequest, signal);
        json(response, 200, result, options.corsOrigin);
        return;
      }

      if (request.method === 'POST' && request.url === '/module-hierarchy/decision') {
        if (!options.moduleHierarchyPlanner) throw new HttpError(503, 'Module hierarchy model is not configured.');
        requireJson(request);
        const raw = await readBody(request);
        let body;
        try { body = parseModuleHierarchyDecisionRequest(raw); }
        catch { throw new HttpError(400, 'Invalid bounded module hierarchy evidence snapshot.'); }
        const controller = new AbortController();
        const disconnect = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', disconnect);
        const signal = AbortSignal.any([requestSignal(request), controller.signal, AbortSignal.timeout(45_000)]);
        try {
          const decision = parseModuleHierarchyDecision(await options.moduleHierarchyPlanner.decide(body, signal), body);
          signal.throwIfAborted();
          json(response, 200, decision, options.corsOrigin);
        } catch {
          throw new HttpError(signal.aborted ? 504 : 502, signal.aborted ? 'Module hierarchy decision timed out or was cancelled.' : 'Module hierarchy model could not produce a valid decision.');
        } finally { response.removeListener('close', disconnect); }
        return;
      }

      if (request.method === "POST" && request.url === "/v1/semantic-module-plan") {
        if (!options.semanticArchitecturePort) {
          json(
            response,
            404,
            { error: "Revision-scoped semantic module planning is not configured." },
            options.corsOrigin,
          );
          return;
        }
        requireJson(request);
        const body = await readBody(request);
        if (!isSemanticModulePlanHttpRequest(body)) {
          json(
            response,
            400,
            { error: "Invalid semantic module planning payload. Submit only repositoryId, analysisRevision, projectId, objective, and immutableConstraints." },
            options.corsOrigin,
          );
          return;
        }
        const semanticRequest: ToolCallingArchitectRequest = {
          schemaVersion: moduleMigrationSchemaVersion,
          repositoryId: body.repositoryId,
          analysisRevision: body.analysisRevision,
          ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          objective: body.objective,
          ...(body.immutableConstraints === undefined ? {} : { immutableConstraints: body.immutableConstraints }),
        };
        const result = await options.semanticArchitecturePort.proposeModulePlanWithEvidence(
          semanticRequest,
          requestSignal(request),
        );
        json(response, 200, result, options.corsOrigin);
        return;
      }

      if (request.method === "POST" && request.url === "/v1/backfill") {
        // A bare HTTP client is not an approval authority. Until this service
        // has a server-owned run manifest and authorization layer, write-back
        // stays in the trusted VS Code extension host.
        json(
          response,
          410,
          { error: "HTTP write-back is disabled. Apply an approved migration from the VS Code host." },
          options.corsOrigin,
        );
        return;
      }

      json(response, 404, { error: "Not found." }, options.corsOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown adaptation error.";
      const status = error instanceof HttpError || error instanceof WorkspaceTranslationError ? error.status : 502;
      if (!(error instanceof HttpError) && !(error instanceof WorkspaceTranslationError)) console.error(error);
      json(response, status, { error: message }, options.corsOrigin);
    }
  });
}
