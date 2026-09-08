import { formatContextMarkdown, isStableRepositoryIdentifier, type ContextPacket, type TaskRetrievalRequest } from "@forexplore/contracts";
import type { SemanticQueryPort, TaskRetrievalPort } from "@forexplore/workflow-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

const MAX_REPOSITORY_ID_CHARS = 256;
const MAX_REVISION_CHARS = 256;
const MAX_RELATIVE_PATH_CHARS = 4_096;
const MAX_QUERY_CHARS = 8_000;
const MAX_SYMBOL_KEY_CHARS = 2_048;
const MAX_EVIDENCE_ID_CHARS = 4_096;

const evidenceProviders = new Set([
  "tree-sitter",
  "lsp",
  "java-csharp-specialized",
]);

const evidenceLevels = new Set([
  "structural",
  "syntactic",
  "semantic",
  "ambiguous",
  "unresolved",
]);

const relativePathFields = [
  "relativePath",
  "sourceRelativePath",
  "targetRelativePath",
] as const;

const relativePathArrayFields = [
  "manifestPaths",
  "sourceRoots",
  "testRoots",
] as const;

const forbiddenOutputFields = new Set([
  "localPath",
  "local_path",
  "absolutePath",
  "absolute_path",
]);

export interface SemanticIndexMcpServerOptions {
  /**
   * The only data boundary used by this facade.  The MCP process must not own
   * a filesystem root, LSP session, index store, or SeekDB connection.
   */
  queryPort: SemanticQueryPort;
  taskRetrieval?: TaskRetrievalPort;
}

const repositoryIdSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_REPOSITORY_ID_CHARS)
  .refine(isStableRepositoryIdentifier, "repositoryId must be a stable identifier, not a path.");

const analysisRevisionSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_REVISION_CHARS)
  .refine(isStableRepositoryIdentifier, "analysisRevision must be a stable identifier, not a path.");

const relativePathSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_RELATIVE_PATH_CHARS)
  .refine(isSafeRelativePath, "relativePath must be a POSIX-style path inside the selected repository.");

const symbolKeySchema = z.string()
  .trim()
  .min(1)
  .max(MAX_SYMBOL_KEY_CHARS)
  .refine(hasNoControlCharacters, "symbolKey must not contain control characters.");

const sourceRangeSchema = z.object({
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
}).strict().refine(
  (value) => value.endLine > value.startLine || (
    value.endLine === value.startLine && value.endColumn > value.startColumn
  ),
  "sourceRange must be end-exclusive and non-empty.",
);

const scopeSchema = z.object({
  repositoryId: repositoryIdSchema,
  analysisRevision: analysisRevisionSchema,
}).strict();

const listRepositoriesSchema = z.object({
  roles: z.array(z.enum(["history", "target"])).max(2).optional(),
}).strict();

const repositoryOverviewSchema = scopeSchema;

const listProjectsSchema = scopeSchema;

const fileStructureSchema = scopeSchema.extend({
  relativePath: relativePathSchema,
}).strict();

const searchSymbolsSchema = scopeSchema.extend({
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  limit: z.number().int().min(1).max(200).optional(),
  languageIds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  kinds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  projectIds: z.array(z.string().trim().min(1).max(256)).max(250).optional(),
  relativePathPrefix: relativePathSchema.optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict();

const getSymbolSchema = scopeSchema.extend({
  symbolKey: symbolKeySchema,
}).strict();

const findDefinitionSchema = scopeSchema.extend({
  relativePath: relativePathSchema,
  sourceRange: sourceRangeSchema,
}).strict();

const findReferencesSchema = scopeSchema.extend({
  symbolKey: symbolKeySchema,
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict();

const dependenciesSchema = scopeSchema.extend({
  symbolKey: symbolKeySchema.optional(),
  relativePath: relativePathSchema.optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
  direction: z.enum(["incoming", "outgoing", "both"]).optional(),
  kinds: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  resolution: z.array(z.enum(["resolved", "ambiguous", "unresolved"])).max(3).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict().refine(
  (value) => value.symbolKey !== undefined || value.relativePath !== undefined || value.projectId !== undefined,
  "get_dependencies requires symbolKey, relativePath, or projectId.",
);

const diagnosticsSchema = scopeSchema.extend({
  relativePath: relativePathSchema.optional(),
  severities: z.array(z.enum(["info", "warning", "error"])).max(3).optional(),
  providers: z.array(z.enum(["tree-sitter", "lsp", "java-csharp-specialized"])).max(3).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict();

const sourceExcerptSchema = scopeSchema.extend({
  relativePath: relativePathSchema,
  sourceRange: sourceRangeSchema.optional(),
  maxChars: z.number().int().min(1).max(32_000).optional(),
}).strict();

const taskSearchSchema = z.object({
  requestId: repositoryIdSchema,
  requirement: z.string().trim().min(1).max(MAX_QUERY_CHARS),
  granularity: z.enum(["auto", "function", "class", "module", "subsystem"]).optional(),
  scopes: z.array(scopeSchema.extend({ projectId: repositoryIdSchema.optional(), role: z.enum(["target", "reference"]).optional() }).strict()).min(1).max(8),
  budget: z.object({
    maxTokens: z.number().int().min(256).max(32000),
    maxLatencyMs: z.number().int().min(100).max(60000).optional(),
    maxFiles: z.number().int().min(1).max(40).optional(),
    maxSourceLines: z.number().int().min(1).max(4000).optional(),
  }).strict(),
  knownEvidence: z.array(z.object({ evidenceId: z.string().min(1).max(512), contentHash: z.string().min(1).max(512) }).strict()).max(200).optional(),
}).strict();

/**
 * Creates a strictly read-only MCP facade over SemanticQueryPort.  All tool
 * inputs are repository/revision scoped and paths are relative-only; the
 * underlying port remains responsible for authorization and evidence lookup.
 */
export function createSemanticIndexMcpServer(
  options: SemanticIndexMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: "forexplore-semantic-index",
    version: "0.1.0",
  });

  if (options.taskRetrieval) server.registerTool("search_task_context", {
    title: "Search Task Context",
    description: "Read task-related source context from the local host at an explicit or automatic granularity, with a token budget and fixed repository revisions.",
    inputSchema: taskSearchSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => {
    try {
      const packet = await options.taskRetrieval!.search(input, extra.signal);
      assertTaskPacketBoundary(packet, input);
      return { content: [{ type: "text" as const, text: packet.markdown }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: toolErrorMessage(error) }], isError: true };
    }
  });

  server.registerTool("list_repositories", {
    title: "List Repositories",
    description: "List registered repositories and their visible active revisions.",
    inputSchema: listRepositoriesSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runTool(async () => {
    const result = await options.queryPort.listRepositories(
      input as Parameters<SemanticQueryPort["listRepositories"]>[0],
      extra.signal,
    );
    assertUnscopedResultBoundary(result);
    return result;
  }));

  server.registerTool("get_repository_overview", {
    title: "Get Repository Overview",
    description: "Read one registered repository's indexed overview for one immutable analysis revision.",
    inputSchema: repositoryOverviewSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.getRepositoryOverview(
    input as Parameters<SemanticQueryPort["getRepositoryOverview"]>[0],
    extra.signal,
  )));

  server.registerTool("list_projects", {
    title: "List Projects",
    description: "List discovered projects for one registered repository revision.",
    inputSchema: listProjectsSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.listProjects(
    input as Parameters<SemanticQueryPort["listProjects"]>[0],
    extra.signal,
  )));

  server.registerTool("get_file_structure", {
    title: "Get File Structure",
    description: "Read structural declarations, containers, imports, exports, and ranges for indexed files only.",
    inputSchema: fileStructureSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.getFileStructure(
    input as Parameters<SemanticQueryPort["getFileStructure"]>[0],
    extra.signal,
  )));

  server.registerTool("search_symbols", {
    title: "Search Symbols",
    description: "Search symbols within one repository revision using the versioned semantic-index projection.",
    inputSchema: searchSymbolsSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.searchSymbols(
    input as Parameters<SemanticQueryPort["searchSymbols"]>[0],
    extra.signal,
  )));

  server.registerTool("get_symbol", {
    title: "Get Symbol",
    description: "Read one indexed symbol and its version-bound evidence.",
    inputSchema: getSymbolSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.getSymbol(
    input as Parameters<SemanticQueryPort["getSymbol"]>[0],
    extra.signal,
  )));

  server.registerTool("find_definition", {
    title: "Find Definition",
    description: "Find a definition only when the configured semantic provider has evidence for it.",
    inputSchema: findDefinitionSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.findDefinition(
    input as Parameters<SemanticQueryPort["findDefinition"]>[0],
    extra.signal,
  )));

  server.registerTool("find_references", {
    title: "Find References",
    description: "Find references only when the configured semantic provider has evidence for them.",
    inputSchema: findReferencesSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.findReferences(
    input as Parameters<SemanticQueryPort["findReferences"]>[0],
    extra.signal,
  )));

  server.registerTool("get_dependencies", {
    title: "Get Dependencies",
    description: "Read dependency edges and preserve resolved, ambiguous, or unresolved evidence states.",
    inputSchema: dependenciesSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.getDependencies(
    input as Parameters<SemanticQueryPort["getDependencies"]>[0],
    extra.signal,
  )));

  server.registerTool("get_diagnostics", {
    title: "Get Diagnostics",
    description: "Read parser, resolver, compiler, or LSP diagnostics for one immutable analysis revision.",
    inputSchema: diagnosticsSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.getDiagnostics(
    input as Parameters<SemanticQueryPort["getDiagnostics"]>[0],
    extra.signal,
  )));

  server.registerTool("read_source_excerpt", {
    title: "Read Source Excerpt",
    description: "Read a bounded indexed source excerpt by repository-relative path and source range.",
    inputSchema: sourceExcerptSchema,
    annotations: readOnlyAnnotations,
  }, async (input, extra) => runScopedTool(input, () => options.queryPort.readSourceExcerpt(
    input as Parameters<SemanticQueryPort["readSourceExcerpt"]>[0],
    extra.signal,
  )));

  return server;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
} as const;

async function runScopedTool<T extends { repositoryId: string; analysisRevision: string }>(
  input: T,
  work: () => Promise<unknown> | unknown,
) {
  return runTool(async () => {
    const result = await work();
    assertResultScope(result, input);
    return result;
  });
}

async function runTool<T>(work: () => Promise<T> | T) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await work(), null, 2) }],
    };
  } catch (error) {
    return {
      content: [{
        type: "text" as const,
        text: toolErrorMessage(error),
      }],
      isError: true,
    };
  }
}

function assertResultScope(
  value: unknown,
  expected: { repositoryId: string; analysisRevision: string },
): void {
  if (!isRecord(value)) throw new SemanticResultBoundaryError("SemanticQueryPort returned an invalid result.");
  assertNestedResultBoundary(value, expected);
}

function assertUnscopedResultBoundary(value: unknown): void {
  if (!isRecord(value)) throw new SemanticResultBoundaryError("SemanticQueryPort returned an invalid result.");
  assertNestedUnscopedResultBoundary(value);
}

function assertTaskPacketBoundary(value: ContextPacket, request: TaskRetrievalRequest): void {
  assertUnscopedResultBoundary(value);
  if (value.requestId !== request.requestId || !["complete", "partial", "unavailable"].includes(value.status) ||
    !Array.isArray(value.snapshots) || !Array.isArray(value.results) || !Array.isArray(value.evidence) ||
    !Array.isArray(value.relations) || !Array.isArray(value.gaps) || typeof value.markdown !== "string" ||
    !value.usage || !Number.isInteger(value.usage.tokens) || value.usage.tokens < 0 || value.usage.tokens > request.budget.maxTokens) {
    throw new SemanticResultBoundaryError("Task retrieval returned an invalid context packet.");
  }
  for (const item of [...value.snapshots, ...value.results, ...value.evidence, ...value.relations]) {
    if (!request.scopes.some((scope) => scope.repositoryId === item.repositoryId && scope.analysisRevision === item.analysisRevision)) {
      throw new SemanticResultBoundaryError("Task retrieval returned evidence from a different repository revision.");
    }
    assertPathFields(item as unknown as Record<string, unknown>);
  }
  for (const item of value.evidence) {
    if (!sourceRangeSchema.safeParse(item.sourceRange).success || !evidenceProviders.has(item.provider) ||
      !evidenceLevels.has(item.evidenceLevel) || typeof item.evidenceId !== "string" || !item.evidenceId ||
      typeof item.content !== "string" || typeof item.contentHash !== "string" || !item.contentHash ||
      typeof item.fileHash !== "string" || !item.fileHash) {
      throw new SemanticResultBoundaryError("Task retrieval returned invalid source evidence.");
    }
  }
  if (formatContextMarkdown(value) !== value.markdown) {
    throw new SemanticResultBoundaryError("Task retrieval Markdown does not match its evidence.");
  }
}

function assertNestedUnscopedResultBoundary(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNestedUnscopedResultBoundary(item);
    return;
  }
  if (!isRecord(value)) return;
  assertNoForbiddenOutputFields(value);
  for (const nested of Object.values(value)) assertNestedUnscopedResultBoundary(nested);
}

function assertNestedResultBoundary(
  value: unknown,
  expected: { repositoryId: string; analysisRevision: string },
): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNestedResultBoundary(item, expected);
    return;
  }
  if (!isRecord(value)) return;

  assertNoForbiddenOutputFields(value);
  assertEmbeddedScope(value, expected);
  assertPathFields(value);

  if (Object.hasOwn(value, "evidenceId")) {
    assertEvidenceEnvelope(value, expected);
  }
  for (const nested of Object.values(value)) assertNestedResultBoundary(nested, expected);
}

function assertEmbeddedScope(
  value: Record<string, unknown>,
  expected: { repositoryId: string; analysisRevision: string },
): void {
  if (Object.hasOwn(value, "repositoryId") && value.repositoryId !== expected.repositoryId) {
    throw new SemanticResultBoundaryError("SemanticQueryPort returned data for a different repository revision.");
  }
  if (Object.hasOwn(value, "analysisRevision") && value.analysisRevision !== expected.analysisRevision) {
    throw new SemanticResultBoundaryError("SemanticQueryPort returned data for a different repository revision.");
  }
}

function assertEvidenceEnvelope(
  value: Record<string, unknown>,
  expected: { repositoryId: string; analysisRevision: string },
): void {
  if (
    typeof value.evidenceId !== "string" ||
    !value.evidenceId ||
    value.evidenceId.length > MAX_EVIDENCE_ID_CHARS ||
    hasControlCharacters(value.evidenceId)
  ) {
    throw new SemanticResultBoundaryError("SemanticQueryPort returned evidence without a valid evidenceId.");
  }
  if (
    value.repositoryId !== expected.repositoryId ||
    value.analysisRevision !== expected.analysisRevision
  ) {
    throw new SemanticResultBoundaryError("SemanticQueryPort returned evidence for a different repository revision.");
  }
  if (typeof value.provider !== "string" || !evidenceProviders.has(value.provider)) {
    throw new SemanticResultBoundaryError("SemanticQueryPort returned evidence with an invalid provider.");
  }
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new SemanticResultBoundaryError("SemanticQueryPort returned evidence with an invalid confidence.");
  }
  if (typeof value.evidenceLevel !== "string" || !evidenceLevels.has(value.evidenceLevel)) {
    throw new SemanticResultBoundaryError("SemanticQueryPort returned evidence with an invalid evidenceLevel.");
  }
  assertNullableRelativePath(value.relativePath, "relativePath");
  assertNullableSourceRange(value.sourceRange, "sourceRange");
}

function assertNoForbiddenOutputFields(value: Record<string, unknown>): void {
  for (const field of forbiddenOutputFields) {
    if (Object.hasOwn(value, field)) {
      throw new SemanticResultBoundaryError("SemanticQueryPort returned a host-local path.");
    }
  }
}

function assertPathFields(value: Record<string, unknown>): void {
  for (const field of relativePathFields) {
    if (Object.hasOwn(value, field)) {
      const allowRoot = field === "relativePath" && isProjectRecord(value);
      assertNullableRelativePath(value[field], field, allowRoot);
    }
  }
  for (const field of relativePathArrayFields) {
    if (Object.hasOwn(value, field)) assertRelativePathArray(value[field], field, isProjectRecord(value));
  }
  if (Object.hasOwn(value, "sourceRange")) assertNullableSourceRange(value.sourceRange, "sourceRange");
}

function assertNullableRelativePath(value: unknown, field: string, allowRoot = false): void {
  if (value !== null && (typeof value !== "string" || (!allowRoot || value !== "") && !isSafeRelativePath(value))) {
    throw new SemanticResultBoundaryError(`SemanticQueryPort returned an invalid ${field}.`);
  }
}

function assertRelativePathArray(value: unknown, field: string, allowRoot = false): void {
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" || ((!allowRoot || entry !== "") && !isSafeRelativePath(entry)),
  )) {
    throw new SemanticResultBoundaryError(`SemanticQueryPort returned invalid ${field}.`);
  }
}

function isProjectRecord(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "projectId") && Array.isArray(value.manifestPaths);
}

function assertNullableSourceRange(value: unknown, field: string): void {
  if (value !== null && !isSourceRange(value)) {
    throw new SemanticResultBoundaryError(`SemanticQueryPort returned an invalid ${field}.`);
  }
}

function isSourceRange(value: unknown): boolean {
  return sourceRangeSchema.safeParse(value).success;
}

function toolErrorMessage(error: unknown): string {
  if (error instanceof SemanticResultBoundaryError) return error.message;
  return "Semantic index query failed.";
}

class SemanticResultBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticResultBoundaryError";
  }
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\u0000")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").some((segment) => segment === ".." || segment === "");
}

function hasNoControlCharacters(value: string): boolean {
  return !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001F\u007F]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
