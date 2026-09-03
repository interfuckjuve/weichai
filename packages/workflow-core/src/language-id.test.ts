import { describe, expect, it } from 'vitest';
import {
  assertCanonicalLanguageId,
  createLanguageIdAliasRegistry,
  migrationReferenceSchemaVersion,
  normalizeLanguageId,
  type ImplementationCandidateRef,
  type MigrationTargetRef,
} from '@forexplore/contracts';

describe('LanguageId normalization', () => {
  it('normalizes compatibility spellings without closing the language set', () => {
    expect(normalizeLanguageId(' C# ')).toBe('csharp');
    expect(normalizeLanguageId('TypeScript')).toBe('typescript');
    expect(normalizeLanguageId('Gleam')).toBe('gleam');
    expect(normalizeLanguageId('Acme DSL')).toBe('acme-dsl');
  });

  it('supports boundary-owned aliases for languages unknown to core', () => {
    const registry = createLanguageIdAliasRegistry([
      { alias: 'ACME/Flow', languageId: 'acme-flow' },
    ]);
    expect(normalizeLanguageId('acme/flow', registry)).toBe('acme-flow');
    expect(normalizeLanguageId('Elixir', registry)).toBe('elixir');
  });

  it('rejects ambiguous aliases and non-canonical persisted IDs', () => {
    expect(() => createLanguageIdAliasRegistry([
      ['dialect', 'dialect-one'],
      ['DIALECT', 'dialect-two'],
    ])).toThrow(/maps to both/);
    expect(() => assertCanonicalLanguageId('C#')).toThrow(/canonical lowercase/);
  });

  it('allows V2 target and candidate references for languages absent from V1', () => {
    const target: MigrationTargetRef = {
      schemaVersion: migrationReferenceSchemaVersion,
      id: 'target-gleam-main',
      lineage: {
        repositoryId: 'target-repository',
        repositoryContentHash: 'a'.repeat(64),
        unifiedRepositoryIrId: 'target-ir',
        unifiedRepositoryIrHash: 'b'.repeat(64),
        moduleCatalogId: 'target-catalog',
        moduleCatalogHash: 'c'.repeat(64),
        moduleReviewId: 'target-review',
        moduleReviewHash: 'd'.repeat(64),
      },
      entity: {
        entityId: 'gleam-callable',
        languageId: 'gleam',
        kind: 'function',
        name: 'quote',
      },
      allowedModificationPaths: ['src/quote.gleam'],
    };
    const candidate: ImplementationCandidateRef = {
      schemaVersion: migrationReferenceSchemaVersion,
      id: 'candidate-elixir-quote',
      lineage: {
        repositoryId: 'history-repository',
        repositoryContentHash: 'e'.repeat(64),
        unifiedRepositoryIrId: 'history-ir',
        unifiedRepositoryIrHash: 'f'.repeat(64),
      },
      entity: {
        entityId: 'elixir-function',
        languageId: 'elixir',
        kind: 'def',
        name: 'quote',
      },
    };
    expect([target.entity.languageId, candidate.entity.languageId]).toEqual(['gleam', 'elixir']);
  });
});
