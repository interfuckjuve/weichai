import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  moduleMigrationSchemaVersion,
  type AdaptationRequest,
  type Language,
  type ModuleDiscoveryConstraint,
  type RepositoryArchitectureRequest,
  type RepositoryStaticAnalysis,
} from "@forexplore/contracts";
import { verifyRepositoryStaticAnalysis } from "@forexplore/code-indexer";
import type {
  CodeAdaptationPort,
  RepositoryArchitecturePort,
} from "@forexplore/workflow-core";
import { validateRepositoryModuleWikiProposal } from "@forexplore/workflow-core";
import {
  repositoryStaticAnalysisToUnifiedIr,
  validateModuleDiscoveryProposal,
  validateModuleDiscoveryRequest,
  type ModuleDiscoveryPort,
  type RepositoryStaticAnalysisIrBridge,
} from "./module-discovery-agent";
import {
  validateModuleSummaryRequest,
  type ModuleSummaryPort,
  type ModuleSummaryRequest,
} from "./module-summary-agent";

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
  /** Optional read-only module-discovery endpoint. It cannot approve or migrate modules. */
  moduleDiscoveryPort?: ModuleDiscoveryPort;
  /** Optional read-only Summary Agent endpoint. It cannot review, publish, or index. */
  moduleSummaryPort?: ModuleSummaryPort;
  /** Compatibility bridge from a verified legacy snapshot to adapter-neutral IR. */
  repositoryIrBridge?: RepositoryStaticAnalysisIrBridge;
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
// A Summary request carries a content-addressed RepositoryModuleBundle plus
// one bounded EvidenceBundle. Keep it bounded, but do not apply the much
// smaller interactive adaptation limit to a repository inventory.
const maxModuleSummaryBodyBytes = 32 * 1024 * 1024;
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
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-type": "application/json; charset=utf-8",
  };
  if (corsOrigin) headers["access-control-allow-origin"] = corsOrigin;
  response.writeHead(status, headers);
  response.end(status === 204 ? undefined : JSON.stringify(body));
}

async function readBody(
  request: IncomingMessage,
  maximumBytes = maxBodyBytes,
): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new HttpError(413, `Request body exceeds ${Math.floor(maximumBytes / 1024 / 1024)} MiB.`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) {
      throw new HttpError(413, `Request body exceeds ${Math.floor(maximumBytes / 1024 / 1024)} MiB.`);
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

interface ModulePlanHttpRequest {
  snapshotId: string;
  objective: string;
  immutableConstraints?: string[];
}

export type ModuleDiscoveryHttpConstraint = Pick<
  ModuleDiscoveryConstraint,
  "id" | "description" | "required"
>;

export interface ModuleDiscoveryHttpRequest {
  snapshotId: string;
  constraints?: ModuleDiscoveryHttpConstraint[];
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

/** HTTP cannot upload IR, source, paths, objectives, or evidence references. */
function isModuleDiscoveryHttpRequest(value: unknown): value is ModuleDiscoveryHttpRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const allowedKeys = new Set(["snapshotId", "constraints"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return false;
  if (
    typeof body.snapshotId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(body.snapshotId)
  ) {
    return false;
  }
  if (body.constraints === undefined) return true;
  if (!Array.isArray(body.constraints) || body.constraints.length > maxPlanningConstraints) {
    return false;
  }
  const constraintIds = new Set<string>();
  for (const value of body.constraints) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const constraint = value as Record<string, unknown>;
    const constraintKeys = new Set(["id", "description", "required"]);
    if (Object.keys(constraint).some((key) => !constraintKeys.has(key))) return false;
    if (
      typeof constraint.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(constraint.id) ||
      constraintIds.has(constraint.id) ||
      typeof constraint.description !== "string" ||
      !constraint.description.trim() ||
      constraint.description.length > maxPlanningConstraintChars ||
      typeof constraint.required !== "boolean"
    ) {
      return false;
    }
    constraintIds.add(constraint.id);
  }
  return true;
}

function isModuleSummaryHttpRequest(value: unknown): value is ModuleSummaryRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  const allowed = new Set([
    "repositoryModuleBundle",
    "evidenceBundle",
    "previousProposal",
    "reviseReview",
  ]);
  const hasPrevious = body.previousProposal !== undefined;
  const hasReview = body.reviseReview !== undefined;
  return (
    (keys.length === 2 || keys.length === 4) &&
    keys.every((key) => allowed.has(key)) &&
    hasPrevious === hasReview &&
    typeof body.repositoryModuleBundle === "object" &&
    body.repositoryModuleBundle !== null &&
    !Array.isArray(body.repositoryModuleBundle) &&
    typeof body.evidenceBundle === "object" &&
    body.evidenceBundle !== null &&
    !Array.isArray(body.evidenceBundle) &&
    (!hasPrevious || (
      typeof body.previousProposal === "object" &&
      body.previousProposal !== null &&
      !Array.isArray(body.previousProposal) &&
      typeof body.reviseReview === "object" &&
      body.reviseReview !== null &&
      !Array.isArray(body.reviseReview)
    ))
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
  return createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      json(response, 204, null, options.corsOrigin);
      return;
    }

    try {
      if (request.method === "GET" && request.url === "/health") {
        json(
          response,
          200,
          { status: "ok", provider: "deepseek" },
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

      if (request.method === "POST" && request.url === "/v1/module-discovery") {
        if (!options.moduleDiscoveryPort || !options.staticAnalysisSnapshots) {
          json(
            response,
            404,
            { error: "Module discovery is not configured." },
            options.corsOrigin,
          );
          return;
        }
        requireJson(request);
        const body = await readBody(request);
        if (!isModuleDiscoveryHttpRequest(body)) {
          json(
            response,
            400,
            { error: "Invalid module discovery payload. Submit only snapshotId and optional constraints." },
            options.corsOrigin,
          );
          return;
        }

        const signal = requestSignal(request);
        const stored = await options.staticAnalysisSnapshots.getSnapshot(body.snapshotId, signal);
        if (!stored) {
          json(response, 404, { error: "Static analysis snapshot was not found." }, options.corsOrigin);
          return;
        }
        if (stored.snapshotId !== body.snapshotId) {
          throw new Error("Static analysis snapshot store returned a mismatched snapshot ID.");
        }
        const verified = verifyRepositoryStaticAnalysis(stored);
        const bridge = options.repositoryIrBridge ?? repositoryStaticAnalysisToUnifiedIr;
        const ir = await bridge(verified, signal);
        signal.throwIfAborted();
        if (ir.repositoryContentHash !== verified.contentHash) {
          throw new Error("Repository IR bridge returned an IR for a different repository snapshot.");
        }
        validateModuleDiscoveryRequest({ ir, constraints: body.constraints });
        const result = await options.moduleDiscoveryPort.discoverModules(
          { ir, constraints: body.constraints },
          signal,
        );
        validateModuleDiscoveryProposal(result, { ir, constraints: body.constraints });
        json(response, 200, result, options.corsOrigin);
        return;
      }

      if (request.method === "POST" && request.url === "/v1/module-summary") {
        if (!options.moduleSummaryPort) {
          json(
            response,
            404,
            { error: "Module summary is not configured." },
            options.corsOrigin,
          );
          return;
        }
        requireJson(request);
        const body = await readBody(request, maxModuleSummaryBodyBytes);
        if (!isModuleSummaryHttpRequest(body)) {
          json(
            response,
            400,
            {
              error: "Invalid module summary payload. Submit repositoryModuleBundle and evidenceBundle, plus the paired previousProposal and reviseReview only for a revision.",
            },
            options.corsOrigin,
          );
          return;
        }
        try {
          validateModuleSummaryRequest(body);
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : "Invalid module summary evidence.",
          );
        }
        const signal = requestSignal(request);
        const result = await options.moduleSummaryPort.summarizeModule(body, signal);
        validateRepositoryModuleWikiProposal(
          result,
          body.evidenceBundle,
          body.previousProposal === undefined
            ? undefined
            : {
                previousProposal: body.previousProposal,
                reviseReview: body.reviseReview!,
              },
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
      const status = error instanceof HttpError ? error.status : 502;
      if (!(error instanceof HttpError)) console.error(error);
      json(response, status, { error: message }, options.corsOrigin);
    }
  });
}

export type { ModulePlanHttpRequest };
