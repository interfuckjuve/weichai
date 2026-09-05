import { describe, expect, it } from 'vitest';
import { buildStructuralIndex } from '@forexplore/code-indexer';
import { projectPlanHash } from './project-analysis.js';
import type { StructuralIndex } from '@forexplore/contracts';

const original = [
  { relativePath: 'package.json', content: '{"name":"incremental-fixture"}' },
  { relativePath: 'src/policy.ts', content: 'export function expiresAt(now: number, ttl: number) { return now + ttl; }' },
  { relativePath: 'src/cache.ts', content: 'import { expiresAt } from "./policy"; export function deadline() { return expiresAt(10, 20); }' },
];

function canonicalIndex(index: StructuralIndex): string {
  return projectPlanHash({ ...index,
    projects: [...index.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)),
    files: [...index.files].sort((a, b) => a.fileId.localeCompare(b.fileId)),
    symbols: [...index.symbols].sort((a, b) => a.symbolId.localeCompare(b.symbolId)),
    dependencyEdges: [...index.dependencyEdges].sort((a, b) => a.dependencyEdgeId.localeCompare(b.dependencyEdgeId)),
    diagnostics: [...index.diagnostics].sort((a, b) => a.diagnosticId.localeCompare(b.diagnosticId)),
  });
}

describe('incremental structural equivalence', () => {
  it.each([
    { name: 'method body', files: original.map((file) => file.relativePath.endsWith('policy.ts') ? { ...file, content: file.content.replace('now + ttl', 'now + Math.max(0, ttl)') } : file) },
    { name: 'public signature', files: original.map((file) => file.relativePath.endsWith('policy.ts') ? { ...file, content: file.content.replace('ttl: number)', 'ttl: number, skew = 0)') } : file) },
    { name: 'added source', files: [...original, { relativePath: 'src/clock.ts', content: 'export function clock() { return Date.now(); }' }] },
    { name: 'deleted dependency endpoint', files: original.filter((file) => !file.relativePath.endsWith('policy.ts')) },
    { name: 'renamed dependency endpoint', files: original.map((file) => file.relativePath.endsWith('policy.ts') ? { ...file, relativePath: 'src/expiry.ts' }
      : { ...file, content: file.content.replace('./policy', './expiry') }) },
    { name: 'changed package configuration', files: original.map((file) => file.relativePath === 'package.json' ? { ...file, content: '{"name":"changed","type":"module"}' } : file) },
    { name: 'new nested project boundary', files: [...original, { relativePath: 'src/package.json', content: '{"name":"nested"}' }] },
  ])('matches a full rebuild after $name', ({ files }) => {
    const previous = buildStructuralIndex({ repositoryId: 'fixture', analysisRevision: 'before', files: original }).index;
    const request = { repositoryId: 'fixture', analysisRevision: 'after', files };
    const incremental = buildStructuralIndex({ ...request, previousIndex: previous });
    const full = buildStructuralIndex(request);
    expect(canonicalIndex(incremental.index)).toBe(canonicalIndex(full.index));
    expect([...incremental.sourceFiles]).toEqual([...full.sourceFiles]);
    expect(incremental.stats.reparsedFileCount).toBeLessThanOrEqual(full.stats.reparsedFileCount);
  });
});
