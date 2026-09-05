import { describe, expect, it } from 'vitest';
import {
  isRepositoryRevisionScope,
  isSourceRange,
  isStableRepositoryIdentifier,
} from '@forexplore/contracts';

describe('code-intelligence query boundary contracts', () => {
  it('accepts only stable repository/revision identities, never filesystem paths', () => {
    expect(isStableRepositoryIdentifier('history-01.alpha')).toBe(true);
    expect(isRepositoryRevisionScope({
      repositoryId: 'history-01.alpha',
      analysisRevision: 'revision-20260904',
    })).toBe(true);

    expect(isStableRepositoryIdentifier('C:/repositories/history')).toBe(false);
    expect(isStableRepositoryIdentifier('../history')).toBe(false);
    expect(isRepositoryRevisionScope({
      repositoryId: 'history-01',
      analysisRevision: '../revision',
    })).toBe(false);
  });

  it('requires non-empty one-based, end-exclusive source ranges', () => {
    expect(isSourceRange({
      startLine: 4,
      startColumn: 3,
      endLine: 4,
      endColumn: 12,
    })).toBe(true);
    expect(isSourceRange({
      startLine: 4,
      startColumn: 3,
      endLine: 4,
      endColumn: 3,
    })).toBe(false);
    expect(isSourceRange({
      startLine: 0,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    })).toBe(false);
  });
});
