/**
 * Stable, adapter-owned language identifier used by repository ingestion.
 * It is intentionally open-ended and does not imply migration support.
 */
export type LanguageId = string;

/**
 * Canonical IDs are persistence and capability-routing keys, not a list of
 * languages supported by ForeXplore. New IDs remain valid without changing a
 * central union.
 */
export const canonicalLanguageIdPattern = /^[a-z0-9][a-z0-9]*(?:[._+-][a-z0-9]+)*$/;

export interface LanguageIdAlias {
  alias: string;
  languageId: LanguageId;
}

export interface LanguageIdAliasRegistry {
  /** Resolve a boundary spelling to a canonical, open-ended language ID. */
  resolve(value: string): LanguageId;
  /** Return the canonical target for a registered alias, when one exists. */
  lookup(value: string): LanguageId | undefined;
  /** Immutable, deterministic alias inventory for diagnostics and manifests. */
  entries(): readonly LanguageIdAlias[];
}

const builtInLanguageIdAliases = [
  ['c#', 'csharp'],
  ['cs', 'csharp'],
  ['c-sharp', 'csharp'],
  ['csharp', 'csharp'],
  ['c++', 'cpp'],
  ['cplusplus', 'cpp'],
  ['cpp', 'cpp'],
  ['f#', 'fsharp'],
  ['f-sharp', 'fsharp'],
  ['fsharp', 'fsharp'],
  ['golang', 'go'],
  ['go', 'go'],
  ['js', 'javascript'],
  ['javascript', 'javascript'],
  ['py', 'python'],
  ['python', 'python'],
  ['rs', 'rust'],
  ['rust', 'rust'],
  ['ts', 'typescript'],
  ['typescript', 'typescript'],
] as const satisfies readonly (readonly [string, LanguageId])[];

function aliasLookupKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
}

function canonicalCandidate(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

export function isCanonicalLanguageId(value: unknown): value is LanguageId {
  return typeof value === 'string' && canonicalLanguageIdPattern.test(value);
}

export function assertCanonicalLanguageId(
  value: unknown,
  label = 'Language ID',
): asserts value is LanguageId {
  if (!isCanonicalLanguageId(value)) {
    throw new Error(
      `${label} must be a canonical lowercase language ID. ` +
      'Register a boundary alias when the external spelling is not canonical.',
    );
  }
}

/**
 * Build an alias registry without turning aliases into a support allow-list.
 * Values absent from the registry are normalized and accepted whenever they
 * satisfy the canonical ID syntax.
 */
export function createLanguageIdAliasRegistry(
  aliases: readonly (LanguageIdAlias | readonly [string, LanguageId])[] = [],
  options: { includeBuiltIns?: boolean } = {},
): LanguageIdAliasRegistry {
  const values = options.includeBuiltIns === false
    ? aliases
    : [...builtInLanguageIdAliases, ...aliases];
  const byAlias = new Map<string, LanguageId>();

  for (const value of values) {
    const alias = 'alias' in value ? value.alias : value[0];
    const languageId = 'languageId' in value ? value.languageId : value[1];
    const key = aliasLookupKey(alias);
    if (!key) throw new Error('Language alias must not be empty.');
    assertCanonicalLanguageId(languageId, `Canonical language ID for alias ${JSON.stringify(alias)}`);
    const previous = byAlias.get(key);
    if (previous !== undefined && previous !== languageId) {
      throw new Error(
        `Language alias ${JSON.stringify(alias)} maps to both ${previous} and ${languageId}.`,
      );
    }
    byAlias.set(key, languageId);
  }

  const inventory = [...byAlias.entries()]
    .map(([alias, languageId]) => ({ alias, languageId }))
    .sort((left, right) => left.alias.localeCompare(right.alias));

  return Object.freeze({
    resolve(value: string): LanguageId {
      const key = aliasLookupKey(value);
      if (!key) throw new Error('Language ID must not be empty.');
      const registered = byAlias.get(key);
      if (registered !== undefined) return registered;
      const candidate = canonicalCandidate(value);
      assertCanonicalLanguageId(candidate);
      return candidate;
    },
    lookup(value: string): LanguageId | undefined {
      return byAlias.get(aliasLookupKey(value));
    },
    entries(): readonly LanguageIdAlias[] {
      return inventory.map((entry) => ({ ...entry }));
    },
  });
}

export const defaultLanguageIdAliasRegistry = createLanguageIdAliasRegistry();

export function normalizeLanguageId(
  value: string,
  registry: LanguageIdAliasRegistry = defaultLanguageIdAliasRegistry,
): LanguageId {
  return registry.resolve(value);
}
