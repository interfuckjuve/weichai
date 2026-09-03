import {
  assertCanonicalLanguageId,
  defaultLanguageIdAliasRegistry,
  migrationRouteSchemaVersion,
  normalizeLanguageId,
  validationPolicySchemaVersion,
  type LanguageIdAliasRegistry,
  type MigrationRouteDescriptor,
  type MigrationRouteAvailability,
  type MigrationRouteKey,
  type MigrationRouteResolution,
  type MigrationRouteResolutionRequest,
  type MigrationRouteStage,
  type ValidationPolicySnapshot,
} from '@forexplore/contracts';

const routeStages = new Set<MigrationRouteStage>([
  'source-analysis',
  'target-analysis',
  'context-collection',
  'behavior-extraction',
  'migration-planning',
  'translation',
  'patch-generation',
  'compile-validation',
  'behavior-validation',
  'workspace-apply',
  'workspace-rollback',
]);
const routeStrategies = new Set(['translate', 'bridge', 'wrap', 'reuse']);

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

function routeKey(key: MigrationRouteKey): string {
  return JSON.stringify([
    key.sourceLanguageId,
    key.targetLanguageId,
    key.strategy,
  ]);
}

function validateAvailability(value: MigrationRouteAvailability, label: string): void {
  if (value.status !== 'available' && value.status !== 'degraded' && value.status !== 'unavailable') {
    throw new Error(`${label} has an unsupported availability status.`);
  }
  for (const reason of value.reasonCodes) requiredText(reason, `${label} reason code`);
  if (value.status !== 'available' && value.reasonCodes.length === 0) {
    throw new Error(`${label} must explain degraded or unavailable status.`);
  }
}

function validatePolicy(policy: ValidationPolicySnapshot, route: MigrationRouteDescriptor): void {
  if (policy.schemaVersion !== validationPolicySchemaVersion) {
    throw new Error(`Migration route ${route.id} has an unsupported validation policy schema.`);
  }
  requiredText(policy.id, 'Validation policy ID');
  if (policy.routeId !== route.id || policy.routeVersion !== route.version) {
    throw new Error(`Migration route ${route.id} validation policy is bound to another route.`);
  }
  const checkIds = new Set<string>();
  for (const check of policy.checks) {
    requiredText(check.id, 'Validation policy check ID');
    requiredText(check.label, `Validation policy check ${check.id} label`);
    requiredText(check.verifierId, `Validation policy check ${check.id} verifier ID`);
    if (check.verifierVersion !== undefined) {
      requiredText(check.verifierVersion, `Validation policy check ${check.id} verifier version`);
    }
    if (checkIds.has(check.id)) {
      throw new Error(`Validation policy ${policy.id} repeats check ${check.id}.`);
    }
    checkIds.add(check.id);
  }
  if (![...policy.checks].some((check) => check.required)) {
    throw new Error(`Validation policy ${policy.id} must contain at least one required check.`);
  }
}

function validateRoute(route: MigrationRouteDescriptor): void {
  if (route.schemaVersion !== migrationRouteSchemaVersion) {
    throw new Error(`Migration route ${route.id} has an unsupported schema version.`);
  }
  requiredText(route.id, 'Migration route ID');
  requiredText(route.name, `Migration route ${route.id} name`);
  requiredText(route.version, `Migration route ${route.id} version`);
  assertCanonicalLanguageId(route.sourceLanguageId, `Migration route ${route.id} source language`);
  assertCanonicalLanguageId(route.targetLanguageId, `Migration route ${route.id} target language`);
  if (!routeStrategies.has(route.strategy)) {
    throw new Error(`Migration route ${route.id} has an unsupported strategy: ${String(route.strategy)}.`);
  }
  validateAvailability(route.availability, `Migration route ${route.id}`);
  if (route.stages.length === 0) {
    throw new Error(`Migration route ${route.id} must declare at least one provider-backed stage.`);
  }
  const stages = new Set<MigrationRouteStage>();
  for (const stage of route.stages) {
    if (!routeStages.has(stage.stage)) {
      throw new Error(`Migration route ${route.id} has an unsupported stage: ${String(stage.stage)}.`);
    }
    if (stages.has(stage.stage)) {
      throw new Error(`Migration route ${route.id} repeats stage ${stage.stage}.`);
    }
    stages.add(stage.stage);
    requiredText(stage.providerId, `Migration route ${route.id} ${stage.stage} provider ID`);
    requiredText(stage.providerVersion, `Migration route ${route.id} ${stage.stage} provider version`);
    validateAvailability(stage.availability, `Migration route ${route.id} ${stage.stage}`);
  }
  validatePolicy(route.validationPolicy, route);
}

export interface MigrationRouteResolver {
  resolve(request: MigrationRouteResolutionRequest): MigrationRouteResolution;
}

/**
 * Deterministic registry for exact source x target x strategy tuples. Resolver
 * inputs are normalized through the boundary alias registry; descriptors must
 * already contain canonical IDs so persisted route identities remain stable.
 */
export class MigrationRouteRegistry implements MigrationRouteResolver {
  readonly #aliases: LanguageIdAliasRegistry;
  readonly #byKey = new Map<string, MigrationRouteDescriptor>();
  readonly #byId = new Map<string, MigrationRouteDescriptor>();

  constructor(
    routes: readonly MigrationRouteDescriptor[],
    aliases: LanguageIdAliasRegistry = defaultLanguageIdAliasRegistry,
  ) {
    this.#aliases = aliases;
    for (const route of routes) {
      validateRoute(route);
      if (this.#byId.has(route.id)) {
        throw new Error(`Duplicate migration route ID: ${route.id}`);
      }
      const key = routeKey(route);
      if (this.#byKey.has(key)) {
        throw new Error(
          `Duplicate migration route tuple: ${route.sourceLanguageId} -> ` +
          `${route.targetLanguageId} (${route.strategy}).`,
        );
      }
      this.#byId.set(route.id, route);
      this.#byKey.set(key, route);
    }
  }

  list(): MigrationRouteDescriptor[] {
    return [...this.#byId.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  getById(id: string): MigrationRouteDescriptor | undefined {
    return this.#byId.get(id);
  }

  resolve(request: MigrationRouteResolutionRequest): MigrationRouteResolution {
    const key: MigrationRouteKey = {
      sourceLanguageId: normalizeLanguageId(request.sourceLanguageId, this.#aliases),
      targetLanguageId: normalizeLanguageId(request.targetLanguageId, this.#aliases),
      strategy: request.strategy,
    };
    const route = this.#byKey.get(routeKey(key));
    if (route === undefined) {
      return {
        status: 'unsupported',
        key,
        reason: 'route-not-registered',
        reasonCodes: ['route-not-registered'],
      };
    }
    if (route.availability.status === 'unavailable') {
      return {
        status: 'unsupported',
        key,
        reason: 'route-unavailable',
        reasonCodes: route.availability.reasonCodes.length > 0
          ? [...route.availability.reasonCodes]
          : ['route-unavailable'],
        route,
      };
    }

    const requiredStages = [...new Set(request.requiredStages ?? [])];
    const byStage = new Map(route.stages.map((stage) => [stage.stage, stage]));
    const missingStages = requiredStages.filter((stage) => !byStage.has(stage));
    if (missingStages.length > 0) {
      return {
        status: 'unsupported',
        key,
        reason: 'required-stage-missing',
        reasonCodes: missingStages.map((stage) => `required-stage-missing:${stage}`),
        route,
        missingStages,
      };
    }
    const unavailableStages = requiredStages.filter(
      (stage) => byStage.get(stage)?.availability.status === 'unavailable',
    );
    if (unavailableStages.length > 0) {
      return {
        status: 'unsupported',
        key,
        reason: 'required-stage-unavailable',
        reasonCodes: unavailableStages.flatMap((stage) => {
          const reasonCodes = byStage.get(stage)!.availability.reasonCodes;
          return reasonCodes.length > 0
            ? reasonCodes.map((reason) => `${stage}:${reason}`)
            : [`required-stage-unavailable:${stage}`];
        }),
        route,
        unavailableStages,
      };
    }

    const warnings = [
      ...(route.availability.status === 'degraded'
        ? route.availability.reasonCodes.map((reason) => `route:${reason}`)
        : []),
      ...requiredStages.flatMap((stage) => {
        const capability = byStage.get(stage)!;
        return capability.availability.status === 'degraded'
          ? capability.availability.reasonCodes.map((reason) => `${stage}:${reason}`)
          : [];
      }),
    ];
    return { status: 'supported', key, route, warnings };
  }
}
