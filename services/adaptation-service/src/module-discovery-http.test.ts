import type { AddressInfo } from "node:net";
import type {
  ModuleDiscoveryConstraint,
  ModuleDiscoveryProposal,
  RepositoryStaticAnalysis,
  UnifiedRepositoryIR,
} from "@forexplore/contracts";
import {
  repositoryAnalysisContentHash,
  repositoryAnalysisSnapshotId,
} from "@forexplore/code-indexer";
import type { CodeAdaptationPort } from "@forexplore/workflow-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer, type StaticAnalysisSnapshotStore } from "./http-server";
import type {
  ModuleDiscoveryPort,
  RepositoryStaticAnalysisIrBridge,
} from "./module-discovery-agent";
import { materializeModuleDiscoveryProposal } from "./module-discovery-agent";

const now = "2026-08-31T12:00:00.000Z";
const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function verifiedAnalysis(): RepositoryStaticAnalysis {
  const evidence: Omit<RepositoryStaticAnalysis, "snapshotId" | "contentHash" | "createdAt"> = {
    schemaVersion: "1.0",
    analyzerVersion: "code-indexer/test",
    repository: { revision: "abc123" },
    files: [{
      path: "src/Quote.java",
      sha256: "a".repeat(64),
      role: "source",
      language: "Java",
    }],
    symbols: [{
      id: "symbol-quote",
      name: "Quote",
      qualifiedName: "sample.Quote",
      kind: "class",
      language: "Java",
      path: "src/Quote.java",
    }],
    dependencies: [],
    diagnostics: [],
  };
  return {
    ...evidence,
    snapshotId: repositoryAnalysisSnapshotId(evidence),
    contentHash: repositoryAnalysisContentHash(evidence),
    createdAt: now,
  };
}

function unifiedIr(analysis: RepositoryStaticAnalysis): UnifiedRepositoryIR {
  return {
    schemaVersion: "1.1",
    id: "ir-http",
    repositoryId: "repository-http",
    profileId: "profile-http",
    repositoryRevision: analysis.repository.revision,
    repositoryContentHash: analysis.contentHash,
    sourceShardIds: ["shard-http"],
    capabilities: ["file-inventory", "symbol-index", "api-surface"],
    files: [{
      id: "file-quote",
      path: "src/Quote.java",
      contentHash: "a".repeat(64),
      role: "source",
      languageId: "java",
      projectIds: [],
    }],
    entities: [{
      id: "symbol-quote",
      kind: "type",
      name: "Quote",
      qualifiedName: "sample.Quote",
      languageId: "java",
      fileId: "file-quote",
      signature: "public class Quote",
    }],
    apiSurfaces: [{
      id: "api-quote",
      entityId: "symbol-quote",
      languageId: "java",
      kind: "class",
      name: "Quote",
      qualifiedName: "sample.Quote",
      signature: "public class Quote",
      visibility: "public",
      exposure: "public",
      completeness: "complete",
      missingFeatures: [],
      evidenceRefs: [{ id: "symbol-quote", kind: "syntactic-analysis" }],
    }],
    dependencies: [],
    coverage: {
      discoveredFileCount: 1,
      analysedFileCount: 1,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ["java"],
      missingCapabilities: [],
      segments: [{
        id: "segment-http",
        shardId: "shard-http",
        languageId: "java",
        discoveredFileCount: 1,
        analysedFileCount: 1,
        failedFileCount: 0,
        skippedFileCount: 0,
        capabilities: ["file-inventory", "symbol-index", "api-surface"],
        missingCapabilities: [],
        diagnosticIds: [],
      }],
    },
    diagnostics: [],
    contentHash: "ir-http-hash",
    producer: { kind: "analysis-adapter", id: "test", version: "1" },
    createdAt: now,
  };
}

function proposal(
  ir: UnifiedRepositoryIR,
  constraints: ModuleDiscoveryConstraint[] = [],
): ModuleDiscoveryProposal {
  return materializeModuleDiscoveryProposal({
    modules: [{
      id: "quote",
      name: "Quote",
      kind: "business-capability",
      description: "Quote capability.",
      responsibilities: ["Represent quotes."],
      businessCapabilities: ["Quotes"],
      fileIds: ["file-quote"],
      entityIds: ["symbol-quote"],
      entryPointEntityIds: ["symbol-quote"],
      publicApiEntityIds: ["symbol-quote"],
      boundaryRationale: "The only type and file form one bounded capability.",
      evidenceRefs: [{ id: "symbol-quote", kind: "semantic-analysis" }],
    }],
    assignments: [
      {
        fileId: "file-quote",
        moduleIds: ["quote"],
        kind: "owned",
        rationale: "Quote owns its source file.",
        evidenceRefs: [{ id: "file-quote", kind: "source" }],
      },
      ...ir.files
        .filter((file) => file.id !== "file-quote")
        .map((file) => ({
          fileId: file.id,
          moduleIds: [],
          kind: "excluded" as const,
          rationale: "Non-source inventory remains outside the code module.",
          evidenceRefs: [{
            id: file.id,
            kind: file.role === "documentation" ? "documentation" as const : "other" as const,
          }],
        })),
    ],
    dependencies: [],
    assumptions: [],
    risks: [],
    unresolvedQuestions: [],
  }, { ir, constraints }, {
    producerId: "test",
    producerVersion: "1",
    createdAt: now,
  });
}

async function listen(options: {
  moduleDiscoveryPort?: ModuleDiscoveryPort;
  staticAnalysisSnapshots?: StaticAnalysisSnapshotStore;
  repositoryIrBridge?: RepositoryStaticAnalysisIrBridge;
}): Promise<string> {
  const adapter: CodeAdaptationPort = { adapt: vi.fn() };
  const server = createHttpServer({ adapter, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("POST /v1/module-discovery", () => {
  it("loads a server-owned snapshot, bridges it to IR, and performs read-only discovery", async () => {
    const analysis = verifiedAnalysis();
    const ir = unifiedIr(analysis);
    const constraints = [{
      id: "contract-boundary",
      description: "Keep the public contract separate.",
      required: true,
    }];
    const result = proposal(ir, constraints);
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = {
      getSnapshot: vi.fn(async () => analysis),
    };
    const repositoryIrBridge = vi.fn(async () => ir);
    const moduleDiscoveryPort: ModuleDiscoveryPort = {
      discoverModules: vi.fn(async () => result),
    };
    const url = await listen({
      moduleDiscoveryPort,
      staticAnalysisSnapshots,
      repositoryIrBridge,
    });
    const response = await fetch(`${url}/v1/module-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: analysis.snapshotId, constraints }),
    });

    expect(response.status).toBe(200);
    expect(staticAnalysisSnapshots.getSnapshot).toHaveBeenCalledWith(
      analysis.snapshotId,
      expect.any(AbortSignal),
    );
    expect(repositoryIrBridge).toHaveBeenCalledWith(analysis, expect.any(AbortSignal));
    expect(moduleDiscoveryPort.discoverModules).toHaveBeenCalledWith(
      { ir, constraints },
      expect.any(AbortSignal),
    );
    expect(await response.json()).toEqual(result);
  });

  it("rejects attempts to upload repository facts or host-owned discovery fields", async () => {
    const analysis = verifiedAnalysis();
    const staticAnalysisSnapshots: StaticAnalysisSnapshotStore = {
      getSnapshot: vi.fn(async () => analysis),
    };
    const repositoryIrBridge = vi.fn(async () => unifiedIr(analysis));
    const moduleDiscoveryPort: ModuleDiscoveryPort = { discoverModules: vi.fn() };
    const url = await listen({ moduleDiscoveryPort, staticAnalysisSnapshots, repositoryIrBridge });

    for (const body of [
      { snapshotId: analysis.snapshotId, source: "class Secret {}" },
      { snapshotId: analysis.snapshotId, path: "src/Secret.java" },
      { snapshotId: analysis.snapshotId, ir: unifiedIr(analysis) },
      { snapshotId: analysis.snapshotId, objective: "Invent business modules" },
      {
        snapshotId: analysis.snapshotId,
        constraints: [{
          id: "constraint",
          description: "Use supplied evidence.",
          required: true,
          evidenceRefs: [{ id: "invented", kind: "human-decision" }],
        }],
      },
    ]) {
      const response = await fetch(`${url}/v1/module-discovery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(staticAnalysisSnapshots.getSnapshot).not.toHaveBeenCalled();
    expect(repositoryIrBridge).not.toHaveBeenCalled();
    expect(moduleDiscoveryPort.discoverModules).not.toHaveBeenCalled();
  });

  it("does not expose discovery when its read-only port is absent", async () => {
    const analysis = verifiedAnalysis();
    const url = await listen({
      staticAnalysisSnapshots: { getSnapshot: vi.fn(async () => analysis) },
    });
    const response = await fetch(`${url}/v1/module-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: analysis.snapshotId }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Module discovery is not configured." });
  });

  it("rejects a bridge result that is not bound to the selected snapshot", async () => {
    const analysis = verifiedAnalysis();
    const ir = { ...unifiedIr(analysis), repositoryContentHash: "different" };
    const moduleDiscoveryPort: ModuleDiscoveryPort = { discoverModules: vi.fn() };
    const url = await listen({
      moduleDiscoveryPort,
      staticAnalysisSnapshots: { getSnapshot: vi.fn(async () => analysis) },
      repositoryIrBridge: vi.fn(async () => ir),
    });
    const response = await fetch(`${url}/v1/module-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: analysis.snapshotId }),
    });
    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toContain(
      "different repository snapshot",
    );
    expect(moduleDiscoveryPort.discoverModules).not.toHaveBeenCalled();
  });

  it("rejects invalid API-surface evidence at the HTTP loading boundary", async () => {
    const analysis = verifiedAnalysis();
    const ir = unifiedIr(analysis);
    ir.apiSurfaces[0]!.evidenceRefs[0]!.id = "invented-evidence";
    const moduleDiscoveryPort: ModuleDiscoveryPort = { discoverModules: vi.fn() };
    const url = await listen({
      moduleDiscoveryPort,
      staticAnalysisSnapshots: { getSnapshot: vi.fn(async () => analysis) },
      repositoryIrBridge: vi.fn(async () => ir),
    });

    const response = await fetch(`${url}/v1/module-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: analysis.snapshotId }),
    });

    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toContain("invented or absent");
    expect(moduleDiscoveryPort.discoverModules).not.toHaveBeenCalled();
  });

  it("rejects an incomplete source segment before invoking the discovery port", async () => {
    const analysis = verifiedAnalysis();
    const ir = unifiedIr(analysis);
    ir.coverage.segments[0]!.capabilities = ["file-inventory", "symbol-index"];
    ir.coverage.segments[0]!.missingCapabilities = ["api-surface"];
    ir.coverage.missingCapabilities = ["api-surface"];
    const moduleDiscoveryPort: ModuleDiscoveryPort = { discoverModules: vi.fn() };
    const url = await listen({
      moduleDiscoveryPort,
      staticAnalysisSnapshots: { getSnapshot: vi.fn(async () => analysis) },
      repositoryIrBridge: vi.fn(async () => ir),
    });

    const response = await fetch(`${url}/v1/module-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: analysis.snapshotId }),
    });

    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toContain(
      "lacks required capabilities",
    );
    expect(moduleDiscoveryPort.discoverModules).not.toHaveBeenCalled();
  });

  it("rejects a failed or partial source segment before invoking the discovery port", async () => {
    const analysis = verifiedAnalysis();
    const ir = unifiedIr(analysis);
    ir.coverage.analysedFileCount = 0;
    ir.coverage.failedFileCount = 1;
    ir.coverage.segments[0]!.analysedFileCount = 0;
    ir.coverage.segments[0]!.failedFileCount = 1;
    const moduleDiscoveryPort: ModuleDiscoveryPort = { discoverModules: vi.fn() };
    const url = await listen({
      moduleDiscoveryPort,
      staticAnalysisSnapshots: { getSnapshot: vi.fn(async () => analysis) },
      repositoryIrBridge: vi.fn(async () => ir),
    });

    const response = await fetch(`${url}/v1/module-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: analysis.snapshotId }),
    });

    expect(response.status).toBe(502);
    expect((await response.json() as { error: string }).error).toContain("failed or partial");
    expect(moduleDiscoveryPort.discoverModules).not.toHaveBeenCalled();
  });

  it("allows an inventory-only documentation or asset segment beside a complete source segment", async () => {
    const analysis = verifiedAnalysis();
    const ir = unifiedIr(analysis);
    ir.sourceShardIds.push("shard-inventory");
    ir.files.push({
      id: "file-readme",
      path: "README.md",
      contentHash: "b".repeat(64),
      role: "documentation",
      projectIds: [],
    });
    ir.coverage.discoveredFileCount = 2;
    ir.coverage.skippedFileCount = 1;
    ir.coverage.missingCapabilities = ["symbol-index", "api-surface"];
    ir.coverage.segments.push({
      id: "segment-inventory",
      shardId: "shard-inventory",
      discoveredFileCount: 1,
      analysedFileCount: 0,
      failedFileCount: 0,
      skippedFileCount: 1,
      capabilities: ["file-inventory"],
      missingCapabilities: ["symbol-index", "api-surface"],
      diagnosticIds: [],
    });
    const result = proposal(ir);
    const moduleDiscoveryPort: ModuleDiscoveryPort = {
      discoverModules: vi.fn(async () => result),
    };
    const url = await listen({
      moduleDiscoveryPort,
      staticAnalysisSnapshots: { getSnapshot: vi.fn(async () => analysis) },
      repositoryIrBridge: vi.fn(async () => ir),
    });

    const response = await fetch(`${url}/v1/module-discovery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ snapshotId: analysis.snapshotId }),
    });

    expect(response.status).toBe(200);
    expect(moduleDiscoveryPort.discoverModules).toHaveBeenCalledTimes(1);
  });
});
