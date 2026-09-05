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
  function projectPort() {
    const port = queryPort();
    const selected = evidence({ evidenceId: 'project:quote', relativePath: null, sourceRange: null,
      value: { projectId: 'quote', kind: 'maven', displayName: 'Quote', relativePath: '',
        manifestPaths: ['pom.xml'], languageIds: ['java'],
        files: [{ relativePath: 'src/QuoteService.java', role: 'source', parseStatus: 'parsed' }] } });
    vi.mocked(port.listProjects).mockResolvedValue({ projects: [selected,
      evidence({ evidenceId: 'project:unrelated', value: { projectId: 'unrelated', files: [{ relativePath: 'unrelated/Secret.java' }] } }),
    ] } as never);
    vi.mocked(port.getDependencies).mockResolvedValue({ dependencies: [evidence({
      evidenceId: 'dependency:quote', value: { sourceRelativePath: 'src/QuoteService.java',
        targetReference: 'external.price', kind: 'import', resolution: 'unresolved', internal: false },
    })] } as never);
    return port;
  }

  it('provides selected-project dependencies and symbols before the first model call and permits a direct proposal', async () => {
    const port = projectPort();
    const client = scriptedClient([{ content: JSON.stringify(proposal()) }]);
    const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client });
    const result = await runtime.proposeModulePlanWithEvidence({ ...request, projectId: 'quote' });
    expect(result.proposal).toEqual(proposal());
    expect(result.evidence.evidenceIds).toContain('dependency:quote');
    expect(result.evidence.evidenceIds).not.toContain('project:unrelated');
    const messages = JSON.stringify(vi.mocked(client.complete).mock.calls[0]![0]);
    expect(messages).toContain('[INITIAL_PROJECT_CONTEXT]');
    expect(messages).toContain('external.price');
    expect(messages).toContain('unresolved');
    expect(messages).toContain(symbolKey);
    expect(messages).not.toContain('unrelated/Secret.java');
    expect(port.getDependencies).toHaveBeenCalledWith({ ...scope, projectId: 'quote', direction: 'both', limit: 200 }, undefined);
    expect(port.searchSymbols).toHaveBeenCalledWith({ ...scope, projectIds: ['quote'], query: '', limit: 100 }, undefined);
    expect(port.readSourceExcerpt).not.toHaveBeenCalled();
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it('keeps optional source inspection available after preloading evidence', async () => {
    const port = projectPort();
    vi.mocked(port.readSourceExcerpt).mockResolvedValue({ source: evidence({ value: { text: 'class QuoteService {}' } }) } as never);
    const client = scriptedClient([
      { toolCalls: [{ id: 'source', name: 'read_source_excerpt', arguments: { relativePath: 'src/QuoteService.java', maxChars: 1000 } }] },
      { content: JSON.stringify(proposal()) },
    ]);
    await new ToolCallingArchitectRuntime({ queryPort: port, client }).proposeModulePlan({ ...request, projectId: 'quote' });
    expect(port.readSourceExcerpt).toHaveBeenCalledTimes(1);
    expect(port.listProjects).toHaveBeenCalledTimes(1);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it('allows the model to correct an invalid source range without forwarding it', async () => {
    const port = projectPort();
    vi.mocked(port.readSourceExcerpt).mockResolvedValue({ source: evidence({ value: { text: 'class QuoteService {}' } }) } as never);
    const client = scriptedClient([
      { toolCalls: [{ id: 'bad-range', name: 'read_source_excerpt', arguments: {
        relativePath: 'src/QuoteService.java', sourceRange: { startLine: 1, endLine: 8 },
      } }] },
      { toolCalls: [{ id: 'corrected', name: 'read_source_excerpt', arguments: { relativePath: 'src/QuoteService.java', maxChars: 1000 } }] },
      { content: JSON.stringify(proposal()) },
    ]);
    await new ToolCallingArchitectRuntime({ queryPort: port, client }).proposeModulePlan({ ...request, projectId: 'quote' });
    expect(port.readSourceExcerpt).toHaveBeenCalledTimes(1);
    const correction = vi.mocked(client.complete).mock.calls[1]![0].find((message) => message.toolCallId === 'bad-range');
    expect(JSON.parse(correction!.content)).toMatchObject({ error: 'invalid_arguments' });
  });

  it('finishes with existing evidence when a batch exceeds the remaining query budget', async () => {
    const port = projectPort();
    const client = scriptedClient([
      { toolCalls: [
        { id: 'overview', name: 'get_repository_overview', arguments: {} },
        { id: 'overflow', name: 'read_source_excerpt', arguments: { relativePath: 'src/QuoteService.java' } },
      ] },
      { content: JSON.stringify(proposal()) },
    ]);
    await new ToolCallingArchitectRuntime({ queryPort: port, client, maxToolCalls: 1 })
      .proposeModulePlan({ ...request, projectId: 'quote' });
    expect(port.getRepositoryOverview).toHaveBeenCalledTimes(1);
    expect(port.readSourceExcerpt).not.toHaveBeenCalled();
    const [messages, tools] = vi.mocked(client.complete).mock.calls[1]!;
    expect(tools).toEqual([]);
    expect(JSON.parse(messages.find((message) => message.toolCallId === 'overflow')!.content))
      .toMatchObject({ error: 'query_budget_exhausted' });
  });

  it('paginates initial dependencies and preserves unresolved file relationships in compact groups', async () => {
    const port = projectPort();
    vi.mocked(port.getDependencies)
      .mockResolvedValueOnce({ dependencies: [evidence({ evidenceId: 'dep:1', value: {
        sourceRelativePath: 'src/QuoteService.java', targetReference: 'first', kind: 'invocation', resolution: 'unresolved',
      } })], nextCursor: 'second' } as never)
      .mockResolvedValueOnce({ dependencies: [evidence({ evidenceId: 'dep:2', value: {
        sourceRelativePath: 'src/QuoteService.java', targetReference: 'second', kind: 'invocation', resolution: 'unresolved',
      } })] } as never);
    const client = scriptedClient([{ content: JSON.stringify(proposal()) }]);
    await new ToolCallingArchitectRuntime({ queryPort: port, client }).proposeModulePlan({ ...request, projectId: 'quote' });
    const content = vi.mocked(client.complete).mock.calls[0]![0][1]!.content;
    const context = JSON.parse(content.split('[INITIAL_PROJECT_CONTEXT]\n')[1]!.split('\n')[0]!);
    expect(context.dependencies.items).toHaveLength(1);
    expect(context.dependencies.items[0]).toMatchObject({ count: 2, resolution: 'unresolved', targetReferences: ['first', 'second'] });
    expect(context.dependencies.nextCursor).toBeUndefined();
    expect(port.getDependencies).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'second' }), undefined);
  });

  it('returns valid bounded JSON and rejects evidence hidden by result trimming', async () => {
    const hiddenId = 'symbol:hidden';
    const port = queryPort({ symbols: Array.from({ length: 20 }, (_, index) => evidence({
      evidenceId: index === 19 ? hiddenId : `symbol:${index}`, value: { symbolKey, signature: 'x'.repeat(500) },
    })) });
    const client = scriptedClient([
      { toolCalls: [{ id: 'large', name: 'search_symbols', arguments: { query: 'Quote' } }] },
      { content: JSON.stringify(proposal({ modules: [{ ...proposal().modules[0]!, evidenceIds: [hiddenId] }] })) },
    ]);
    await expect(new ToolCallingArchitectRuntime({ queryPort: port, client, maxToolResultChars: 2000, maxProposalRepairs: 0 })
      .proposeModulePlan(request)).rejects.toThrow('not retrieved through SemanticQueryPort');
    const content = vi.mocked(client.complete).mock.calls[1]![0].find((message) => message.toolCallId === 'large')!.content;
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(content)).toMatchObject({ truncated: true });
    expect(content).not.toContain(hiddenId);
  });

  it('marks omitted initial records without admitting their hidden evidence and rejects wrong-revision preloads', async () => {
    const port = projectPort();
    vi.mocked(port.searchSymbols).mockResolvedValue({ symbols: [evidence({ value: { symbolKey, signature: 'x'.repeat(20000) } })], nextCursor: 'next-page' } as never);
    const client = scriptedClient([{ content: JSON.stringify(proposal()) }]);
    await expect(new ToolCallingArchitectRuntime({ queryPort: port, client, maxToolResultChars: 3000, maxProposalRepairs: 0 })
      .proposeModulePlan({ ...request, projectId: 'quote' })).rejects.toThrow();
    const messages = vi.mocked(client.complete).mock.calls[0]![0];
    const user = messages.find((message) => message.role === 'user')!.content;
    const context = JSON.parse(user.split('[INITIAL_PROJECT_CONTEXT]\n')[1]!.split('\n')[0]!);
    expect(context.symbols).toMatchObject({ items: [], omittedFromPage: 1, nextCursor: 'next-page' });
    vi.mocked(port.getDependencies).mockResolvedValue({ dependencies: [evidence({ analysisRevision: 'wrong' })] } as never);
    await expect(new ToolCallingArchitectRuntime({ queryPort: port, client })
      .proposeModulePlan({ ...request, projectId: 'quote' })).rejects.toThrow('different repository revision');
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

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
      const runtime = new ToolCallingArchitectRuntime({ queryPort: port, client, maxProposalRepairs: 0 });
      await expect(runtime.proposeModulePlan(request)).rejects.toThrow(
        output === staleHash ? "analysisHash" : "not retrieved through SemanticQueryPort",
      );
    }
  });

  it('returns validation feedback and only accepts a corrected evidence-bound proposal', async () => {
    const port = projectPort();
    const invalid = proposal({ modules: [{ ...proposal().modules[0]!, symbolKeys: [evidenceId] }] });
    const client = scriptedClient([
      { content: JSON.stringify(invalid) },
      { content: JSON.stringify(proposal()) },
    ]);
    const result = await new ToolCallingArchitectRuntime({ queryPort: port, client })
      .proposeModulePlan({ ...request, projectId: 'quote' });
    expect(result).toEqual(proposal());
    const [messages, tools] = vi.mocked(client.complete).mock.calls[1]!;
    expect(tools).toEqual([]);
    expect(messages.at(-1)!.content).toContain('not retrieved through SemanticQueryPort');
    expect(messages.at(-1)!.content).toContain(evidenceId);
  });

  it('stops after two invalid proposal repairs without accepting fabricated citations', async () => {
    const port = projectPort();
    const invalid = proposal({ modules: [{ ...proposal().modules[0]!, evidenceIds: ['invented'] }] });
    const client = scriptedClient(Array.from({ length: 3 }, () => ({ content: JSON.stringify(invalid) })));
    await expect(new ToolCallingArchitectRuntime({ queryPort: port, client })
      .proposeModulePlan({ ...request, projectId: 'quote' })).rejects.toThrow('not retrieved through SemanticQueryPort');
    expect(client.complete).toHaveBeenCalledTimes(3);
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
