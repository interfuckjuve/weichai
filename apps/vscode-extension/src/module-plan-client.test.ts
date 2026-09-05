import { describe, expect, it } from 'vitest';
import {
  moduleMigrationSchemaVersion,
  type ModuleMigrationProposal,
  type RepositoryStaticAnalysis,
} from '@forexplore/contracts';
import {
  buildLegacyModuleMigrationProposalFromSemantic,
  buildTrustedModuleMigrationPlan,
  modulePlanEndpoint,
  requestSemanticModuleMigrationProposal,
  requestModuleMigrationProposal,
  semanticModulePlanEndpoint,
} from './module-plan-client';
import type { localFetch } from './local-fetch';

const analysis: RepositoryStaticAnalysis = {
  schemaVersion: moduleMigrationSchemaVersion,
  snapshotId: 'snapshot-example',
  contentHash: 'analysis-hash',
  analyzerVersion: 'test',
  createdAt: '2026-08-26T00:00:00.000Z',
  repository: { revision: 'deadbeef' },
  files: [{
    path: 'src/Service.java',
    sha256: 'file-hash',
    role: 'source',
    language: 'Java',
  }],
  symbols: [{
    id: 'symbol:service',
    name: 'Service',
    qualifiedName: 'example.Service',
    kind: 'class',
    language: 'Java',
    path: 'src/Service.java',
  }],
  dependencies: [],
  diagnostics: [],
};

const proposal: ModuleMigrationProposal = {
  schemaVersion: moduleMigrationSchemaVersion,
  snapshotId: analysis.snapshotId,
  objective: 'Migrate the service module',
  modules: [{
    id: 'service',
    name: 'Service',
    kind: 'feature',
    description: 'The service feature.',
    sourceFiles: ['src/Service.java'],
    symbolIds: ['symbol:service'],
    dependsOn: [],
    writeSet: ['src/Service.java'],
    resourceLocks: [],
    evidenceIds: ['symbol:service'],
  }],
  fileAssignments: [{
    path: 'src/Service.java',
    kind: 'module',
    moduleId: 'service',
  }],
  dependencies: [],
};

describe('module-plan client', () => {
  it('normalizes the read-only planning endpoint and strips configured query data', () => {
    expect(modulePlanEndpoint('http://127.0.0.1:8788/api/?token=not-forwarded#fragment'))
      .toBe('http://127.0.0.1:8788/api/v1/module-plan');
  });

  it('sends only the snapshot identity and planning fields to the service', async () => {
    const calls: Array<Parameters<typeof localFetch>> = [];
    const fetcher = async (...args: Parameters<typeof localFetch>): Promise<Response> => {
      calls.push(args);
      return new Response(JSON.stringify(proposal), { status: 200 });
    };
    const received = await requestModuleMigrationProposal(
      'http://127.0.0.1:8788',
      {
        snapshotId: analysis.snapshotId,
        objective: proposal.objective,
        immutableConstraints: ['Keep the public contract.'],
      },
      fetcher,
    );

    expect(received).toEqual(proposal);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe('http://127.0.0.1:8788/v1/module-plan');
    expect(JSON.parse(String(init?.body))).toEqual({
      snapshotId: analysis.snapshotId,
      objective: proposal.objective,
      immutableConstraints: ['Keep the public contract.'],
    });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('analysis');
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('source');
  });

  it('sends a revision-scoped semantic planning request without a legacy snapshot', async () => {
    const semanticResult = {
      proposal: {
        repositoryId: 'repo-1',
        analysisRevision: 'revision-1',
        analysisHash: 'structural-hash',
        objective: proposal.objective,
        modules: [],
      },
      evidence: {
        repositoryId: 'repo-1',
        analysisRevision: 'revision-1',
        analysisHash: 'structural-hash',
        planHash: 'sha256:plan',
        evidenceIds: [],
      },
    };
    const calls: Array<Parameters<typeof localFetch>> = [];
    const fetcher = async (...args: Parameters<typeof localFetch>): Promise<Response> => {
      calls.push(args);
      return new Response(JSON.stringify(semanticResult), { status: 200 });
    };

    await requestSemanticModuleMigrationProposal(
      'http://127.0.0.1:8788/api/?token=not-forwarded#fragment',
      {
        repositoryId: 'repo-1',
        analysisRevision: 'revision-1',
        projectId: 'project-1',
        objective: proposal.objective,
      },
      fetcher,
    );

    expect(calls[0]?.[0]).toBe('http://127.0.0.1:8788/api/v1/semantic-module-plan');
    const body = JSON.parse(String(calls[0]?.[1]?.body));
    expect(body).toEqual({
      repositoryId: 'repo-1',
      analysisRevision: 'revision-1',
      projectId: 'project-1',
      objective: proposal.objective,
    });
    expect(body).not.toHaveProperty('snapshotId');
    expect(semanticModulePlanEndpoint('http://127.0.0.1:8788')).toBe(
      'http://127.0.0.1:8788/v1/semantic-module-plan',
    );
  });

  it('maps a revision-scoped proposal to the legacy scheduler without inventing files', () => {
    const legacy = buildLegacyModuleMigrationProposalFromSemantic(analysis, {
      repositoryId: 'repo-1',
      analysisRevision: 'revision-1',
      analysisHash: 'structural-hash',
      objective: proposal.objective,
      modules: [{
        id: 'service',
        name: 'Service',
        kind: 'feature',
        description: 'The service feature.',
        sourceFiles: ['src/Service.java'],
        symbolKeys: ['example.Service'],
        dependsOn: [],
        writeSet: ['src/Service.java', 'src/Unknown.java'],
        resourceLocks: [],
        evidenceIds: ['evidence:service'],
      }],
    });

    expect(legacy).toMatchObject({
      snapshotId: analysis.snapshotId,
      objective: proposal.objective,
      fileAssignments: [{ path: 'src/Service.java', kind: 'module', moduleId: 'service' }],
      modules: [{
        id: 'service',
        sourceFiles: ['src/Service.java'],
        writeSet: ['src/Service.java'],
        symbolIds: ['symbol:service'],
      }],
    });
  });

  it('keeps server rejection evidence rather than treating it as a proposal', async () => {
    const fetcher = async (): Promise<Response> => new Response(JSON.stringify({ error: 'snapshot not found' }), {
      status: 404,
    });
    await expect(requestModuleMigrationProposal(
      'http://127.0.0.1:8788',
      { snapshotId: analysis.snapshotId, objective: proposal.objective },
      fetcher as typeof localFetch,
    )).rejects.toThrow('snapshot not found');
  });

  it('derives schedule state locally after the untrusted proposal is returned', () => {
    const plan = buildTrustedModuleMigrationPlan(
      analysis,
      proposal,
      '2026-08-26T00:00:00.000Z',
    );

    expect(plan.status).toBe('validated');
    expect(plan.executionWaves).toHaveLength(1);
    expect(plan.executionWaves[0]).toMatchObject({
      moduleIds: ['service'],
      requiresApproval: true,
      maxParallelism: 4,
    });
  });
});
