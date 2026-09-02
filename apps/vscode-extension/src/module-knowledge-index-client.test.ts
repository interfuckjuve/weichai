import type {
  IndexedModuleKnowledgeDocument,
  RepositoryKnowledgePublication,
  RepositoryModuleIndexReceipt,
} from '@forexplore/contracts';
import { describe, expect, it, vi } from 'vitest';

const validators = vi.hoisted(() => ({
  validatePublication: vi.fn(),
  validateReceipt: vi.fn(),
}));

vi.mock('@forexplore/workflow-core', () => ({
  validateRepositoryKnowledgePublication: validators.validatePublication,
  validateRepositoryModuleIndexReceipt: validators.validateReceipt,
}));

import {
  HttpModuleKnowledgeIndexPublisher,
  moduleKnowledgeIndexEndpoint,
} from './module-knowledge-index-client';

const publicationHash = 'a'.repeat(64);
const publication = {
  id: 'publication',
  payloadHash: publicationHash,
  generation: 1,
  status: 'staged',
  scope: { repositoryId: 'repository-orders', channel: 'branch:main' },
  repositoryScopes: ['repository-orders'],
  source: { modules: [{ moduleId: 'orders' }] },
} as RepositoryKnowledgePublication;
const receipt = {
  id: 'receipt',
  publicationId: publication.id,
  publicationPayloadHash: publication.payloadHash,
  generation: publication.generation,
  status: 'validated',
  scope: publication.scope,
  documentCount: 1,
  moduleIds: ['orders'],
} as RepositoryModuleIndexReceipt;
const key = {
  repositoryId: publication.scope.repositoryId,
  channel: publication.scope.channel,
  publicationId: publication.id,
  generation: publication.generation,
};

describe('module knowledge index client', () => {
  it('stages and validates through the dedicated authenticated endpoints', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ receipt }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const publisher = new HttpModuleKnowledgeIndexPublisher(
      'http://127.0.0.1:8787/base/',
      'writer-token',
      fetcher,
    );
    const document = {
      id: 'module-document',
      repositoryScopes: ['repository-orders'],
    } as IndexedModuleKnowledgeDocument;

    await expect(publisher.stage({
      publication,
      repositoryScopes: ['repository-orders'],
      documents: [document],
    })).resolves.toEqual(receipt);
    await expect(publisher.validate(key)).resolves.toEqual(receipt);

    expect(validators.validatePublication).toHaveBeenCalledWith(publication);
    expect(validators.validateReceipt).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:8787/base/v1/module-knowledge/generations/stage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer writer-token' }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8787/base/v1/module-knowledge/generations/validate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('parses activation and withdrawal heads including an empty restored head', async () => {
    const responses = [
      { head: {
        repositoryId: 'repository-orders',
        channel: 'branch:main',
        publicationId: 'publication',
        publicationPayloadHash: publicationHash,
        generation: 1,
        revision: 3,
      } },
      { head: {
        repositoryId: 'repository-orders',
        channel: 'branch:main',
        publicationId: null,
        publicationPayloadHash: null,
        generation: null,
        revision: 4,
      } },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
    })) as unknown as typeof fetch;
    const publisher = new HttpModuleKnowledgeIndexPublisher(
      'https://index.example.test',
      'writer-token',
      fetcher,
    );

    await expect(publisher.activate(key, null)).resolves.toMatchObject({
      publicationPayloadHash: publicationHash,
      generation: 1,
      revision: 3,
    });
    await expect(publisher.withdraw(key, 1)).resolves.toMatchObject({
      publicationId: null,
      publicationPayloadHash: null,
      generation: null,
      revision: 4,
    });
  });

  it('reads the authenticated remote head with its immutable publication payload hash', async () => {
    const responses = [
      { head: {
        repositoryId: key.repositoryId,
        channel: key.channel,
        publicationId: key.publicationId,
        publicationPayloadHash: publicationHash,
        generation: key.generation,
        revision: 7,
      } },
      { head: null },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
    })) as unknown as typeof fetch;
    const publisher = new HttpModuleKnowledgeIndexPublisher(
      'https://index.example.test',
      'writer-token',
      fetcher,
    );

    await expect(publisher.readHead(publication.scope)).resolves.toMatchObject({
      publicationPayloadHash: publicationHash,
      revision: 7,
    });
    await expect(publisher.readHead(publication.scope)).resolves.toBeNull();
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://index.example.test/v1/module-knowledge/generations/head',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer writer-token' }),
      }),
    );
  });

  it('rejects a valid-looking receipt or head that is bound to another request', async () => {
    const responses = [
      { receipt: { ...receipt, publicationId: 'other-publication' } },
      { head: {
        repositoryId: 'other/repository',
        channel: key.channel,
        publicationId: key.publicationId,
        publicationPayloadHash: publicationHash,
        generation: key.generation,
        revision: 1,
      } },
    ];
    const fetcher = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
    })) as unknown as typeof fetch;
    const publisher = new HttpModuleKnowledgeIndexPublisher(
      'https://index.example.test',
      'writer-token',
      fetcher,
    );

    await expect(publisher.validate(key)).rejects.toThrow('不匹配');
    await expect(publisher.activate(key, null)).rejects.toThrow('仓库或通道不匹配');
  });

  it('rejects mutable request or document ACLs that differ from the publication', async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const publisher = new HttpModuleKnowledgeIndexPublisher(
      'https://index.example.test',
      'writer-token',
      fetcher,
    );

    await expect(publisher.stage({
      publication,
      repositoryScopes: ['repository-orders', 'other/private'],
      documents: [{ id: 'orders', repositoryScopes: ['repository-orders'] } as IndexedModuleKnowledgeDocument],
    })).rejects.toThrow('stage ACL');
    await expect(publisher.stage({
      publication,
      repositoryScopes: ['repository-orders'],
      documents: [{ id: 'orders', repositoryScopes: ['other/private'] } as IndexedModuleKnowledgeDocument],
    })).rejects.toThrow('文档 orders');
    await expect(publisher.stage({
      publication,
      repositoryScopes: ['repository-orders'],
      documents: [{
        id: 'orders',
        repositoryScopes: ['repository-orders', 'repository-orders'],
      } as IndexedModuleKnowledgeDocument],
    })).rejects.toThrow('文档 orders');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('normalizes the writer token before constructing the Authorization header', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ receipt }), {
      status: 200,
    })) as unknown as typeof fetch;
    const publisher = new HttpModuleKnowledgeIndexPublisher(
      'http://127.0.0.1:8787',
      '  writer-token  ',
      fetcher,
    );

    await publisher.validate(key);

    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer writer-token' }),
    }));
  });

  it('fails closed on missing tokens, malformed heads, service errors, and unsafe URLs', async () => {
    expect(() => new HttpModuleKnowledgeIndexPublisher('http://127.0.0.1:8787', '  '))
      .toThrow('令牌');
    expect(() => moduleKnowledgeIndexEndpoint('file:///tmp/index', 'generations/stage'))
      .toThrow('HTTP');
    expect(() => moduleKnowledgeIndexEndpoint('http://index.example.test', 'generations/stage'))
      .toThrow('HTTPS');
    expect(() => moduleKnowledgeIndexEndpoint(
      'https://user:password@index.example.test',
      'generations/stage',
    )).toThrow('不能内嵌凭据');
    expect(() => moduleKnowledgeIndexEndpoint('http://127.0.0.1:8787', '../stage'))
      .toThrow('操作无效');

    const rejected = vi.fn(async () => new Response(JSON.stringify({ error: 'CAS conflict' }), {
      status: 409,
    })) as unknown as typeof fetch;
    const publisher = new HttpModuleKnowledgeIndexPublisher(
      'http://127.0.0.1:8787',
      'writer-token',
      rejected,
    );
    await expect(publisher.activate(key, null)).rejects.toThrow('CAS conflict');

    const malformed = vi.fn(async () => new Response(JSON.stringify({ head: { revision: -1 } }), {
      status: 200,
    })) as unknown as typeof fetch;
    const malformedPublisher = new HttpModuleKnowledgeIndexPublisher(
      'http://127.0.0.1:8787',
      'writer-token',
      malformed,
    );
    await expect(malformedPublisher.activate(key, null)).rejects.toThrow('head 无效');

    const inconsistent = vi.fn(async () => new Response(JSON.stringify({ head: {
      repositoryId: key.repositoryId,
      channel: key.channel,
      publicationId: null,
      publicationPayloadHash: publicationHash,
      generation: null,
      revision: 1,
    } }), { status: 200 })) as unknown as typeof fetch;
    const inconsistentPublisher = new HttpModuleKnowledgeIndexPublisher(
      'http://127.0.0.1:8787',
      'writer-token',
      inconsistent,
    );
    await expect(inconsistentPublisher.withdraw(key, 1)).rejects.toThrow('head 无效');

    const neverCalled = vi.fn() as unknown as typeof fetch;
    const guardedPublisher = new HttpModuleKnowledgeIndexPublisher(
      'http://127.0.0.1:8787',
      'writer-token',
      neverCalled,
    );
    await expect(guardedPublisher.activate(key, key.generation)).rejects.toThrow('generation');
    expect(neverCalled).not.toHaveBeenCalled();
  });
});
