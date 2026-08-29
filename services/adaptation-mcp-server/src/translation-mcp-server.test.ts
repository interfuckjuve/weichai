import { fileURLToPath } from "node:url";
import {
  moduleMigrationSchemaVersion,
  type AnalysisReport,
  type ModuleMigrationProposal,
  type RepositoryArchitectureRequest,
  type RepositoryStaticAnalysis,
  type SearchCandidate,
} from "@forexplore/contracts";
import type {
  RepositoryArchitecturePort,
  StaticAnalysisSnapshotStore,
} from "@forexplore/adaptation-service";
import type {
  AdaptationMcpServerOptions,
} from "./translation-mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdaptationMcpServer } from "./translation-mcp-server";

const projectRoot = fileURLToPath(
  new URL("../../../fixtures/target-system/forexplore-csharp-workspace", import.meta.url),
);

const target = {
  id: "get-quote-async-function",
  name: "GetQuoteAsync",
  kind: "function" as const,
  path: "src/Application/QuoteOrchestrationService.cs",
  language: "C#" as const,
  signature: "Task<Quote> GetQuoteAsync(QuoteRequest request, CancellationToken cancellationToken)",
  documentation: "Gets a quote through cache and provider fallback.",
  line: 24,
};

const candidate: SearchCandidate = {
  id: "java-candidate",
  title: "route",
  repository: "fixture/java",
  license: "Apache-2.0",
  language: "Java",
  kind: "function",
  path: "src/QuoteRouter.java",
  signature: "public Quote route(QuoteRequest request)",
  summary: "Routes a quote request.",
  score: { overall: 0.9, semantic: 0.9, symbol: 0.8, contract: 0.7 },
  preview: "public Quote route(QuoteRequest request) { return provider.fetch(request); }",
  dependencies: ["ProviderClient"],
  compatibility: [],
  risks: [],
};

const requirement = "Preserve the asynchronous quote fallback contract.";
const analysisReport: AnalysisReport = {
  schemaVersion: "1.0",
  applicability: {
    level: "adapt",
    confidence: 0.86,
    reasons: ["The candidate behavior maps to the target contract with async adaptation."],
  },
  behaviorMapping: [{
    requirement,
    status: "partial",
    candidateEvidence: ["provider.fetch(request)"],
    targetAction: "Keep the target asynchronous boundary and existing provider dependency.",
  }],
  contractMapping: [{
    source: "route",
    target: "GetQuoteAsync",
    action: "rename",
    note: "Preserve the target method name and signature.",
  }],
  dependencyPlan: [{
    sourceDependency: "ProviderClient",
    targetDependency: "IQuoteProvider",
    action: "adapt",
  }],
  implementationPlan: [
    "Preserve the exact target signature.",
    "Use the existing target provider dependency asynchronously.",
  ],
  risks: [],
  assumptions: [],
  unresolved: [],
};

const generatedCode = `public async ${target.signature}\n{\n    throw new NotImplementedException();\n}`;

const staticAnalysis: RepositoryStaticAnalysis = {
  schemaVersion: moduleMigrationSchemaVersion,
  snapshotId: "snapshot-module-mcp",
  contentHash: "sha256:module-mcp",
  analyzerVersion: "test",
  createdAt: "2026-08-27T00:00:00.000Z",
  repository: { revision: "0123456789012345678901234567890123456789" },
  files: [{
    path: "src/QuoteRouter.java",
    sha256: "sha256:file",
    role: "source",
    language: "Java",
  }],
  symbols: [],
  dependencies: [],
  diagnostics: [],
};

const moduleProposal: ModuleMigrationProposal = {
  schemaVersion: moduleMigrationSchemaVersion,
  snapshotId: staticAnalysis.snapshotId,
  objective: "Group quote routing modules",
  modules: [],
  fileAssignments: [{
    path: "src/QuoteRouter.java",
    kind: "excluded",
    reason: "Fixture proposal only",
  }],
  dependencies: [],
};

const transports: Array<InMemoryTransport> = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

async function connectedClient(
  extraOptions: Partial<AdaptationMcpServerOptions> = {},
) {
  const analyzer = { analyze: vi.fn(async () => analysisReport) };
  const translatorRequest = vi.fn(async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      schemaVersion: "1.0",
      generatedCode,
      interfaceMappings: analysisReport.contractMapping,
      completedSteps: analysisReport.implementationPlan,
      unresolved: [],
    }) } }],
  }), { status: 200 })) as unknown as typeof globalThis.fetch;
  const validator = {
    compileStandalone: () => ({ success: false, errors: [".NET SDK not installed."], output: "" }),
    compileIntegrated: () => ({ success: false, errors: [".NET SDK not installed."], output: "" }),
    isUnavailable: () => true,
  };
  const server = createAdaptationMcpServer({
    apiKey: "test-key",
    projectRoot,
    analyzer,
    translatorRequest,
    validator,
    ...extraOptions,
  });
  const client = new Client({ name: "forexplore-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  transports.push(clientTransport, serverTransport);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return { analyzer, client };
}

function contentText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("Expected an MCP tool result.");
  }
  const text = result.content.find(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.type === "text" && typeof item.text === "string",
  );
  if (!text || typeof text.text !== "string") throw new Error("Expected a text tool result.");
  return text.text;
}

function isToolError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("ForeXplore adaptation MCP server", () => {
  it("lists the guarded translation tool set", async () => {
    const { client } = await connectedClient();

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "forexplore_collect_target_context",
      "forexplore_analyze_translation",
      "forexplore_validate_rerank",
      "forexplore_generate_translation",
      "forexplore_repair_translation",
      "forexplore_validate_translation",
      "forexplore_adapt_translation",
    ]);
    expect(tools.tools.map((tool) => tool.name)).not.toContain("forexplore_apply_patch");
  });

  it("exposes module planning only with a server-owned snapshot and architecture port", async () => {
    const proposeModulePlan = vi.fn(async (
      _request: RepositoryArchitectureRequest,
      _signal?: AbortSignal,
    ) => moduleProposal);
    const architecturePort: RepositoryArchitecturePort = {
      proposeModulePlan,
    };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = {
      getSnapshot: vi.fn(async (snapshotId) => (
        snapshotId === staticAnalysis.snapshotId ? staticAnalysis : null
      )),
    };
    const { client } = await connectedClient({ architecturePort, staticAnalysisSnapshots });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("forexplore_propose_module_plan");

    const result = await client.callTool({
      name: "forexplore_propose_module_plan",
      arguments: {
        snapshotId: staticAnalysis.snapshotId,
        objective: moduleProposal.objective,
        immutableConstraints: ["Keep public interfaces stable."],
      },
    });

    expect(isToolError(result)).toBe(false);
    expect(JSON.parse(contentText(result))).toEqual(moduleProposal);
    expect(staticAnalysisSnapshots.getSnapshot).toHaveBeenCalledWith(
      staticAnalysis.snapshotId,
      expect.any(AbortSignal),
    );
    expect(proposeModulePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: moduleMigrationSchemaVersion,
        analysis: staticAnalysis,
        objective: moduleProposal.objective,
        immutableConstraints: ["Keep public interfaces stable."],
      }),
      expect.any(AbortSignal),
    );
    const request = proposeModulePlan.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(request).not.toHaveProperty("source");
  });

  it("returns a read-only module planning error when a snapshot is missing", async () => {
    const architecturePort: RepositoryArchitecturePort = { proposeModulePlan: vi.fn() };
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = {
      getSnapshot: vi.fn(async () => null),
    };
    const { client } = await connectedClient({ architecturePort, staticAnalysisSnapshots });

    const result = await client.callTool({
      name: "forexplore_propose_module_plan",
      arguments: { snapshotId: "missing", objective: "Group modules" },
    });

    expect(isToolError(result)).toBe(true);
    expect(contentText(result)).toContain("Static analysis snapshot was not found");
    expect(architecturePort.proposeModulePlan).not.toHaveBeenCalled();
  });

  it("collects bounded target context and runs the full adaptation workflow", async () => {
    const { analyzer, client } = await connectedClient();

    const contextResult = await client.callTool({
      name: "forexplore_collect_target_context",
      arguments: { target },
    });
    const context = JSON.parse(contentText(contextResult)) as { target: { name: string } };
    expect(context.target.name).toBe("GetQuoteAsync");

    const adaptationResult = await client.callTool({
      name: "forexplore_adapt_translation",
      arguments: { target, candidate, requirement, decisionNotes: "" },
    });
    const adaptation = JSON.parse(contentText(adaptationResult)) as {
      generatedCode: string;
      files: unknown[];
    };
    expect(isToolError(adaptationResult)).toBe(false);
    expect(adaptation.generatedCode).toBe(generatedCode);
    expect(adaptation.files).toHaveLength(1);
    expect(analyzer.analyze).toHaveBeenCalledTimes(1);
  });

  it("uses a required unverified verifier gate when no isolated verifier is injected", async () => {
    const { client } = await connectedClient({
      validator: {
        compileStandalone: () => ({ success: true, errors: [], output: "" }),
        compileIntegrated: () => ({ success: true, errors: [], output: "" }),
        isUnavailable: () => false,
      },
    });

    const result = await client.callTool({
      name: "forexplore_adapt_translation",
      arguments: { target, candidate, requirement, decisionNotes: "" },
    });
    const adaptation = JSON.parse(contentText(result)) as {
      validation: Array<{ id: string; status: string; required: boolean }>;
    };

    expect(adaptation.validation).toContainEqual(expect.objectContaining({
      id: "differential-verification",
      status: "unverified",
      required: true,
    }));
  });

  it("returns an MCP tool error for a target path outside the configured project root", async () => {
    const { client } = await connectedClient();

    const result = await client.callTool({
      name: "forexplore_collect_target_context",
      arguments: { target: { ...target, path: "../package.json" } },
    });

    expect(isToolError(result)).toBe(true);
    expect(contentText(result)).toContain("Target path must stay inside the project root");
  });

  it("validates reranking candidate IDs through the MCP tool", async () => {
    const { client } = await connectedClient();
    const result = await client.callTool({
      name: "forexplore_validate_rerank",
      arguments: {
        candidateIds: ["first", "second"],
        results: [
          { id: "first", score: 0.9 },
          { id: "invented", score: 0.8 },
        ],
      },
    });

    expect(isToolError(result)).toBe(false);
    expect(JSON.parse(contentText(result))).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.stringContaining("unknown candidate ID: invented"),
        expect.stringContaining("Missing candidate IDs"),
      ]),
    });
  });
});
