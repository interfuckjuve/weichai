import type { SemanticQueryPort } from "@forexplore/workflow-core";
import { describe, expect, it, vi } from "vitest";
import {
  ToolCallingArchitectRuntime,
  type RevisionScopedModulePlanProposal,
  type ToolCallingArchitectModelClient,
  type ToolCallingArchitectRequest,
} from "./tool-calling-architect-runtime";

const scope = {
  repositoryId: "history-quote",
  analysisRevision: "revision-20260904",
};

const analysisHash = "a".repeat(64);
const symbolKey = "java:example.QuoteService:class";
const evidenceId = "symbol:symbol-quote-service";

const request: ToolCallingArchitectRequest = {
  schemaVersion: "1.0",
  ...scope,
  objective: "Partition quote service into a module.",
};

function proposal(overrides: Partial<RevisionScopedModulePlanProposal> = {}): RevisionScopedModulePlanProposal {
  return {
    schemaVersion: "1.0",
    ...scope,
    analysisHash,
    objective: request.objective,
    modules: [{
      id: "quote-service",
      name: "Quote service",
      kind: "feature",
      description: "Handles quote requests.",
      sourceFiles: ["src/QuoteService.java"],
      symbolKeys: [symbolKey],
      dependsOn: [],
      writeSet: ["src/QuoteService.java"],
      resourceLocks: [],
      evidenceIds: [evidenceId],
    }],
    dependencies: [],
    ...overrides,
  };
}

function overview(overrides: Record<string, unknown> = {}) {
  return {
    overview: {
      ...scope,
      evidenceId: "revision:history-quote:revision-20260904",
      provider: "tree-sitter",
      confidence: 1,
      evidenceLevel: "structural",
      relativePath: null,
      sourceRange: null,
      value: {
        revision: { ...scope, analysisHash },
      },
      ...overrides,
    },
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    ...scope,
    evidenceId,
    provider: "tree-sitter",
    confidence: 0.9,
    evidenceLevel: "structural",
    relativePath: "src/QuoteService.java",
    sourceRange: { startLine: 1, startColumn: 1, endLine: 8, endColumn: 1 },
    value: {
      symbolKey,
      relativePath: "src/QuoteService.java",
      sourceRange: { startLine: 1, startColumn: 1, endLine: 8, endColumn: 1 },
    },
    ...overrides,
  };
}

function queryPort(result = { symbols: [evidence()] }): SemanticQueryPort {
  return {
    listRepositories: vi.fn(),
    getRepositoryOverview: vi.fn(async () => overview()),
    listProjects: vi.fn(),
    getFileStructure: vi.fn(),
    searchSymbols: vi.fn(async () => result),
    getSymbol: vi.fn(),
    findDefinition: vi.fn(),
    findReferences: vi.fn(),
    getDependencies: vi.fn(),
    getDiagnostics: vi.fn(),
    readSourceExcerpt: vi.fn(),
  } as unknown as SemanticQueryPort;
}

function scriptedClient(
  responses: Array<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: unknown }> }>,
): ToolCallingArchitectModelClient {
  const complete = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No scripted model response remains.");
    return next;
  });
  return { complete };
}

describe("ToolCallingArchitectRuntime", () => {
  it("binds the plan to the structural revision hash and only sends tool-derived facts to the model", async () => {
    const port = queryPort();
    const client = scriptedClient([
      {
        toolCalls: [{
          id: "tool-search",
          name: "search_symbols",
          arguments: JSON.stringify({ query: "QuoteService" }),
        }],
      },
      { content: JSON.stringify(proposal()) },
    ]);
    const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });

    const result = await runtime.proposeModulePlanWithEvidence(request);

    expect(result.proposal).toEqual(proposal());
    expect(result.evidence).toMatchObject({
      ...scope,
      analysisHash,
      evidenceIds: [evidenceId],
    });
    expect(result.evidence.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(port.getRepositoryOverview).toHaveBeenCalledWith(scope, undefined);
    expect(port.searchSymbols).toHaveBeenCalledWith(
      { ...scope, query: "QuoteService" },
      undefined,
    );
    const complete = client.complete as ReturnType<typeof vi.fn>;
    const initialMessages = complete.mock.calls[0]?.[0] as unknown;
    expect(JSON.stringify(initialMessages)).toContain(analysisHash);
    expect(JSON.stringify(initialMessages)).not.toContain("RepositoryStaticAnalysis");
    expect(JSON.stringify(initialMessages)).not.toContain("C:\\private");
  });

  it("rejects a model attempt to switch repository or analysis revision", async () => {
    const port = queryPort();
    const client = scriptedClient([{
      toolCalls: [{
        id: "tool-search",
        name: "search_symbols",
        arguments: { repositoryId: "another-repository", query: "QuoteService" },
      }],
    }]);
    const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });

    await expect(runtime.proposeModulePlan(request)).rejects.toThrow("attempted to change repositoryId");
    expect(port.searchSymbols).not.toHaveBeenCalled();
  });

  it("rejects a repository overview whose scope or hash is invalid", async () => {
    const port = queryPort();
    (port.getRepositoryOverview as ReturnType<typeof vi.fn>).mockResolvedValue(
      overview({ analysisRevision: "another-revision" }),
    );
    const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client: scriptedClient([]) });

    await expect(runtime.proposeModulePlan(request)).rejects.toThrow("different repository revision");
  });

  it("rejects evidence returned for a different revision", async () => {
    const port = queryPort({ symbols: [evidence({ analysisRevision: "another-revision" })] });
    const client = scriptedClient([{
      toolCalls: [{
        id: "tool-search",
        name: "search_symbols",
        arguments: { query: "QuoteService" },
      }],
    }]);
    const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });

    await expect(runtime.proposeModulePlan(request)).rejects.toThrow("different repository revision");
  });

  it("rejects nested index records whose scope or path disagrees with the selected revision", async () => {
    const nestedWrongScope = evidence({
      value: {
        ...scope,
        repositoryId: "another-repository",
        symbolKey,
        relativePath: "src/QuoteService.java",
        sourceRange: { startLine: 1, startColumn: 1, endLine: 8, endColumn: 1 },
      },
    });
    const nestedUnsafePath = evidence({
      value: {
        ...scope,
        symbolKey,
        relativePath: "C:/private/secret.java",
        sourceRange: { startLine: 1, startColumn: 1, endLine: 8, endColumn: 1 },
      },
    });

    for (const result of [{ symbols: [nestedWrongScope] }, { symbols: [nestedUnsafePath] }]) {
      const port = queryPort(result);
      const client = scriptedClient([{
        toolCalls: [{ id: "tool-search", name: "search_symbols", arguments: { query: "QuoteService" } }],
      }]);
      const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });

      await expect(runtime.proposeModulePlan(request)).rejects.toThrow(
        result.symbols[0] === nestedWrongScope ? "different repository revision" : "unsafe relativePath",
      );
    }
  });

  it("does not advertise or forward query values beyond SemanticQueryPort limits", async () => {
    const port = queryPort();
    const limitClient = scriptedClient([{
      toolCalls: [{
        id: "tool-search",
        name: "search_symbols",
        arguments: { query: "QuoteService", limit: 201 },
      }],
    }]);
    await expect(new ToolCallingArchitectRuntime({ queryPort: port, client: limitClient }).proposeModulePlan(request))
      .rejects.toThrow("search_symbols.limit must be an integer between 1 and 200");
    expect(port.searchSymbols).not.toHaveBeenCalled();

    const excerptClient = scriptedClient([{
      toolCalls: [{
        id: "tool-excerpt",
        name: "read_source_excerpt",
        arguments: { relativePath: "src/QuoteService.java", maxChars: 32_001 },
      }],
    }]);
    await expect(new ToolCallingArchitectRuntime({ queryPort: port, client: excerptClient }).proposeModulePlan(request))
      .rejects.toThrow("read_source_excerpt.maxChars must be an integer between 1 and 32000");
    expect(port.readSourceExcerpt).not.toHaveBeenCalled();
  });

  it("rejects plans with stale hashes or unqueried evidence", async () => {
    const port = queryPort();
    const staleHash = proposal({ analysisHash: "b".repeat(64) });
    const unqueried = proposal({
      modules: [{ ...proposal().modules[0]!, evidenceIds: ["symbol:unqueried"] }],
    });
    for (const output of [staleHash, unqueried]) {
      const client = scriptedClient([
        { toolCalls: [{ id: "tool-search", name: "search_symbols", arguments: { query: "QuoteService" } }] },
        { content: JSON.stringify(output) },
      ]);
      const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });
      await expect(runtime.proposeModulePlan(request)).rejects.toThrow(
        output === staleHash ? "analysisHash" : "not retrieved through SemanticQueryPort",
      );
    }
  });

  it("rejects an unsupported tool before it can access implementation details", async () => {
    const port = queryPort();
    const client = scriptedClient([{
      toolCalls: [{ id: "tool-fs", name: "read_file", arguments: { path: "C:/private/secret" } }],
    }]);
    const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });

    await expect(runtime.proposeModulePlan(request)).rejects.toThrow("unsupported tool");
    expect(port.searchSymbols).not.toHaveBeenCalled();
  });

  it("enforces each declared tool input shape instead of forwarding model-invented path fields", async () => {
    const port = queryPort();
    const client = scriptedClient([{
      toolCalls: [{
        id: "tool-search",
        name: "search_symbols",
        arguments: { query: "QuoteService", filePath: "C:/private/secret" },
      }],
    }]);
    const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });

    await expect(runtime.proposeModulePlan(request)).rejects.toThrow("unsupported search_symbols argument filePath");
    expect(port.searchSymbols).not.toHaveBeenCalled();
  });
});
