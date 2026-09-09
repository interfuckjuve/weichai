import { describe, expect, it } from 'vitest';
import type { ModuleArtifactRecord, ProjectAnalysisRecord, ProjectModule, StructuralIndex } from '@forexplore/contracts';
import { projectPlanHash } from './project-analysis.js';
import { seekDbProjectionInternals } from './seekdb-projection.js';

const index = { repositoryId: 'repo', analysisRevision: 'revision', analysisHash: 'hash' } as StructuralIndex;
const leaf: ProjectModule = { id: 'leaf', name: 'Upload parser', kind: 'feature', description: 'Multipart parsing',
  sourceFiles: ['src/parser.ts'], symbolKeys: [], dependsOn: [], evidenceIds: ['project:project'] };
function artifact(modules: ProjectModule[]): ModuleArtifactRecord {
  const proposal = { ...index, objective: 'inspect', summary: 'Upload', modules };
  const record: ProjectAnalysisRecord = { ...index, projectId: 'project', state: 'ready', projection: 'ready', analysisProfile: 'test',
    updatedAt: '2026-09-08', proposal, planHash: projectPlanHash(proposal) };
  return { ...index, moduleArtifactId: 'summary', kind: 'module-summary', status: 'current', planHash: record.planHash,
    contentHash: 'content', createdAt: '2026-09-08', updatedAt: '2026-09-08', payload: record };
}

describe('hierarchical summary projection', () => {
  it('indexes parent and leaf views with independent node kind and depth metadata', () => {
    const modules: ProjectModule[] = [{ ...leaf, id: 'parent', name: 'Upload subsystem', nodeKind: 'subsystem', parentId: null, sourceFiles: [] },
      { ...leaf, nodeKind: 'module', parentId: 'parent' }];
    const stored = artifact(modules);
    const hash = projectPlanHash((stored.payload as ProjectAnalysisRecord).proposal);
    const documents = seekDbProjectionInternals.summaryDocuments(index, stored, index.analysisRevision);
    expect(documents).toHaveLength(6);
    expect(new Set(documents.map((document) => document.searchDocumentId)).size).toBe(6);
    const parent = documents.filter((document) => JSON.parse(document.text).moduleId === 'parent');
    expect(parent).toHaveLength(3);
    expect(parent.every((document) => document.kind === 'summary' && JSON.parse(document.text).nodeKind === 'subsystem' && JSON.parse(document.text).depth === 0)).toBe(true);
    expect(JSON.parse(parent.find((document) => JSON.parse(document.text).view === 'dependency')!.text).sourceFiles).toEqual(['src/parser.ts']);
    expect(documents.filter((document) => JSON.parse(document.text).moduleId === 'leaf').every((document) => JSON.parse(document.text).depth === 1)).toBe(true);
    expect(modules[0]!.sourceFiles).toEqual([]);
    expect(projectPlanHash((stored.payload as ProjectAnalysisRecord).proposal)).toBe(hash);
  });

  it('keeps legacy flat identities and bounds ancestor source samples', () => {
    const legacy = seekDbProjectionInternals.summaryDocuments(index, artifact([leaf]), index.analysisRevision);
    expect(legacy).toHaveLength(3);
    expect(legacy[0]!.searchDocumentId).toBe(seekDbProjectionInternals.documentId(index, 'summary', 'summary\0leaf'));
    expect(JSON.parse(legacy[0]!.text)).toMatchObject({ nodeKind: 'module', depth: 0, parentId: null });
    const parent = { ...leaf, id: 'parent', nodeKind: 'subsystem' as const, sourceFiles: [] };
    const child = { ...leaf, parentId: 'parent', sourceFiles: Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`) };
    const documents = seekDbProjectionInternals.summaryDocuments(index, artifact([parent, child]), index.analysisRevision);
    const dependency = documents.map((document) => JSON.parse(document.text)).find((document) => document.moduleId === 'parent' && document.view === 'dependency');
    expect(dependency.sourceFiles).toHaveLength(20);
    expect(dependency.sourceFilesTruncated).toBe(true);
  });

  it('rejects malformed hierarchy and never projects a stale revision', () => {
    expect(() => seekDbProjectionInternals.summaryDocuments(index, artifact([{ ...leaf, parentId: 'missing' }]), index.analysisRevision)).toThrow('parent');
    expect(seekDbProjectionInternals.summaryDocuments(index, artifact([leaf]), 'new-revision')).toEqual([]);
  });
});
