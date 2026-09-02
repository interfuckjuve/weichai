import { describe, expect, it } from 'vitest';
import {
  migrationRouteSchemaVersion,
  validationPolicySchemaVersion,
  type MigrationRouteDescriptor,
} from '@forexplore/contracts';
import { MigrationRouteRegistry } from './migration-route-registry';

function route(overrides: Partial<MigrationRouteDescriptor> = {}): MigrationRouteDescriptor {
  const base: MigrationRouteDescriptor = {
    schemaVersion: migrationRouteSchemaVersion,
    id: 'gleam-to-elixir-translate',
    name: 'Gleam to Elixir translation',
    version: '1.0.0',
    sourceLanguageId: 'gleam',
    targetLanguageId: 'elixir',
    strategy: 'translate',
    stages: [
      {
        stage: 'translation',
        providerId: 'beam-translator',
        providerVersion: '1.0.0',
        capabilities: ['code-translation'],
        availability: { status: 'available', reasonCodes: [] },
      },
      {
        stage: 'behavior-validation',
        providerId: 'beam-behavior-verifier',
        providerVersion: '2.0.0',
        capabilities: ['migration-validation'],
        availability: { status: 'available', reasonCodes: [] },
      },
    ],
    availability: { status: 'available', reasonCodes: [] },
    validationPolicy: {
      schemaVersion: validationPolicySchemaVersion,
      id: 'gleam-to-elixir-policy-v1',
      routeId: 'gleam-to-elixir-translate',
      routeVersion: '1.0.0',
      checks: [
        {
          id: 'beam-behavior-parity',
          label: 'BEAM behavior parity',
          phase: 'behavior',
          required: true,
          verifierId: 'beam-behavior-verifier',
          verifierVersion: '2.0.0',
        },
      ],
    },
  };
  return { ...base, ...overrides };
}

describe('MigrationRouteRegistry', () => {
  it('resolves a non-Java/C# route by an exact normalized tuple', () => {
    const registry = new MigrationRouteRegistry([route()]);
    const result = registry.resolve({
      sourceLanguageId: 'Gleam',
      targetLanguageId: 'ELIXIR',
      strategy: 'translate',
      requiredStages: ['translation', 'behavior-validation'],
    });

    expect(result.status).toBe('supported');
    expect(result.key).toEqual({
      sourceLanguageId: 'gleam',
      targetLanguageId: 'elixir',
      strategy: 'translate',
    });
    if (result.status === 'supported') {
      expect(result.route.id).toBe('gleam-to-elixir-translate');
    }
  });

  it('returns a structured unsupported result for an unregistered language', () => {
    const registry = new MigrationRouteRegistry([route()]);
    expect(registry.resolve({
      sourceLanguageId: 'unknown-research-language',
      targetLanguageId: 'elixir',
      strategy: 'translate',
    })).toMatchObject({
      status: 'unsupported',
      reason: 'route-not-registered',
      key: { sourceLanguageId: 'unknown-research-language', targetLanguageId: 'elixir' },
    });
  });

  it('fails closed when a required route stage is missing', () => {
    const registry = new MigrationRouteRegistry([route()]);
    expect(registry.resolve({
      sourceLanguageId: 'gleam',
      targetLanguageId: 'elixir',
      strategy: 'translate',
      requiredStages: ['workspace-apply'],
    })).toMatchObject({
      status: 'unsupported',
      reason: 'required-stage-missing',
      missingStages: ['workspace-apply'],
    });
  });

  it('reports an explicitly unavailable route instead of silently falling back', () => {
    const registry = new MigrationRouteRegistry([route({
      availability: {
        status: 'unavailable',
        reasonCodes: ['target-toolchain-missing'],
      },
    })]);
    expect(registry.resolve({
      sourceLanguageId: 'gleam',
      targetLanguageId: 'elixir',
      strategy: 'translate',
    })).toMatchObject({
      status: 'unsupported',
      reason: 'route-unavailable',
      reasonCodes: ['target-toolchain-missing'],
    });
  });

  it('rejects non-canonical descriptors and policies without required checks', () => {
    expect(() => new MigrationRouteRegistry([
      route({ sourceLanguageId: 'Gleam' }),
    ])).toThrow(/canonical lowercase/);
    expect(() => new MigrationRouteRegistry([
      route({
        validationPolicy: {
          ...route().validationPolicy,
          checks: [{
            id: 'optional-format',
            label: 'Format',
            phase: 'format',
            required: false,
            verifierId: 'formatter',
          }],
        },
      }),
    ])).toThrow(/at least one required check/);
  });
});
