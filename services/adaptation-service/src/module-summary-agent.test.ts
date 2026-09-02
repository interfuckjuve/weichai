import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type {
  RepositoryModuleBundle,
  RepositoryModuleEvidenceBundle,
} from '@forexplore/contracts';
import {
  canonicalJson,
  materializeRepositoryModuleEvidenceBundle,
  materializeRepositoryModuleKnowledgeReview,
} from '@forexplore/workflow-core';
import type { CodeAdaptationPort } from '@forexplore/workflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from './http-server';
import {
  ModuleSummaryAgent,
  buildModuleSummaryMessages,
  parseModuleSummaryDraft,
  type ModuleSummaryMessage,
} from './module-summary-agent';

const now = '2026-09-01T00:00:01.000Z';
const source = 'public class OrderService { public void create() {} }\n';
const servers: ReturnType<typeof createHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function repositoryBundle(): RepositoryModuleBundle {
  const payload: Omit<RepositoryModuleBundle, 'id' | 'contentHash'> = {
    schemaVersion: '1.1',
    repositoryId: 'repository-orders',
    repositoryRevision: 'abc123',
    repositoryContentHash: 'b'.repeat(64),
    source: {
      unifiedRepositoryIrId: 'ir-orders',
      unifiedRepositoryIrHash: 'c'.repeat(64),
      moduleProposalId: 'proposal-orders',
      moduleProposalHash: 'd'.repeat(64),
      moduleReviewId: 'review-orders',
      moduleReviewHash: 'e'.repeat(64),
      moduleCatalogId: 'catalog-orders',
      moduleCatalogHash: 'f'.repeat(64),
    },
    capabilities: ['file-inventory', 'symbol-index', 'api-surface'],
    coverage: {
      discoveredFileCount: 1,
      analysedFileCount: 1,
      failedFileCount: 0,
      skippedFileCount: 0,
      languageIds: ['java'],
      missingCapabilities: [],
      segments: [],
    },
    diagnostics: [],
    modules: [{
      id: 'orders',
      name: 'Orders',
      kind: 'business-capability',
      description: 'Creates orders.',
      responsibilities: ['Create orders.'],
      businessCapabilities: ['Order management'],
      fileIds: ['file-orders'],
      entityIds: ['entity-orders'],
      entryPointEntityIds: ['entity-orders'],
      publicApiEntityIds: ['entity-orders'],
      boundaryRationale: 'The service owns order creation.',
      evidenceRefs: [{ id: 'entity-orders', kind: 'semantic-analysis' }],
    }],
    assignments: [{
      fileId: 'file-orders',
      moduleIds: ['orders'],
      kind: 'owned',
      rationale: 'Owned by Orders.',
      evidenceRefs: [{ id: 'file-orders', kind: 'source' }],
    }],
    moduleDependencies: [],
    files: [{
      id: 'file-orders',
      path: 'src/OrderService.java',
      contentHash: hash(source),
      role: 'source',
      languageId: 'java',
      projectIds: ['app'],
    }],
    entities: [{
      id: 'entity-orders',
      kind: 'type',
      name: 'OrderService',
      qualifiedName: 'sample.OrderService',
      languageId: 'java',
      fileId: 'file-orders',
      projectId: 'app',
      signature: 'public class OrderService',
    }],
    irDependencies: [],
    apiSurfaces: [{
      id: 'api-orders',
      entityId: 'entity-orders',
      languageId: 'java',
      kind: 'class',
      name: 'OrderService',
      qualifiedName: 'sample.OrderService',
      signature: 'public class OrderService',
      visibility: 'public',
      exposure: 'public',
      completeness: 'complete',
      missingFeatures: [],
      evidenceRefs: [{ id: 'entity-orders', kind: 'semantic-analysis' }],
    }],
    knowledgePages: [],
    producer: { kind: 'ingestion-host', id: 'test' },
    createdAt: '2026-09-01T00:00:00.000Z',
  };
  const contentHash = hash(canonicalJson(payload));
  return {
    ...payload,
    id: `repository-module-bundle:${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

function evidenceBundle(bundle = repositoryBundle()): RepositoryModuleEvidenceBundle {
  return materializeRepositoryModuleEvidenceBundle({
    repositoryModuleBundle: bundle,
    moduleId: 'orders',
    items: [{
      id: 'evidence-source-orders',
      kind: 'source-slice',
      evidenceKind: 'source',
      evidenceRefIds: ['entity-orders', 'file-orders'],
      sourceArtifactId: bundle.id,
      path: 'src/OrderService.java',
      range: { path: 'src/OrderService.java', startLine: 1, endLine: 1 },
      mediaType: 'text/plain; charset=utf-8',
      content: source,
      byteLength: Buffer.byteLength(source, 'utf8'),
      contentHash: hash(source),
      truncated: false,
    }],
    producer: { kind: 'ingestion-host', id: 'test-evidence-assembler' },
    createdAt: now,
  });
}

function validDraft(): unknown {
  return {
    narrative: {
      summary: 'The module exposes order creation behavior.',
      architecture: 'OrderService is the visible service type.',
      publicInterfaces: 'public class OrderService',
      dataFlow: '',
      operationalNotes: '',
      reuseGuidance: '',
      limitations: ['Runtime behavior is not established by this source slice.'],
      risks: [],
      evidenceIds: ['entity-orders'],
      tags: ['orders'],
    },
    evidenceBindings: [
      {
        section: 'summary',
        claim: 'The module exposes order creation behavior.',
        evidenceIds: ['entity-orders'],
      },
      {
        section: 'architecture',
        claim: 'OrderService is the visible service type.',
        evidenceIds: ['entity-orders'],
      },
      {
        section: 'publicInterfaces',
        claim: 'public class OrderService',
        evidenceIds: ['entity-orders'],
      },
      {
        section: 'limitations',
        claim: 'Runtime behavior is not established by this source slice.',
        evidenceIds: ['entity-orders'],
      },
    ],
  };
}

describe('ModuleSummaryAgent', () => {
  it('materializes a content-addressed, generated-only Wiki proposal', async () => {
    const complete = vi.fn(async (_messages: readonly ModuleSummaryMessage[]) => JSON.stringify(validDraft()));
    const bundle = repositoryBundle();
    const evidence = evidenceBundle(bundle);
    const agent = new ModuleSummaryAgent({
      client: { complete },
      modelConfig: { apiBase: 'https://example.invalid', model: 'summary-test-model' },
      producerId: 'summary-test',
      producerVersion: 'test/1',
      now: () => '2026-09-01T00:00:02.000Z',
    });

    const proposal = await agent.summarizeModule({
      repositoryModuleBundle: bundle,
      evidenceBundle: evidence,
    });

    expect(proposal).toMatchObject({
      repositoryId: 'repository-orders',
      moduleId: 'orders',
      evidenceBundleId: evidence.id,
      generation: {
        modelId: 'summary-test-model',
        promptTemplateId: 'forexplore/repository-module-summary',
        promptTemplateVersion: '1.1.0',
      },
      producer: { kind: 'module-summary-agent', id: 'summary-test' },
    });
    expect(proposal.id).toContain(proposal.contentHash.slice(0, 24));
  });

  it('binds a successor to the prior proposal and signed actionable revise review', async () => {
    const bundle = repositoryBundle();
    const evidence = evidenceBundle(bundle);
    const firstAgent = new ModuleSummaryAgent({
      client: { complete: vi.fn(async () => JSON.stringify(validDraft())) },
      modelConfig: { apiBase: 'https://example.invalid', model: 'summary-test-model' },
      now: () => '2026-09-01T00:00:02.000Z',
    });
    const previousProposal = await firstAgent.summarizeModule({
      repositoryModuleBundle: bundle,
      evidenceBundle: evidence,
    });
    const reviseReview = materializeRepositoryModuleKnowledgeReview(previousProposal, evidence, {
      decision: 'revise',
      reviewerId: 'knowledge-owner',
      comment: 'State explicitly that runtime ordering has not been verified.',
      reviewedAt: '2026-09-01T00:00:03.000Z',
    });
    const complete = vi.fn(async (_messages: readonly ModuleSummaryMessage[]) => JSON.stringify(validDraft()));
    const successorAgent = new ModuleSummaryAgent({
      client: { complete },
      modelConfig: { apiBase: 'https://example.invalid', model: 'summary-test-model' },
      now: () => '2026-09-01T00:00:04.000Z',
    });

    const successor = await successorAgent.summarizeModule({
      repositoryModuleBundle: bundle,
      evidenceBundle: evidence,
      previousProposal,
      reviseReview,
    });

    expect(successor.revision).toEqual({
      previousProposalId: previousProposal.id,
      previousProposalHash: previousProposal.contentHash,
      reviseReviewId: reviseReview.id,
      reviseReviewHash: reviseReview.contentHash,
    });
    const messages = complete.mock.calls[0]?.[0];
    expect(messages[1]?.content).toContain('[REVISION_CONTEXT]');
    expect(messages[1]?.content).toContain(reviseReview.comment);
  });

  it('repairs an evidence citation outside the immutable bundle', async () => {
    const invalid = validDraft() as ReturnType<typeof validDraft> & { narrative: { evidenceIds: string[] }; evidenceBindings: Array<{ evidenceIds: string[] }> };
    invalid.narrative.evidenceIds = ['invented'];
    invalid.evidenceBindings.forEach((binding) => { binding.evidenceIds = ['invented']; });
    const complete = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(invalid))
      .mockResolvedValueOnce(JSON.stringify(validDraft()));
    const bundle = repositoryBundle();
    const agent = new ModuleSummaryAgent({
      client: { complete },
      modelConfig: { apiBase: 'https://example.invalid', model: 'summary-test-model' },
      now: () => '2026-09-01T00:00:02.000Z',
    });

    await expect(agent.summarizeModule({
      repositoryModuleBundle: bundle,
      evidenceBundle: evidenceBundle(bundle),
    })).resolves.toMatchObject({ moduleId: 'orders' });
    expect(complete).toHaveBeenCalledTimes(2);
    const repairMessages = complete.mock.calls[1]?.[0] as readonly ModuleSummaryMessage[];
    expect(repairMessages.at(-1)?.content).toContain('outside its bundle');
  });

  it('keeps repository content in an explicitly untrusted evidence section', () => {
    const messages = buildModuleSummaryMessages(evidenceBundle());
    expect(messages[0]?.content).toContain('untrusted data');
    expect(messages[1]?.content).toContain('[EVIDENCE_BUNDLE]');
    expect(messages[1]?.content).toContain('OrderService');
  });

  it('rejects host-owned fields in model output', () => {
    expect(() => parseModuleSummaryDraft(JSON.stringify({
      ...validDraft() as object,
      publicationStatus: 'active',
    }))).toThrow('unsupported field publicationStatus');
  });
});

describe('POST /v1/module-summary', () => {
  it('validates the immutable closure before invoking the read-only Summary port', async () => {
    const repositoryModuleBundle = repositoryBundle();
    const evidence = evidenceBundle(repositoryModuleBundle);
    const proposalAgent = new ModuleSummaryAgent({
      client: { complete: vi.fn(async () => JSON.stringify(validDraft())) },
      modelConfig: { apiBase: 'https://example.invalid', model: 'summary-test-model' },
      now: () => '2026-09-01T00:00:02.000Z',
    });
    const proposal = await proposalAgent.summarizeModule({
      repositoryModuleBundle,
      evidenceBundle: evidence,
    });
    const summarizeModule = vi.fn(async () => proposal);
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const server = createHttpServer({ adapter, moduleSummaryPort: { summarizeModule } });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/module-summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryModuleBundle, evidenceBundle: evidence }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(proposal);
    expect(summarizeModule).toHaveBeenCalledWith(
      { repositoryModuleBundle, evidenceBundle: evidence },
      expect.any(AbortSignal),
    );
  });

  it('rejects extra host-owned control fields before calling the Summary port', async () => {
    const adapter: CodeAdaptationPort = { adapt: vi.fn() };
    const summarizeModule = vi.fn();
    const server = createHttpServer({ adapter, moduleSummaryPort: { summarizeModule } });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/module-summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryModuleBundle: repositoryBundle(),
        evidenceBundle: evidenceBundle(),
        publicationStatus: 'active',
      }),
    });

    expect(response.status).toBe(400);
    expect(summarizeModule).not.toHaveBeenCalled();
  });

  it('rejects an invalid proposal returned by an injected Summary port', async () => {
    const repositoryModuleBundle = repositoryBundle();
    const evidence = evidenceBundle(repositoryModuleBundle);
    const proposalAgent = new ModuleSummaryAgent({
      client: { complete: vi.fn(async () => JSON.stringify(validDraft())) },
      modelConfig: { apiBase: 'https://example.invalid', model: 'summary-test-model' },
      now: () => '2026-09-01T00:00:02.000Z',
    });
    const proposal = await proposalAgent.summarizeModule({
      repositoryModuleBundle,
      evidenceBundle: evidence,
    });
    const server = createHttpServer({
      adapter: { adapt: vi.fn() },
      moduleSummaryPort: {
        summarizeModule: vi.fn(async () => ({
          ...proposal,
          contentHash: '0'.repeat(64),
        })),
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/module-summary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryModuleBundle, evidenceBundle: evidence }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('does not match'),
    });
  });

  it('uses the dedicated 32 MiB Summary request cap instead of the 2 MiB interactive cap', async () => {
    const summarizeModule = vi.fn();
    const server = createHttpServer({
      adapter: { adapt: vi.fn() },
      moduleSummaryPort: { summarizeModule },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/v1/module-summary`;
    const withinDedicatedLimit = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryModuleBundle: { padding: 'x'.repeat(3 * 1024 * 1024) },
        evidenceBundle: {},
      }),
    });
    expect(withinDedicatedLimit.status).toBe(400);

    const aboveDedicatedLimit = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repositoryModuleBundle: { padding: 'x'.repeat(33 * 1024 * 1024) },
        evidenceBundle: {},
      }),
    });
    expect(aboveDedicatedLimit.status).toBe(413);
    expect(summarizeModule).not.toHaveBeenCalled();
  });
});
