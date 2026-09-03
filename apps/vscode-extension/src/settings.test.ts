import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeRepositoryPaths } from './settings';

describe('repository path normalization', () => {
  it('returns absolute paths and removes equivalent registrations', () => {
    const repository = path.join(process.cwd(), 'fixtures', 'history');
    const equivalent = path.join(process.cwd(), 'fixtures', '.', 'history');

    expect(normalizeRepositoryPaths(['', `  ${repository}  `, equivalent]))
      .toEqual([path.normalize(path.resolve(repository))]);
  });

  it.runIf(process.platform === 'win32')('deduplicates Windows paths without case sensitivity', () => {
    const repository = path.join(process.cwd(), 'fixtures', 'history');

    expect(normalizeRepositoryPaths([repository, repository.toUpperCase()])).toHaveLength(1);
  });
});
