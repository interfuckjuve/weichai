import type { AdaptationRequestV2, AdaptationResultV2 } from '@forexplore/contracts';
import type { MigrationExecutionV2ValidationContext } from '@forexplore/workflow-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const validators = vi.hoisted(() => ({
  request: vi.fn((value: unknown) => value),
  result: vi.fn((value: unknown) => value),
}));

vi.mock('@forexplore/workflow-core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@forexplore/workflow-core')>(),
  validateAdaptationRequestV2: validators.request,
  validateAdaptationResultV2: validators.result,
}));

import {
  AdaptationHttpAdapterV2,
  AdaptationHttpError,
} from './adaptation-http-adapter';

const request = {
  schemaVersion: '2.0',
  id: 'adaptation-request-v2:test',
  contentHash: 'a'.repeat(64),
  route: { routeId: 'forexplore.translate.typescript-to-python' },
} as unknown as AdaptationRequestV2;
const context: MigrationExecutionV2ValidationContext = {
  runtimeCapabilities: { id: 'runtime:test' },
} as never;
const result = {
  schemaVersion: '2.0',
  id: 'adaptation-result-v2:test',
  requestId: request.id,
  requestHash: request.contentHash,
} as unknown as AdaptationResultV2;

describe('AdaptationHttpAdapterV2', () => {
  beforeEach(() => {
    validators.request.mockClear();
    validators.result.mockClear();
    validators.request.mockImplementation((value) => value);
    validators.result.mockImplementation((value) => value);
  });

  it('validates the V2 request and response without invoking a V1 endpoint', async () => {
    const fetch = vi.fn(async () => Response.json(result));
    const adapter = new AdaptationHttpAdapterV2({
      baseUrl: 'http://127.0.0.1:8788/',
      fetch,
    });

    await expect(adapter.adapt(request, context)).resolves.toEqual(result);
    expect(validators.request).toHaveBeenCalledWith(request, context);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/v2/adapt',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
    expect(validators.result).toHaveBeenCalledWith(result, request, context);
  });

  it('preserves structured route-unavailable capability reasons', async () => {
    const fetch = vi.fn(async () => Response.json({
      schemaVersion: '2.0',
      code: 'MIGRATION_ROUTE_UNAVAILABLE',
      error: 'Migration route is unavailable.',
      reasonCodes: ['behavior-validation:behavior-verifier-execution-disabled'],
    }, { status: 409 }));
    const adapter = new AdaptationHttpAdapterV2({ baseUrl: 'http://localhost', fetch });

    const error = await adapter.adapt(request, context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdaptationHttpError);
    expect(error).toMatchObject({
      status: 409,
      code: 'MIGRATION_ROUTE_UNAVAILABLE',
      reasonCodes: ['behavior-validation:behavior-verifier-execution-disabled'],
    });
    expect(validators.result).not.toHaveBeenCalled();
  });

  it('rejects a successful response when the formal result validator fails', async () => {
    validators.result.mockImplementation(() => {
      throw new Error('result hash is invalid');
    });
    const fetch = vi.fn(async () => Response.json(result));
    const adapter = new AdaptationHttpAdapterV2({ baseUrl: 'http://localhost', fetch });

    await expect(adapter.adapt(request, context)).rejects.toThrow(
      'invalid V2 response: result hash is invalid',
    );
  });
});
