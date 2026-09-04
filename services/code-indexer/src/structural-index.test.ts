import { describe, expect, it } from 'vitest';
import { buildStructuralIndex } from './structural-index.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

const files = [
  {
    relativePath: 'java/common/Alpha.java',
    content: 'package demo.common; public class Alpha {}',
  },
  {
    relativePath: 'java/common/Beta.java',
    content: 'package demo.common; public class Beta {}',
  },
  {
    relativePath: 'java/app/Service.java',
    content: 'package demo.app; import demo.common.*; public class Service {}',
  },
  {
    relativePath: 'ts/src/entry.ts',
    content: 'import { Missing } from "./missing"; export function run(): void {}',
  },
  {
    relativePath: 'dotnet/App/App.csproj',
    content: '<Project><ItemGroup><ProjectReference Include="../Core/Core.csproj" /></ItemGroup></Project>',
  },
  {
    relativePath: 'dotnet/Core/Core.csproj',
    content: '<Project />',
  },
  {
    relativePath: 'dotnet/App/Worker.cs',
    content: 'namespace Demo.App; public class Worker {}',
  },
  { relativePath: 'ts/package.json', content: '{"name":"ts"}' },
];

function build(analysisRevision: string) {
  return buildStructuralIndex({
    repositoryId: 'history-one',
    analysisRevision,
    files,
    changedPaths: ['ts/src/entry.ts', 'ts/src/entry.ts'],
  });
}

describe('buildStructuralIndex', () => {
  it('creates a revision-scoped structural index and retains exact scanned source text', () => {
    const result = build('revision-a');
    expect(result.index).toMatchObject({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
    });
    expect(result.sourceFiles.get('ts/src/entry.ts')).toContain('Missing');
    expect(result.changedPaths).toEqual(files.map((file) => file.relativePath).sort());
    expect(result.index.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'dotnet/App/App.csproj', role: 'configuration', parseStatus: 'unsupported' }),
      expect.objectContaining({ relativePath: 'ts/src/entry.ts', languageId: 'typescript', parseStatus: 'parsed' }),
    ]));
    expect(result.index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ qualifiedName: 'demo.common.Alpha', provider: 'tree-sitter', evidenceLevel: 'structural' }),
      expect.objectContaining({ name: 'run', languageId: 'typescript' }),
    ]));
  });

  it('keeps uncertain import evidence and resolves explicit project references without guessing', () => {
    const result = build('revision-a').index;
    expect(result.dependencyEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceRelativePath: 'java/app/Service.java',
        targetReference: 'demo.common.*',
        resolution: 'ambiguous',
        evidenceLevel: 'ambiguous',
      }),
      expect.objectContaining({
        sourceRelativePath: 'ts/src/entry.ts',
        targetReference: './missing',
        internal: true,
        resolution: 'unresolved',
        evidenceLevel: 'unresolved',
      }),
      expect.objectContaining({
        sourceRelativePath: 'dotnet/App/App.csproj',
        targetRelativePath: 'dotnet/Core/Core.csproj',
        kind: 'project-reference',
        resolution: 'resolved',
      }),
      expect.objectContaining({
        sourceRelativePath: 'ts/src/entry.ts',
        kind: 'export',
        targetReference: 'run',
        resolution: 'resolved',
      }),
    ]));
  });

  it('retains an absolute project reference as external unresolved evidence', () => {
    const result = buildStructuralIndex({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        {
          relativePath: 'dotnet/App/App.csproj',
          content: '<Project><ItemGroup><ProjectReference Include="C:\\outside\\Other.csproj" /></ItemGroup></Project>',
        },
      ],
    }).index;

    expect(result.dependencyEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'project-reference',
        sourceRelativePath: 'dotnet/App/App.csproj',
        targetReference: 'C:/outside/Other.csproj',
        internal: false,
        resolution: 'unresolved',
        evidenceLevel: 'unresolved',
      }),
    ]));
  });

  it('keeps the content analysis hash stable across revision identifiers', () => {
    expect(build('revision-a').index.analysisHash).toBe(build('revision-b').index.analysisHash);
    expect(build('revision-a').index.files[0]?.fileId).not.toBe(build('revision-b').index.files[0]?.fileId);
  });

  it('reuses unchanged file evidence and only reparses an affected source file', () => {
    const parsedPaths: string[] = [];
    const indexFile = (request: Parameters<typeof indexTreeSitterFile>[0]) => {
      parsedPaths.push(request.relativePath);
      return indexTreeSitterFile(request);
    };
    const first = buildStructuralIndex({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files,
      indexFile,
    });
    expect(parsedPaths).toHaveLength(5);

    parsedPaths.length = 0;
    const updatedFiles = files.map((file) => file.relativePath === 'ts/src/entry.ts'
      ? { ...file, content: 'import { Missing } from "./missing"; export function runNext(): void {}' }
      : file);
    const second = buildStructuralIndex({
      repositoryId: 'history-one',
      analysisRevision: 'revision-b',
      files: updatedFiles,
      changedPaths: ['ts/src/entry.ts'],
      previousIndex: first.index,
      indexFile,
    });

    expect(parsedPaths).toEqual(['ts/src/entry.ts']);
    expect(second.changedPaths).toEqual(['ts/src/entry.ts']);
    expect(second.stats).toMatchObject({
      changedFileCount: 1,
      reparsedFileCount: 1,
      reusedFileCount: files.length - 1,
    });
    expect(second.stats.reusedDependencyEdgeCount).toBeGreaterThan(0);
    expect(second.index.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({
        analysisRevision: 'revision-b',
        qualifiedName: 'demo.common.Alpha',
      }),
    ]));
  });

  it('drops stale dependency evidence when a changed source replaces an import', () => {
    const first = buildStructuralIndex({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        { relativePath: 'src/entry.ts', content: 'import { oldValue } from "./old"; export { oldValue };' },
        { relativePath: 'src/old.ts', content: 'export const oldValue = 1;' },
        { relativePath: 'src/new.ts', content: 'export const newValue = 2;' },
      ],
    });
    const second = buildStructuralIndex({
      repositoryId: 'history-one',
      analysisRevision: 'revision-b',
      previousIndex: first.index,
      changedPaths: ['src/entry.ts'],
      files: [
        { relativePath: 'src/entry.ts', content: 'import { newValue } from "./new"; export { newValue };' },
        { relativePath: 'src/old.ts', content: 'export const oldValue = 1;' },
        { relativePath: 'src/new.ts', content: 'export const newValue = 2;' },
      ],
    });

    const imports = second.index.dependencyEdges.filter((edge) =>
      edge.kind === 'import' && edge.sourceRelativePath === 'src/entry.ts',
    );
    expect(imports.map((edge) => edge.targetReference)).toEqual(['./new']);
  });
});
