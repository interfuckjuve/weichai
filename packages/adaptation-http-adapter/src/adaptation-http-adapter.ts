import type {
  AdaptationRequest,
  AdaptationRequestV2,
  AdaptationResult,
  AdaptationResultV2,
  ApplyResult,
  FilePatch,
} from '@forexplore/contracts';
import {
  validateAdaptationRequestV2,
  validateAdaptationResultV2,
  type CodeAdaptationPort,
  type CodeBackfillPort,
  type MigrationExecutionV2ValidationContext,
  type WorkflowPorts,
} from '@forexplore/workflow-core';

export interface AdaptationHttpOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function isAdaptationResult(value: unknown): value is AdaptationResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<AdaptationResult>;
  return (
    typeof result.generatedCode === 'string' &&
    typeof result.targetLanguage === 'string' &&
    typeof result.strategy === 'string' &&
    Array.isArray(result.interfaceMappings) &&
    Array.isArray(result.validation) &&
    Array.isArray(result.files)
  );
}

function isApplyResult(value: unknown): value is ApplyResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<ApplyResult>;
  return (
    Array.isArray(result.appliedFiles) &&
    result.appliedFiles.every((path) => typeof path === 'string') &&
    typeof result.checkpointId === 'string' &&
    typeof result.rollbackAvailable === 'boolean'
  );
}

interface AdaptationServiceErrorBody {
  error?: unknown;
  code?: unknown;
  reasonCodes?: unknown;
}

async function responseError(response: Response): Promise<AdaptationServiceErrorBody> {
  try {
    const body = (await response.json()) as AdaptationServiceErrorBody;
    if (typeof body.error === 'string' && body.error.trim()) return body;
  } catch {
    // The status text below is more useful than a JSON parse failure.
  }
  return { error: response.statusText || `HTTP ${response.status}` };
}

export class AdaptationHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly reasonCodes: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AdaptationHttpError';
  }
}

async function adaptationHttpError(response: Response, prefix: string): Promise<AdaptationHttpError> {
  const body = await responseError(response);
  return new AdaptationHttpError(
    `${prefix}: ${String(body.error)}`,
    response.status,
    typeof body.code === 'string' ? body.code : undefined,
    Array.isArray(body.reasonCodes)
      ? body.reasonCodes.filter((reason): reason is string => typeof reason === 'string')
      : [],
  );
}

/** @deprecated Compatibility client for the legacy V1 adaptation contract. */
export class AdaptationHttpAdapter implements CodeAdaptationPort {
  private readonly adaptUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.adaptUrl = endpoint(options.baseUrl, '/v1/adapt');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async adapt(request: AdaptationRequest, signal?: AbortSignal): Promise<AdaptationResult> {
    const response = await this.request(this.adaptUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw await adaptationHttpError(response, 'Adaptation failed');
    }

    const body: unknown = await response.json();
    if (!isAdaptationResult(body)) {
      throw new Error('Adaptation service returned an invalid response.');
    }
    return body;
  }
}

export interface CodeAdaptationPortV2 {
  adapt(
    request: AdaptationRequestV2,
    context: MigrationExecutionV2ValidationContext,
    signal?: AbortSignal,
  ): Promise<AdaptationResultV2>;
}

/** Formal V2 client. It validates both sides and has no V1 fallback path. */
export class AdaptationHttpAdapterV2 implements CodeAdaptationPortV2 {
  private readonly adaptUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.adaptUrl = endpoint(options.baseUrl, '/v2/adapt');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async adapt(
    request: AdaptationRequestV2,
    context: MigrationExecutionV2ValidationContext,
    signal?: AbortSignal,
  ): Promise<AdaptationResultV2> {
    validateAdaptationRequestV2(request, context);
    const response = await this.request(this.adaptUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) {
      throw await adaptationHttpError(response, 'V2 adaptation failed');
    }
    const body = await response.json() as AdaptationResultV2;
    try {
      return validateAdaptationResultV2(body, request, context);
    } catch (error) {
      throw new Error(
        `Adaptation service returned an invalid V2 response: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export class BackfillHttpAdapter implements CodeBackfillPort {
  private readonly backfillUrl: string;
  private readonly request: typeof globalThis.fetch;

  constructor(options: AdaptationHttpOptions) {
    if (!options.baseUrl.trim()) {
      throw new Error('Adaptation API base URL must not be empty.');
    }
    this.backfillUrl = endpoint(options.baseUrl, '/v1/backfill');
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async apply(files: FilePatch[], signal?: AbortSignal): Promise<ApplyResult> {
    const response = await this.request(this.backfillUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(files),
      signal,
    });

    if (!response.ok) {
      throw await adaptationHttpError(response, 'Backfill failed');
    }

    const body: unknown = await response.json();
    if (!isApplyResult(body)) {
      throw new Error('Backfill service returned an invalid response.');
    }
    return body;
  }
}

export function withAdaptationService(
  ports: WorkflowPorts,
  options: AdaptationHttpOptions,
): WorkflowPorts {
  return {
    ...ports,
    adaptation: new AdaptationHttpAdapter(options),
    backfill: new BackfillHttpAdapter(options),
  };
}
