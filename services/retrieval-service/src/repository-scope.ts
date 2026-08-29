/**
 * Repository identifiers are authorization boundaries, not presentation labels.
 * Keep their grammar deliberately small so a caller cannot smuggle a wildcard,
 * URL, path traversal token, or the legacy `repo:` UI prefix into a query.
 */
const repositoryIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const presentationScopeLabels = new Set(['configured-repositories', 'mock-catalog']);

export class RepositoryScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepositoryScopeError';
  }
}

export function normalizeRepositoryId(value: string): string | null {
  const normalized = value.trim();
  return repositoryIdPattern.test(normalized) && !presentationScopeLabels.has(normalized)
    ? normalized
    : null;
}

/**
 * Validates a non-empty, exact list of repository IDs.  This is intentionally
 * shared by the HTTP boundary, query engine, and storage layer: none may turn
 * an absent or malformed repository filter into an all-repository query.
 */
export function requireRepositoryScopes(
  values: readonly string[] | undefined,
  source: string = 'Repository scope',
): string[] {
  if (!values || values.length === 0) {
    throw new RepositoryScopeError(`${source} must contain at least one repository.`);
  }

  const normalized = values.map((value) => {
    const repository = normalizeRepositoryId(value);
    if (!repository) {
      throw new RepositoryScopeError(
        `${source} contains an invalid repository identifier: ${JSON.stringify(value)}.`,
      );
    }
    return repository;
  });

  return [...new Set(normalized)];
}
