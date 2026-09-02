import type {
  MigrationRouteDescriptor,
  MigrationRouteAvailability,
  MigrationRouteStageCapability,
  MigrationRuntimeCapabilitySnapshot,
} from '@forexplore/contracts';
import {
  materializeMigrationRuntimeCapabilitySnapshot,
  validateMigrationRuntimeCapabilitySnapshot,
} from '@forexplore/workflow-core';

const runtimeCapabilityPath = '/v2/runtime-capabilities';
const retrievalCapabilityPath = '/v2/capabilities';
const runtimeCapabilityTimeoutMs = 2_000;

export interface RuntimeCapabilityClientResult {
  snapshot: MigrationRuntimeCapabilitySnapshot;
  source: 'service' | 'fail-closed-empty';
  error?: string;
}

export function emptyRuntimeCapabilitySnapshot(
  createdAt = new Date().toISOString(),
): MigrationRuntimeCapabilitySnapshot {
  return materializeMigrationRuntimeCapabilitySnapshot({ routes: [], createdAt });
}

export function runtimeCapabilityEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('Adaptation service URL must not be empty.');
  const parsed = new URL(`${normalized}${runtimeCapabilityPath}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Adaptation service URL must use HTTP or HTTPS.');
  }
  return parsed.toString();
}

export function retrievalCapabilityEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('Retrieval service URL must not be empty.');
  const parsed = new URL(`${normalized}${retrievalCapabilityPath}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Retrieval service URL must use HTTP or HTTPS.');
  }
  return parsed.toString();
}

/**
 * Reads the service-owned capability artifact without inventing fallback
 * routes. Every failure is represented by a valid, empty runtime snapshot so
 * downstream route resolution remains deterministic and fail closed.
 */
export async function requestRuntimeCapabilities(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<RuntimeCapabilityClientResult> {
  const failed = (error: unknown): RuntimeCapabilityClientResult => ({
    snapshot: emptyRuntimeCapabilitySnapshot(now()),
    source: 'fail-closed-empty',
    error: error instanceof Error ? error.message : String(error),
  });

  try {
    const response = await fetchImpl(runtimeCapabilityEndpoint(baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(runtimeCapabilityTimeoutMs),
    });
    if (!response.ok) {
      return failed(`Runtime capability request failed with HTTP ${response.status}.`);
    }
    const body = await response.json() as MigrationRuntimeCapabilitySnapshot;
    return {
      snapshot: validateMigrationRuntimeCapabilitySnapshot(body),
      source: 'service',
    };
  } catch (error) {
    return failed(error);
  }
}

/** Retrieval publishes an envelope because the endpoint may grow additional
 * index capability facts. Missing/malformed snapshots stay fail closed. */
export async function requestRetrievalRuntimeCapabilities(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  now: () => string = () => new Date().toISOString(),
): Promise<RuntimeCapabilityClientResult> {
  const failed = (error: unknown): RuntimeCapabilityClientResult => ({
    snapshot: emptyRuntimeCapabilitySnapshot(now()),
    source: 'fail-closed-empty',
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    const response = await fetchImpl(retrievalCapabilityEndpoint(baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(runtimeCapabilityTimeoutMs),
    });
    if (!response.ok) {
      return failed(`Retrieval capability request failed with HTTP ${response.status}.`);
    }
    const body = await response.json() as { runtimeCapabilities?: unknown };
    return {
      snapshot: validateMigrationRuntimeCapabilitySnapshot(
        body.runtimeCapabilities as MigrationRuntimeCapabilitySnapshot,
      ),
      source: 'service',
    };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Strict route intersection. Adaptation remains the policy/provider anchor;
 * retrieval must advertise the exact same materialized route or the Host
 * marks source analysis unavailable before any local analyzer composition.
 */
export function intersectRuntimeCapabilities(
  adaptation: MigrationRuntimeCapabilitySnapshot,
  retrieval: MigrationRuntimeCapabilitySnapshot,
): MigrationRuntimeCapabilitySnapshot {
  const adaptationSnapshot = validateMigrationRuntimeCapabilitySnapshot(adaptation);
  const retrievalSnapshot = validateMigrationRuntimeCapabilitySnapshot(retrieval);
  const routes: MigrationRouteDescriptor[] = adaptationSnapshot.routes.map((route) => {
    const authorized = retrievalSnapshot.routes.some((candidate) =>
      candidate.id === route.id &&
      candidate.version === route.version &&
      candidate.sourceLanguageId === route.sourceLanguageId &&
      candidate.targetLanguageId === route.targetLanguageId &&
      candidate.strategy === route.strategy &&
      candidate.contentHash === route.contentHash &&
      candidate.validationPolicy.id === route.validationPolicy.id &&
      candidate.validationPolicy.contentHash === route.validationPolicy.contentHash,
    );
    if (authorized) return route;
    const stages = route.stages.map((stage) => stage.stage !== 'source-analysis'
      ? stage
      : {
          ...stage,
          availability: {
            status: 'unavailable' as const,
            reasonCodes: [...new Set([
              ...stage.availability.reasonCodes,
              retrievalSnapshot.routes.length === 0
                ? 'retrieval-runtime-routes-empty'
                : 'retrieval-runtime-route-mismatch',
            ])].sort(),
            summary: 'The retrieval service does not authorize this exact materialized route.',
          },
        });
    return {
      schemaVersion: route.schemaVersion,
      id: route.id,
      name: route.name,
      version: route.version,
      sourceLanguageId: route.sourceLanguageId,
      targetLanguageId: route.targetLanguageId,
      strategy: route.strategy,
      stages,
      availability: aggregateRouteAvailability(stages),
      validationPolicy: route.validationPolicy,
    };
  });
  return materializeMigrationRuntimeCapabilitySnapshot({
    routes,
    createdAt: adaptationSnapshot.createdAt,
  });
}

function aggregateRouteAvailability(
  stages: readonly MigrationRouteStageCapability[],
): MigrationRouteAvailability {
  const unavailable = stages.filter((stage) => stage.availability.status === 'unavailable');
  if (unavailable.length > 0) {
    return {
      status: 'unavailable',
      reasonCodes: unavailable.flatMap((stage) => stage.availability.reasonCodes.map(
        (reason) => `${stage.stage}:${reason}`,
      )),
      summary: 'One or more required runtime stages are unavailable.',
    };
  }
  const degraded = stages.filter((stage) => stage.availability.status === 'degraded');
  if (degraded.length > 0) {
    return {
      status: 'degraded',
      reasonCodes: degraded.flatMap((stage) => stage.availability.reasonCodes.map(
        (reason) => `${stage.stage}:${reason}`,
      )),
      summary: 'All required stages are executable, with declared limitations.',
    };
  }
  return { status: 'available', reasonCodes: [] };
}
