import type {
  ModuleMigrationProposal,
  RepositoryArchitectureRequest,
  RepositoryStaticAnalysis,
} from "@forexplore/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ArchitectAgent,
  buildArchitectMessages,
  parseModuleMigrationProposal,
  type ArchitectMessage,
  type ArchitectModelClient,
} from "./architect-agent";

const analysis: RepositoryStaticAnalysis = {
  schemaVersion: "1.0",
  snapshotId: "snapshot-quote-v1",
  contentHash: "a".repeat(64),
  analyzerVersion: "code-indexer/1.0",
  createdAt: "2026-08-26T00:00:00.000Z",
  repository: { revision: "abc123" },
  files: [
    {
      path: "src/contracts/Quote.java",
      sha256: "1".repeat(64),
      role: "source",
      language: "Java",
      project: "quote",
    },
    {
      path: "src/service/QuoteService.java",
      sha256: "2".repeat(64),
      role: "source",
      language: "Java",
      project: "quote",
    },
    {
      path: "test/service/QuoteServiceTest.java",
      sha256: "3".repeat(64),
      role: "test",
      language: "Java",
      project: "quote",
    },
    {
      path: "generated/QuoteClient.java",
      sha256: "4".repeat(64),
      role: "generated",
      language: "Java",
      project: "quote",
    },
    {
      path: "pom.xml",
      sha256: "5".repeat(64),
      role: "configuration",
      project: "quote",
    },
  ],
  symbols: [
    {
      id: "symbol-quote",
      name: "Quote",
      qualifiedName: "example.contracts.Quote",
      kind: "class",
      language: "Java",
      path: "src/contracts/Quote.java",
    },
    {
      id: "symbol-quote-service",
      name: "QuoteService",
      qualifiedName: "example.service.QuoteService",
      kind: "class",
      language: "Java",
      path: "src/service/QuoteService.java",
    },
  ],
  dependencies: [
    {
      id: "edge-service-contract",
      sourceSymbolId: "symbol-quote-service",
      targetSymbolId: "symbol-quote",
      sourcePath: "src/service/QuoteService.java",
      targetPath: "src/contracts/Quote.java",
      kind: "type-reference",
      internal: true,
      resolution: "resolved",
      evidence: "semantic",
      evidenceRanges: [{ path: "src/service/QuoteService.java", startLine: 4 }],
      snapshotId: "snapshot-quote-v1",
    },
  ],
  diagnostics: [],
};

const request: RepositoryArchitectureRequest = {
  schemaVersion: "1.0",
  analysis,
  objective: "Partition the quote repository into migration modules.",
  immutableConstraints: ["Keep public contracts separate from service implementation."],
};

function proposal(): ModuleMigrationProposal {
  return {
    schemaVersion: "1.0",
    snapshotId: analysis.snapshotId,
    objective: request.objective,
    modules: [
      {
        id: "contracts",
        name: "Quote contracts",
        kind: "shared-contract",
        description: "Public quote data contracts.",
        sourceFiles: ["src/contracts/Quote.java"],
        symbolIds: ["symbol-quote"],
        dependsOn: [],
        writeSet: ["src/contracts/Quote.java"],
        resourceLocks: ["public:quote-contract"],
        evidenceIds: ["symbol-quote"],
      },
      {
        id: "quote-service",
        name: "Quote service",
        kind: "feature",
        description: "Quote orchestration service.",
        sourceFiles: ["src/service/QuoteService.java"],
        testFiles: ["test/service/QuoteServiceTest.java"],
        generatedFiles: ["generated/QuoteClient.java"],
        symbolIds: ["symbol-quote-service"],
        dependsOn: ["contracts"],
        writeSet: ["src/service/QuoteService.java", "test/service/QuoteServiceTest.java"],
        resourceLocks: [],
        evidenceIds: ["edge-service-contract", "symbol-quote-service"],
      },
    ],
    fileAssignments: [
      { path: "src/contracts/Quote.java", kind: "module", moduleId: "contracts" },
      { path: "src/service/QuoteService.java", kind: "module", moduleId: "quote-service" },
      { path: "test/service/QuoteServiceTest.java", kind: "test", moduleId: "quote-service" },
      { path: "generated/QuoteClient.java", kind: "generated", moduleId: "quote-service" },
      { path: "pom.xml", kind: "excluded", reason: "Project-level configuration." },
    ],
    dependencies: [{
      moduleId: "quote-service",
      dependsOnModuleId: "contracts",
      source: "static",
      evidenceEdgeIds: ["edge-service-contract"],
    }],
    risks: ["Generated client ownership requires human review."],
  };
}

describe("ArchitectAgent", () => {
  it("produces a validated read-only module proposal", async () => {
    const expected = proposal();
    const complete = vi.fn(async (_messages: readonly ArchitectMessage[]) => JSON.stringify(expected));
    const client: ArchitectModelClient = { complete };
    const agent = new ArchitectAgent({ client, allowUnverifiedAnalysis: true });

    await expect(agent.proposeModulePlan(request)).resolves.toEqual(expected);
    expect(complete).toHaveBeenCalledTimes(1);
    const messages = complete.mock.calls[0]?.[0] ?? [];
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("read-only");
    expect(messages[1]?.content).toContain("[REPOSITORY_STATIC_ANALYSIS]");
    expect(messages[1]?.content).toContain(analysis.snapshotId);
    expect(messages[1]?.content).toContain("[PLANNING_OBJECTIVE]");
  });

  it("accepts a proposal returned in a JSON markdown fence", () => {
    const value = proposal();
    expect(
      parseModuleMigrationProposal(`proposal:\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``, request),
    ).toEqual(value);
  });

  it("repairs malformed model output at most twice", async () => {
    const invalid = proposal() as ModuleMigrationProposal & { schedule?: string };
    invalid.schedule = "parallel";
    const corrected = proposal();
    const calls: Array<readonly ArchitectMessage[]> = [];
    const client: ArchitectModelClient = {
      complete: async (messages) => {
        calls.push(messages);
        return JSON.stringify(calls.length === 1 ? invalid : corrected);
      },
    };
    const agent = new ArchitectAgent({ client, allowUnverifiedAnalysis: true });

    await expect(agent.proposeModulePlan(request)).resolves.toEqual(corrected);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(calls[1]?.[2]?.content).toContain("unsupported field schedule");
  });

  it("stops after two failed repair attempts", async () => {
    const invalid = proposal() as ModuleMigrationProposal & { source?: string };
    invalid.source = "untrusted repository source";
    const complete = vi.fn(async () => JSON.stringify(invalid));
    const agent = new ArchitectAgent({ client: { complete }, allowUnverifiedAnalysis: true });

    await expect(agent.proposeModulePlan(request)).rejects.toThrow("unsupported field source");
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("rejects a proposal that bypasses evidence, ownership, or snapshot binding", () => {
    const unknownEvidence = proposal();
    unknownEvidence.modules[0]!.evidenceIds = ["invented-edge"];
    expect(() => parseModuleMigrationProposal(JSON.stringify(unknownEvidence), request)).toThrow(
      "unknown snapshot evidence",
    );

    const duplicateOwnership = proposal();
    duplicateOwnership.modules[1]!.sourceFiles.push("src/contracts/Quote.java");
    expect(() => parseModuleMigrationProposal(JSON.stringify(duplicateOwnership), request)).toThrow(
      "must have matching module file assignments",
    );

    const crossModuleWrite = proposal();
    crossModuleWrite.modules[0]!.writeSet.push("src/service/QuoteService.java");
    expect(() => parseModuleMigrationProposal(JSON.stringify(crossModuleWrite), request)).toThrow(
      "outside its explicit ownership",
    );

    const wrongSnapshot = proposal();
    wrongSnapshot.snapshotId = "another-snapshot";
    expect(() => parseModuleMigrationProposal(JSON.stringify(wrongSnapshot), request)).toThrow(
      "must match the supplied analysis snapshot",
    );

    const nonEdgeDependencyEvidence = proposal();
    nonEdgeDependencyEvidence.dependencies![0]!.evidenceEdgeIds = ["symbol-quote"];
    expect(() => parseModuleMigrationProposal(JSON.stringify(nonEdgeDependencyEvidence), request)).toThrow(
      "unknown snapshot edge",
    );
  });

  it("rejects separator and control characters in untrusted module IDs", () => {
    const separator = proposal();
    separator.modules[0]!.id = "contracts|service";
    expect(() => parseModuleMigrationProposal(JSON.stringify(separator), request)).toThrow(
      "must start with an ASCII letter or digit",
    );

    const control = proposal();
    control.modules[0]!.id = "contracts\u0000service";
    expect(() => parseModuleMigrationProposal(JSON.stringify(control), request)).toThrow(
      "must start with an ASCII letter or digit",
    );
  });

  it("rejects invalid architecture requests before making a model call", async () => {
    const client = { complete: vi.fn(async () => "never") };
    const agent = new ArchitectAgent({ client, allowUnverifiedAnalysis: true });

    await expect(
      agent.proposeModulePlan({ ...request, objective: "  " }),
    ).rejects.toThrow("objective must be a non-empty string");
    expect(client.complete).not.toHaveBeenCalled();
  });

  it("propagates model client failures", async () => {
    const client = {
      complete: vi.fn(async () => {
        throw new Error("upstream timeout");
      }),
    };
    const agent = new ArchitectAgent({ client, allowUnverifiedAnalysis: true });

    await expect(agent.proposeModulePlan(request)).rejects.toThrow("upstream timeout");
  });

  it("verifies static-analysis evidence before calling the model", async () => {
    const complete = vi.fn(async () => JSON.stringify(proposal()));
    const agent = new ArchitectAgent({ client: { complete } });

    await expect(agent.proposeModulePlan(request)).rejects.toThrow(
      "Repository static analysis content hash does not match",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a verifier result that changes snapshot identity", async () => {
    const complete = vi.fn(async () => JSON.stringify(proposal()));
    const agent = new ArchitectAgent({
      client: { complete },
      analysisVerifier: () => ({ ...analysis, snapshotId: "different" }),
    });

    await expect(agent.proposeModulePlan(request)).rejects.toThrow(
      "different snapshot identity",
    );
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("buildArchitectMessages", () => {
  it("keeps snapshot facts and planning intent in separate prompt sections", () => {
    const messages = buildArchitectMessages(request);
    expect(messages[0]?.content).toContain("Agenticodex");
    expect(messages[1]?.content).toContain("[IMMUTABLE_CONSTRAINTS]");
    expect(messages[1]?.content).toContain("[OUTPUT_SCHEMA]");
  });
});
