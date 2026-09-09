import { describe, expect, it } from 'vitest';
import { buildStructuralIndex } from '@forexplore/code-indexer';
import { buildProjectModuleProposal } from './module-modeling.js';
import { projectAnalysisObjective, projectPlanHash, validateProjectResult } from './project-analysis.js';

function model(files: Array<{ relativePath: string; content: string }>, limit = 8) {
  const index = buildStructuralIndex({ repositoryId: 'repository', analysisRevision: 'revision', files }).index;
  const project = index.projects.find((value) => value.relativePath === '') ?? index.projects[0]!;
  const scope = { repositoryId: index.repositoryId, analysisRevision: index.analysisRevision, projectId: project.projectId };
  const proposal = buildProjectModuleProposal(index, scope, projectAnalysisObjective, limit);
  const evidenceIds = [...proposal.modules.flatMap((module) => module.evidenceIds),
    ...(proposal.dependencies ?? []).flatMap((edge) => edge.evidenceIds)];
  const coverage = validateProjectResult(index, scope, { proposal, evidence: {
    ...scope, analysisHash: index.analysisHash, planHash: projectPlanHash(proposal), evidenceIds,
  } });
  return { index, proposal, coverage };
}

describe('offline module modeling', () => {
  it('partitions a flat directory with exact ownership and a bounded module size', () => {
    const files = [{ relativePath: 'package.json', content: '{"name":"large-flat-project"}' },
      ...Array.from({ length: 37 }, (_, i) => ({ relativePath: `src/item-${String(i).padStart(2, '0')}.ts`, content: `export function item${i}() { return ${i}; }` }))];
    const { proposal, coverage } = model(files);
    expect(coverage).toMatchObject({ total: 38, assigned: 38, unassigned: [] });
    expect(proposal.modules.every((module) => module.sourceFiles.length <= 8)).toBe(true);
    expect(proposal.modules.filter((module) => module.kind === 'feature')).toHaveLength(5);
    expect(model([...files].reverse()).proposal).toEqual(proposal);
  });

  it('uses resolved dependency affinity while preserving test and configuration boundaries', () => {
    const { proposal } = model([
      { relativePath: 'package.json', content: '{"name":"dependency-project"}' },
      { relativePath: 'src/api/index.ts', content: 'import { store } from "../storage/index"; export function upload() { return store(); }' },
      { relativePath: 'src/storage/index.ts', content: 'export function store() { return 1; }' },
      { relativePath: 'src/tests/upload.test.ts', content: 'import { upload } from "../api/index"; export function testUpload() { return upload(); }' },
      { relativePath: 'src/unrelated/index.ts', content: 'export function unrelated() { return false; }' },
    ]);
    const upload = proposal.modules.find((module) => module.sourceFiles.includes('src/api/index.ts'))!;
    expect(upload.sourceFiles).toContain('src/storage/index.ts');
    expect(upload.sourceFiles).not.toContain('src/tests/upload.test.ts');
    expect(upload.sourceFiles).not.toContain('src/unrelated/index.ts');
    const test = proposal.modules.find((module) => module.sourceFiles.includes('src/tests/upload.test.ts'))!;
    expect(test.dependsOn).toContain(upload.id);
    expect(proposal.dependencies?.some((edge) => edge.moduleId === test.id && edge.dependsOnModuleId === upload.id && edge.evidenceIds.length)).toBe(true);
  });

  it('does not turn unresolved imports into module dependencies', () => {
    const { proposal } = model([
      { relativePath: 'package.json', content: '{"name":"missing-dependency"}' },
      { relativePath: 'src/a/index.ts', content: 'import { absent } from "./missing"; export function run() { return absent(); }' },
      { relativePath: 'src/b/index.ts', content: 'export function missing() {}' },
    ]);
    expect(proposal.dependencies).toEqual([]);
    expect(proposal.risks?.join(' ')).toContain('unresolved');
  });
});
