import type {
  ModuleDiscoveryProposal,
  RepositoryStaticAnalysis,
  UnifiedRepositoryIR,
} from "@forexplore/contracts";
import {
  repositoryAnalysisContentHash,
  repositoryAnalysisSnapshotId,
} from "@forexplore/code-indexer";
import { describe, expect, it, vi } from "vitest";
import {
  ModuleDiscoveryAgent,
  type ModuleDiscoveryDraft,
  type ModuleDiscoveryMessage,
  buildModuleDiscoveryMessages,
  materializeModuleDiscoveryProposal,
  parseModuleDiscoveryDraft,
  repositoryStaticAnalysisToUnifiedIr,
  validateModuleDiscoveryDraft,
  validateModuleDiscoveryProposal,
} from "./module-discovery-agent";

const now = "2026-08-31T12:00:00.000Z";

function ir(): UnifiedRepositoryIR {
  return {
    schemaVersion: "1.1",
    id: "ir-quote",
    repositoryId: "repository-quote",
    profileId: "profile-quote",
    repositoryRevision: "abc123",
    repositoryContentHash: "repository-hash",
    sourceShardIds: ["shard-java"],
    capabilities: [
      "file-inventory",
      "symbol-index",
      "api-surface",
      "dependency-graph",
      "semantic-binding",
    ],
    files: [
      {
        id: "file-contract",
        path: "src/contracts/Quote.java",
        contentHash: "a".repeat(64),
        role: "source",
        languageId: "java",
        projectIds: ["quote"],
      },
      {
        id: "file-service",
        path: "src/service/QuoteService.java",
        contentHash: "b".repeat(64),
        role: "source",
        languageId: "java",
        projectIds: ["quote"],
      },
      {
        id: "file-test",
        path: "test/service/QuoteServiceTest.java",
        contentHash: "c".repeat(64),
        role: "test",
        languageId: "java",
        projectIds: ["quote"],
      },
    ],
    entities: [
      {
        id: "entity-contract",
        kind: "type",
        name: "Quote",
        qualifiedName: "sample.Quote",
        languageId: "java",
        fileId: "file-contract",
        projectId: "quote",
        signature: "public interface Quote",
      },
      {
        id: "entity-service",
        kind: "type",
        name: "QuoteService",
        qualifiedName: "sample.QuoteService",
        languageId: "java",
        fileId: "file-service",
        projectId: "quote",
        signature: "public class QuoteService implements Quote",
      },
      {
        id: "entity-test",
        kind: "type",
        name: "QuoteServiceTest",
        qualifiedName: "sample.QuoteServiceTest",
        languageId: "java",
        fileId: "file-test",
        projectId: "quote",
        testOnly: true,
      },
    ],
    apiSurfaces: [
      {
        id: "api-contract",
        entityId: "entity-contract",
        languageId: "java",
        kind: "interface",
        name: "Quote",
        qualifiedName: "sample.Quote",
        signature: "public interface Quote",
        visibility: "public",
        exposure: "public",
        completeness: "complete",
        missingFeatures: [],
        evidenceRefs: [{
          id: "entity-contract",
          kind: "syntactic-analysis",
          path: "src/contracts/Quote.java",
        }],
      },
      {
        id: "api-service",
        entityId: "entity-service",
        languageId: "java",
        kind: "class",
        name: "QuoteService",
        qualifiedName: "sample.QuoteService",
        signature: "public class QuoteService implements Quote",
        visibility: "public",
        exposure: "public",
        completeness: "complete",
        missingFeatures: [],
        evidenceRefs: [{
          id: "entity-service",
          kind: "syntactic-analysis",
          path: "src/service/QuoteService.java",
        }],
      },
    ],
    dependencies: [{
      id: "edge-service-contract",
      sourceEntityId: "entity-service",
      targetEntityId: "entity-contract",
      sourceFileId: "file-service",
      targetFileId: "file-contract",
      kind: "implementation",
      internal: true,
      resolution: "resolved",
      evidenceLevel: "semantic",
      evidenceRefs: [{
        id: "edge-service-contract",
        kind: "semantic-analysis",
        summary: "QuoteService implements Quote.",
      }],
    }],
    coverage: {
      discoveredFileCount: 3,
      analysedFileCount: 3,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ["java"],
      missingCapabilities: [],
      segments: [{
        id: "segment-java",
        shardId: "shard-java",
        languageId: "java",
        discoveredFileCount: 3,
        analysedFileCount: 3,
        failedFileCount: 0,
        skippedFileCount: 0,
        capabilities: ["file-inventory", "symbol-index", "api-surface"],
        missingCapabilities: [],
        diagnosticIds: [],
      }],
    },
    diagnostics: [],
    contentHash: "ir-hash",
    producer: { kind: "analysis-adapter", id: "java-analyzer", version: "1.0" },
    createdAt: now,
  };
}

function draft(): ModuleDiscoveryDraft {
  return {
    modules: [
      {
        id: "quote-contract",
        name: "Quote Contract",
        kind: "shared-kernel",
        description: "Public quote contract.",
        responsibilities: ["Define the public quote interface."],
        businessCapabilities: ["Quote contract"],
        fileIds: ["file-contract"],
        entityIds: ["entity-contract"],
        entryPointEntityIds: [],
        publicApiEntityIds: ["entity-contract"],
        boundaryRationale: "The public interface is depended on by the service.",
        evidenceRefs: [{ id: "entity-contract", kind: "semantic-analysis" }],
      },
      {
        id: "quote-service",
        name: "Quote Service",
        kind: "business-capability",
        description: "Quote application behavior and tests.",
        responsibilities: ["Provide quote behavior."],
        businessCapabilities: ["Quote calculation"],
        fileIds: ["file-service", "file-test"],
        entityIds: ["entity-service", "entity-test"],
        entryPointEntityIds: ["entity-service"],
        publicApiEntityIds: ["entity-service"],
        boundaryRationale: "Implementation and its test form one cohesive capability.",
        evidenceRefs: [
          { id: "entity-service", kind: "semantic-analysis" },
          { id: "edge-service-contract", kind: "semantic-analysis" },
        ],
      },
    ],
    assignments: [
      {
        fileId: "file-contract",
        moduleIds: ["quote-contract"],
        kind: "owned",
        rationale: "The contract module owns its interface.",
        evidenceRefs: [{ id: "file-contract", kind: "source" }],
      },
      {
        fileId: "file-service",
        moduleIds: ["quote-service"],
        kind: "owned",
        rationale: "The service module owns its implementation.",
        evidenceRefs: [{ id: "file-service", kind: "source" }],
      },
      {
        fileId: "file-test",
        moduleIds: ["quote-service"],
        kind: "test",
        rationale: "This test exercises QuoteService.",
        evidenceRefs: [{ id: "file-test", kind: "test" }],
      },
    ],
    dependencies: [{
      sourceModuleId: "quote-service",
      targetModuleId: "quote-contract",
      kind: "implementation",
      evidenceRefs: [{ id: "edge-service-contract", kind: "semantic-analysis" }],
    }],
    assumptions: [],
    risks: ["Static structure alone does not prove runtime quote semantics."],
    unresolvedQuestions: [],
  };
}

describe("ModuleDiscoveryAgent", () => {
  it("adds host-owned identity, status, producer, timestamp, and hash", async () => {
    const complete = vi.fn(async (_messages: readonly ModuleDiscoveryMessage[]) => (
      JSON.stringify(draft())
    ));
    const agent = new ModuleDiscoveryAgent({
      client: { complete },
      producerId: "discovery-test",
      producerVersion: "test/1",
      now: () => now,
    });

    const result = await agent.discoverModules({
      ir: ir(),
      constraints: [{ id: "contract", description: "Keep public contracts separate.", required: true }],
    });

    expect(result).toMatchObject({
      schemaVersion: "1.1",
      id: expect.stringMatching(/^module-proposal-[0-9a-f]{24}$/),
      repositoryId: "repository-quote",
      sourceIrId: "ir-quote",
      sourceIrHash: "ir-hash",
      status: "awaiting-review",
      producer: {
        kind: "module-discovery-agent",
        id: "discovery-test",
        version: "test/1",
      },
      createdAt: now,
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const messages = complete.mock.calls[0]?.[0] as readonly ModuleDiscoveryMessage[];
    expect(messages[0]?.content).toContain("read-only");
    expect(messages[1]?.content).toContain("[UNIFIED_REPOSITORY_IR]");
    expect(messages[1]?.content).toContain("[HOST_DERIVED_API_SURFACES]");
    expect(messages[1]?.content).toContain("[DISCOVERY_CONSTRAINTS]");
    expect(messages[0]?.content).toContain("private, internal, package, not-exported, or unknown");
  });

  it("materializes the same reviewed payload deterministically", () => {
    const request = { ir: ir(), constraints: [] };
    const first = materializeModuleDiscoveryProposal(draft(), request, {
      producerId: "test",
      producerVersion: "1",
      createdAt: now,
    });
    const second = materializeModuleDiscoveryProposal(draft(), request, {
      producerId: "test",
      producerVersion: "1",
      createdAt: now,
    });
    expect(first).toEqual(second);
  });

  it("rejects tampering with host-owned proposal status and hashes", () => {
    const request = { ir: ir(), constraints: [] };
    const valid = materializeModuleDiscoveryProposal(draft(), request, {
      producerId: "test",
      producerVersion: "1",
      createdAt: now,
    });
    expect(() => validateModuleDiscoveryProposal(valid, request)).not.toThrow();

    const approved = { ...valid, status: "accepted" as const };
    expect(() => validateModuleDiscoveryProposal(approved, request)).toThrow(
      "status must be awaiting-review",
    );

    const rehashed = { ...valid, contentHash: "0".repeat(64) };
    expect(() => validateModuleDiscoveryProposal(rehashed, request)).toThrow(
      "contentHash does not match",
    );
  });

  it("repairs invalid model output no more than twice", async () => {
    const invalid = { ...draft(), status: "accepted" };
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(invalid))
      .mockResolvedValueOnce(JSON.stringify(draft()));
    const agent = new ModuleDiscoveryAgent({ client: { complete }, now: () => now });

    await expect(agent.discoverModules({ ir: ir() })).resolves.toMatchObject({
      status: "awaiting-review",
    });
    expect(complete).toHaveBeenCalledTimes(2);
    const repairMessages = complete.mock.calls[1]?.[0] as readonly ModuleDiscoveryMessage[];
    expect(repairMessages[2]?.content).toContain("unsupported field status");
  });

  it("strictly rejects fabricated file, entity, evidence, and dependency IDs", () => {
    const fabricatedFile = draft();
    fabricatedFile.modules[0]!.fileIds[0] = "invented-file";
    expect(() => validateModuleDiscoveryDraft(fabricatedFile, ir())).toThrow("invented file ID");

    const fabricatedEntity = draft();
    fabricatedEntity.modules[0]!.entityIds[0] = "invented-entity";
    expect(() => validateModuleDiscoveryDraft(fabricatedEntity, ir())).toThrow("invented entity ID");

    const fabricatedEvidence = draft();
    fabricatedEvidence.modules[0]!.evidenceRefs[0]!.id = "invented-evidence";
    expect(() => validateModuleDiscoveryDraft(fabricatedEvidence, ir())).toThrow(
      "invented or absent",
    );

    const reversedDependency = draft();
    reversedDependency.dependencies[0] = {
      sourceModuleId: "quote-contract",
      targetModuleId: "quote-service",
      kind: "invented-direction",
      evidenceRefs: [{ id: "edge-service-contract", kind: "semantic-analysis" }],
    };
    expect(() => validateModuleDiscoveryDraft(reversedDependency, ir())).toThrow(
      "no supplied IR edge supporting",
    );
  });

  it("rejects repository IDs hidden in unsupported evidence fields", () => {
    const value = draft() as ModuleDiscoveryDraft & { snapshotId?: string };
    value.snapshotId = "invented-snapshot";
    expect(() => parseModuleDiscoveryDraft(JSON.stringify(value), { ir: ir() })).toThrow(
      "unsupported field snapshotId",
    );
  });

  it("does not call the model when source code has no host-derived API surface", async () => {
    const withoutSurfaces = ir();
    withoutSurfaces.apiSurfaces = [];
    const complete = vi.fn();
    const agent = new ModuleDiscoveryAgent({ client: { complete }, now: () => now });

    await expect(agent.discoverModules({ ir: withoutSurfaces })).rejects.toThrow(
      "has no host-derived API surface",
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it.each(["private", "internal", "package", "not-exported", "unknown"] as const)(
    "rejects a model claim that a %s host surface is public",
    (exposure) => {
      const sourceIr = ir();
      sourceIr.apiSurfaces[0]!.exposure = exposure;
      expect(() => validateModuleDiscoveryDraft(draft(), sourceIr)).toThrow(
        `host-derived exposure is ${exposure}`,
      );
    },
  );

  it("rejects invented API-surface bindings and evidence before model output is accepted", () => {
    const inventedBinding = ir();
    inventedBinding.apiSurfaces[0]!.entityId = "invented-entity";
    expect(() => buildModuleDiscoveryMessages({ ir: inventedBinding })).toThrow(
      "entityId is invented or absent",
    );

    const inventedEvidence = ir();
    inventedEvidence.apiSurfaces[0]!.evidenceRefs[0]!.id = "invented-evidence";
    expect(() => buildModuleDiscoveryMessages({ ir: inventedEvidence })).toThrow(
      "invented or absent",
    );

    const missingSurface = ir();
    missingSurface.apiSurfaces = missingSurface.apiSurfaces.slice(1);
    expect(() => validateModuleDiscoveryDraft(draft(), missingSurface)).toThrow(
      "without a supplied API surface",
    );
  });

  it("rejects duplicate API-surface IDs, entity bindings, and evidence references", () => {
    const duplicateId = ir();
    duplicateId.apiSurfaces[1]!.id = duplicateId.apiSurfaces[0]!.id;
    expect(() => buildModuleDiscoveryMessages({ ir: duplicateId })).toThrow("id duplicates");

    const duplicateEntity = ir();
    duplicateEntity.apiSurfaces[1]!.entityId = duplicateEntity.apiSurfaces[0]!.entityId;
    duplicateEntity.apiSurfaces[1]!.languageId = "java";
    expect(() => buildModuleDiscoveryMessages({ ir: duplicateEntity })).toThrow(
      "entityId duplicates",
    );

    const duplicateEvidence = ir();
    duplicateEvidence.apiSurfaces[0]!.evidenceRefs.push({
      ...duplicateEvidence.apiSurfaces[0]!.evidenceRefs[0]!,
    });
    expect(() => buildModuleDiscoveryMessages({ ir: duplicateEvidence })).toThrow(
      "duplicate evidence ID",
    );
  });

  it("preserves an open-ended custom LanguageId in validated host API facts", () => {
    const sourceIr = ir();
    for (const file of sourceIr.files) file.languageId = "acme.rpg-v2";
    for (const entity of sourceIr.entities) entity.languageId = "acme.rpg-v2";
    for (const surface of sourceIr.apiSurfaces) surface.languageId = "acme.rpg-v2";
    sourceIr.coverage.languageIds = ["acme.rpg-v2"];
    sourceIr.coverage.segments[0]!.languageId = "acme.rpg-v2";

    const messages = buildModuleDiscoveryMessages({ ir: sourceIr });

    expect(messages[1]?.content).toContain('"languageId": "acme.rpg-v2"');
    expect(messages[1]?.content).toContain('"languageIds": [');
  });

  it("preserves multiple APIs and overloads as distinct host-derived surfaces", () => {
    const sourceIr = ir();
    sourceIr.entities.push(
      {
        id: "entity-price-one",
        kind: "callable",
        name: "price",
        qualifiedName: "sample.QuoteService.price",
        languageId: "java",
        fileId: "file-service",
        signature: "public Money price(Item item)",
      },
      {
        id: "entity-price-many",
        kind: "callable",
        name: "price",
        qualifiedName: "sample.QuoteService.price",
        languageId: "java",
        fileId: "file-service",
        signature: "public Money price(List<Item> items)",
      },
    );
    sourceIr.apiSurfaces.push(
      {
        id: "api-price-one",
        entityId: "entity-price-one",
        languageId: "java",
        kind: "method",
        name: "price",
        qualifiedName: "sample.QuoteService.price",
        signature: "public Money price(Item item)",
        visibility: "public",
        exposure: "public",
        parameters: [{ name: "item", position: 0, type: "Item", required: true }],
        returnShape: { type: "Money", nullable: false },
        completeness: "complete",
        missingFeatures: [],
        evidenceRefs: [{ id: "entity-price-one", kind: "syntactic-analysis" }],
      },
      {
        id: "api-price-many",
        entityId: "entity-price-many",
        languageId: "java",
        kind: "method",
        name: "price",
        qualifiedName: "sample.QuoteService.price",
        signature: "public Money price(List<Item> items)",
        visibility: "public",
        exposure: "public",
        parameters: [{ name: "items", position: 0, type: "List<Item>", required: true }],
        returnShape: { type: "Money", nullable: false },
        completeness: "complete",
        missingFeatures: [],
        evidenceRefs: [{ id: "entity-price-many", kind: "syntactic-analysis" }],
      },
    );
    const candidate = draft();
    candidate.modules[1]!.entityIds.push("entity-price-one", "entity-price-many");
    candidate.modules[1]!.publicApiEntityIds.push("entity-price-one", "entity-price-many");

    expect(() => validateModuleDiscoveryDraft(candidate, sourceIr)).not.toThrow();
    const prompt = buildModuleDiscoveryMessages({ ir: sourceIr })[1]!.content;
    expect(prompt).toContain("api-price-one");
    expect(prompt).toContain("api-price-many");
    expect(prompt).toContain("price(Item item)");
    expect(prompt).toContain("price(List<Item> items)");
  });
});

describe("repositoryStaticAnalysisToUnifiedIr", () => {
  it("maps a verified legacy snapshot without changing its repository hash", () => {
    const evidence: Omit<RepositoryStaticAnalysis, "snapshotId" | "contentHash" | "createdAt"> = {
      schemaVersion: "1.0",
      analyzerVersion: "code-indexer/test",
      repository: { remote: "https://example.invalid/quote.git", revision: "abc123" },
      files: [{
        path: "src/Quote.cs",
        sha256: "d".repeat(64),
        role: "source",
        language: "C#",
        project: "Quote",
      }],
      symbols: [{
        id: "symbol-quote",
        name: "Quote",
        qualifiedName: "Sample.Quote",
        kind: "class",
        language: "C#",
        path: "src/Quote.cs",
        project: "Quote",
      }],
      dependencies: [],
      diagnostics: [],
    };
    const analysis: RepositoryStaticAnalysis = {
      ...evidence,
      snapshotId: repositoryAnalysisSnapshotId(evidence),
      contentHash: repositoryAnalysisContentHash(evidence),
      createdAt: now,
    };

    const result = repositoryStaticAnalysisToUnifiedIr(analysis);

    expect(result.repositoryContentHash).toBe(analysis.contentHash);
    expect(result.files).toEqual([
      expect.objectContaining({ path: "src/Quote.cs", languageId: "csharp" }),
    ]);
    expect(result.entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "symbol-quote", kind: "type" }),
    ]));
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a tampered legacy snapshot before bridging", () => {
    const tampered: RepositoryStaticAnalysis = {
      schemaVersion: "1.0",
      snapshotId: "snapshot-tampered",
      contentHash: "0".repeat(64),
      analyzerVersion: "test",
      createdAt: now,
      repository: {},
      files: [],
      symbols: [],
      dependencies: [],
      diagnostics: [],
    };
    expect(() => repositoryStaticAnalysisToUnifiedIr(tampered)).toThrow(/content hash/i);
  });
});
