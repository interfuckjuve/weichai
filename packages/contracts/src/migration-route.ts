import type { AdaptationStrategy } from './adaptation';
import type { LanguageId } from './language-id';
import type { MigrationCapability } from './repository-ingestion';
import type { ValidationPolicySnapshot } from './validation';

export const migrationRouteSchemaVersion = '2.0' as const;

/** A route is always one explicit source, target, and strategy tuple. */
export interface MigrationRouteKey {
  sourceLanguageId: LanguageId;
  targetLanguageId: LanguageId;
  strategy: AdaptationStrategy;
}

export type MigrationRouteStage =
  | 'source-analysis'
  | 'target-analysis'
  | 'context-collection'
  | 'behavior-extraction'
  | 'migration-planning'
  | 'translation'
  | 'patch-generation'
  | 'compile-validation'
  | 'behavior-validation'
  | 'workspace-apply'
  | 'workspace-rollback';

export type MigrationRouteAvailabilityStatus = 'available' | 'degraded' | 'unavailable';

export interface MigrationRouteAvailability {
  status: MigrationRouteAvailabilityStatus;
  reasonCodes: string[];
  summary?: string;
}

/** One provider-backed stage in a migration route. */
export interface MigrationRouteStageCapability {
  stage: MigrationRouteStage;
  providerId: string;
  providerVersion: string;
  capabilities: MigrationCapability[];
  availability: MigrationRouteAvailability;
  requirements?: string[];
}

/**
 * Capability declaration for exactly one language pair and strategy. Separate
 * descriptors are required for reverse or additional pairs; source/target
 * arrays are deliberately absent so no accidental Cartesian product exists.
 */
export interface MigrationRouteDescriptor extends MigrationRouteKey {
  schemaVersion: typeof migrationRouteSchemaVersion;
  id: string;
  name: string;
  version: string;
  stages: MigrationRouteStageCapability[];
  availability: MigrationRouteAvailability;
  validationPolicy: ValidationPolicySnapshot;
  /** Optional until persisted; durable run manifests should bind this hash. */
  contentHash?: string;
}

/** Persisted route policy; runtime/run artifacts may not bind an unhashed policy. */
export interface MaterializedValidationPolicySnapshot extends ValidationPolicySnapshot {
  createdAt: string;
  contentHash: string;
}

/** Persisted route descriptor carried by a runtime capability snapshot. */
export interface MaterializedMigrationRouteDescriptor extends MigrationRouteDescriptor {
  validationPolicy: MaterializedValidationPolicySnapshot;
  contentHash: string;
}

/** Exact route/runtime/policy identity propagated through every V2 artifact. */
export interface MigrationRouteSnapshotRef extends MigrationRouteKey {
  routeId: string;
  routeVersion: string;
  routeContentHash: string;
  runtimeCapabilitySnapshotId: string;
  runtimeCapabilitySnapshotHash: string;
  validationPolicyId: string;
  validationPolicyHash: string;
}

export type MigrationRouteUnsupportedReason =
  | 'route-not-registered'
  | 'route-unavailable'
  | 'required-stage-missing'
  | 'required-stage-unavailable';

export interface MigrationRouteResolutionRequest extends MigrationRouteKey {
  requiredStages?: MigrationRouteStage[];
}

export type MigrationRouteResolution =
  | {
      status: 'supported';
      key: MigrationRouteKey;
      route: MigrationRouteDescriptor;
      warnings: string[];
    }
  | {
      status: 'unsupported';
      key: MigrationRouteKey;
      reason: MigrationRouteUnsupportedReason;
      reasonCodes: string[];
      route?: MigrationRouteDescriptor;
      missingStages?: MigrationRouteStage[];
      unavailableStages?: MigrationRouteStage[];
    };
