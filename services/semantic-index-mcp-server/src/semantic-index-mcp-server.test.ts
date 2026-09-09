import type { SemanticQueryPort } from "@forexplore/workflow-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSemanticIndexMcpServer } from "./semantic-index-mcp-server";

const scope = {
  repositoryId: "history-quote",
  analysisRevision: "revision-20260904",
};

const range = {
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 20,
};

const transports: InMemoryTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

function evidence<T>(value: T, overrides: Record<string, unknown> = {}) {
  return {
    ...scope,
    evidenceId: "evidence:quote-service",
    provider: "tree-sitter",
    confidence: 0.9,
    evidenceLevel: "structural",
    relativePath: "src/QuoteService.ts",
    sourceRange: range,
    value,
    ...overrides,
  };
}

function createQueryPort(): SemanticQueryPort {
  const result = evidence({ name: "QuoteService" });
  return {
    listRepositories: vi.fn(async () => ({ repositories: [] })),
    getRepositoryOverview: vi.fn(async () => ({ overview: result })),
    listProjects: vi.fn(async () => ({ projects: [result] })),
    getFileStructure: vi.fn(async () => ({ file: result })),
    searchSymbols: vi.fn(async () => ({ symbols: [result] })),
    getSymbol: vi.fn(async () => ({ symbol: result })),
    findDefinition: vi.fn(async () => ({ availability: "available", definitions: [result] })),
    findReferences: vi.fn(async () => ({ availability: "available", references: [result] })),
    getDependencies: vi.fn(async () => ({ dependencies: [result] })),
    getDiagnostics: vi.fn(async () => ({ diagnostics: [result] })),
    readSourceExcerpt: vi.fn(async () => ({ excerpt: result })),
  } as unknown as SemanticQueryPort;
}

async function connectedClient(queryPort = createQueryPort()) {
  const server = createSemanticIndexMcpServer({ queryPort });
  const client = new Client({ name: "semantic-index-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transports.push(clientTransport, serverTransport);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, queryPort };
}

function contentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Expected an MCP tool result.");
  }
  const item = result.content.find((entry): entry is Record<string, unknown> => (
    isRecord(entry) && entry.type === "text" && typeof entry.text === "string"
  ));
  if (!item || typeof item.text !== "string") throw new Error("Expected a text tool result.");
  return item.text;
}

function isToolError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("semantic-index MCP server", () => {
  it("exposes exactly the SSD read-only tool set", async () => {
    const { client } = await connectedClient();

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "list_repositories",
      "get_repository_overview",
      "list_projects",
      "get_file_structure",
      "search_symbols",
      "get_symbol",
      "find_definition",
      "find_references",
      "get_dependencies",
      "get_diagnostics",
      "read_source_excerpt",
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(tools.tools.every((tool) => tool.annotations?.destructiveHint === false)).toBe(true);
  });

  it("forwards only a repository/revision-scoped search request to SemanticQueryPort", async () => {
    const { client, queryPort } = await connectedClient();

    const response = await client.callTool({
      name: "search_symbols",
      arguments: {
        ...scope,
        query: "quote service",
        languageIds: ["typescript"],
        relativePathPrefix: "src",
        limit: 10,
      },
    });

    expect(isToolError(response)).toBe(false);
    expect(JSON.parse(contentText(response))).toMatchObject({
      symbols: [expect.objectContaining(scope)],
    });
    expect(queryPort.searchSymbols).toHaveBeenCalledWith(
      expect.objectContaining({
        ...scope,
        query: "quote service",
        languageIds: ["typescript"],
        relativePathPrefix: "src",
        limit: 10,
      }),
      expect.any(AbortSignal),
    );
  });

  it("rejects an index result containing evidence from another revision", async () => {
    const queryPort = createQueryPort();
    (queryPort.getSymbol as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbol: evidence({ name: "QuoteService" }, { analysisRevision: "other-revision" }),
    });
    const { client } = await connectedClient(queryPort);

    const response = await client.callTool({
      name: "get_symbol",
      arguments: { ...scope, symbolKey: "example.QuoteService" },
    });

    expect(isToolError(response)).toBe(true);
    expect(contentText(response)).toContain("different repository revision");
  });

  it("rejects malformed evidence envelopes returned by the query port", async () => {
    const queryPort = createQueryPort();
    (queryPort.getSymbol as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbol: evidence({ name: "QuoteService" }, { confidence: 1.5 }),
    });
    const { client } = await connectedClient(queryPort);

    const response = await client.callTool({
      name: "get_symbol",
      arguments: { ...scope, symbolKey: "example.QuoteService" },
    });

    expect(isToolError(response)).toBe(true);
    expect(contentText(response)).toContain("invalid confidence");
  });

  it("rejects host-local paths returned by either scoped or repository-list queries", async () => {
    const scopedPort = createQueryPort();
    (scopedPort.getSymbol as ReturnType<typeof vi.fn>).mockResolvedValue({
      symbol: evidence({ name: "QuoteService" }, { localPath: "E:/secret/repository" }),
    });
    const { client: scopedClient } = await connectedClient(scopedPort);

    const scopedResponse = await scopedClient.callTool({
      name: "get_symbol",
      arguments: { ...scope, symbolKey: "example.QuoteService" },
    });

    expect(isToolError(scopedResponse)).toBe(true);
    expect(contentText(scopedResponse)).toContain("host-local path");

    const listPort = createQueryPort();
    (listPort.listRepositories as ReturnType<typeof vi.fn>).mockResolvedValue({
      repositories: [{ repositoryId: "history-quote", localPath: "E:/secret/repository" }],
    });
    const { client: listClient } = await connectedClient(listPort);

    const listResponse = await listClient.callTool({
      name: "list_repositories",
      arguments: {},
    });

    expect(isToolError(listResponse)).toBe(true);
    expect(contentText(listResponse)).toContain("host-local path");
  });

  it("does not expose arbitrary query-port failure details to MCP clients", async () => {
    const queryPort = createQueryPort();
    (queryPort.getSymbol as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("SeekDB password=top-secret at E:/secret/repository"),
    );
    const { client } = await connectedClient(queryPort);

    const response = await client.callTool({
      name: "get_symbol",
      arguments: { ...scope, symbolKey: "example.QuoteService" },
    });

    expect(isToolError(response)).toBe(true);
    expect(contentText(response)).toBe("Semantic index query failed.");
  });

  it("does not accept absolute or traversal paths from MCP clients", async () => {
    const { client, queryPort } = await connectedClient();

    const response = await client.callTool({
      name: "get_file_structure",
      arguments: { ...scope, relativePath: "../outside.ts" },
    });

    expect(isToolError(response)).toBe(true);
    expect(contentText(response)).toContain("relativePath must be a POSIX-style path");
    expect(queryPort.getFileStructure).not.toHaveBeenCalled();
  });

  it("uses the query port for repository discovery without accepting a local path", async () => {
    const { client, queryPort } = await connectedClient();

    const response = await client.callTool({
      name: "list_repositories",
      arguments: { roles: ["history"] },
    });

    expect(isToolError(response)).toBe(false);
    expect(queryPort.listRepositories).toHaveBeenCalledWith(
      { roles: ["history"] },
      expect.any(AbortSignal),
    );
  });

  it("permits the documented empty project root while keeping source paths relative", async () => {
    const queryPort = createQueryPort();
    (queryPort.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [evidence({
        repositoryId: scope.repositoryId,
        analysisRevision: scope.analysisRevision,
        projectId: "project-root",
        kind: "node",
        displayName: "root",
        relativePath: "",
        manifestPaths: ["package.json"],
        sourceRoots: ["src", ""],
        testRoots: ["test", ""],
        languageIds: ["typescript"],
      }, { relativePath: null, sourceRange: null })],
    });
    const { client } = await connectedClient(queryPort);

    const response = await client.callTool({ name: "list_projects", arguments: scope });

    expect(isToolError(response)).toBe(false);
  });
});
