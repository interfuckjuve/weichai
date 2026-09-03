import type {
  RepositoryModuleBundle,
  RepositoryModuleEvidenceBundle,
  RepositoryModuleWikiProposal,
} from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';

const validators = vi.hoisted(() => ({
  validateEvidence: vi.fn(),
  validateProposal: vi.fn(),
  validateRevision: vi.fn(),
}));

vi.mock('@forexplore/workflow-core', () => ({
  validateRepositoryModuleEvidenceBundle: validators.validateEvidence,
  validateRepositoryModuleWikiProposal: validators.validateProposal,
  validateRepositoryModuleSummaryRevisionContext: validators.validateRevision,
}));

import {
  moduleSummaryEndpoint,
  requestRepositoryModuleSummary,
} from './module-summary-client';

describe('module summary client', () => {
  it('targets the dedicated endpoint and validates request and response artifacts', async () => {
    const repositoryModuleBundle = { id: 'bundle' } as RepositoryModuleBundle;
    const evidenceBundle = { id: 'evidence' } as RepositoryModuleEvidenceBundle;
    const proposal = { id: 'proposal' } as RepositoryModuleWikiProposal;
    const fetcher = vi.fn(async () => new Response(JSON.stringify(proposal), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    await expect(requestRepositoryModuleSummary(
      'http://127.0.0.1:8788/base/',
      { repositoryModuleBundle, evidenceBundle },
      fetcher,
    )).resolves.toEqual(proposal);

    expect(moduleSummaryEndpoint('http://127.0.0.1:8788/base/')).toBe(
      'http://127.0.0.1:8788/base/v1/module-summary',
    );
    expect(validators.validateEvidence).toHaveBeenCalledWith(evidenceBundle, repositoryModuleBundle);
    expect(validators.validateProposal).toHaveBeenCalledWith(proposal, evidenceBundle, undefined);
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/base/v1/module-summary',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails closed on malformed successful responses and surfaces bounded service errors', async () => {
    const repositoryModuleBundle = {} as RepositoryModuleBundle;
    const evidenceBundle = {} as RepositoryModuleEvidenceBundle;
    const malformed = vi.fn(async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    await expect(requestRepositoryModuleSummary(
      'http://127.0.0.1:8788',
      { repositoryModuleBundle, evidenceBundle },
      malformed,
    )).rejects.toThrow('不是 JSON 对象');

    const rejected = vi.fn(async () => new Response(JSON.stringify({ error: 'evidence rejected' }), {
      status: 400,
    })) as unknown as typeof fetch;
    await expect(requestRepositoryModuleSummary(
      'http://127.0.0.1:8788',
      { repositoryModuleBundle, evidenceBundle },
      rejected,
    )).rejects.toThrow('evidence rejected');
  });

  it('rejects non-HTTP service URLs', () => {
    expect(() => moduleSummaryEndpoint('file:///tmp/service')).toThrow('HTTP');
  });

  it('sends and validates the complete signed revision context as one protocol unit', async () => {
    const repositoryModuleBundle = { id: 'bundle' } as RepositoryModuleBundle;
    const evidenceBundle = { id: 'evidence' } as RepositoryModuleEvidenceBundle;
    const previousProposal = { id: 'previous' } as RepositoryModuleWikiProposal;
    const reviseReview = { id: 'review', decision: 'revise' } as import('@forexplore/contracts').RepositoryModuleKnowledgeReview;
    const successor = { id: 'successor' } as RepositoryModuleWikiProposal;
    const fetchMock = vi.fn(async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => new Response(JSON.stringify(successor), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const fetcher = fetchMock as unknown as typeof fetch;

    await requestRepositoryModuleSummary('http://127.0.0.1:8788', {
      repositoryModuleBundle,
      evidenceBundle,
      previousProposal,
      reviseReview,
    }, fetcher);

    expect(validators.validateRevision).toHaveBeenCalledWith(evidenceBundle, {
      previousProposal,
      reviseReview,
    });
    expect(validators.validateProposal).toHaveBeenCalledWith(successor, evidenceBundle, {
      previousProposal,
      reviseReview,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      previousProposal: { id: 'previous' },
      reviseReview: { id: 'review', decision: 'revise' },
    });
  });
});
