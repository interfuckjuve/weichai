import { describe, expect, it } from 'vitest';
import { discoverProjects, projectForPath } from './project-discovery.js';

describe('project discovery', () => {
  it('recognizes repository-relative build/package boundaries and C# project references', () => {
    const result = discoverProjects({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        { relativePath: 'java/pom.xml', content: '<project />' },
        { relativePath: 'gradle/build.gradle.kts', content: 'plugins {}' },
        { relativePath: 'dotnet/App/App.csproj', content: '<Project><ItemGroup><ProjectReference Include="../Core/Core.csproj" /></ItemGroup></Project>' },
        { relativePath: 'dotnet/Core/Core.csproj', content: '<Project />' },
        { relativePath: 'web/package.json', content: '{"name":"web"}' },
        { relativePath: 'python/pyproject.toml', content: '[project]\nname = "demo"' },
        { relativePath: 'go/go.mod', content: 'module example.com/demo' },
        { relativePath: 'rust/Cargo.toml', content: '[package]\nname = "demo"' },
      ],
    });

    expect(result.projects.map((project) => project.kind).sort()).toEqual([
      'cargo', 'dotnet', 'dotnet', 'go', 'gradle', 'maven', 'node', 'python',
    ]);
    expect(result.projects.every((project) =>
      project.repositoryId === 'history-one' && project.analysisRevision === 'revision-a',
    )).toBe(true);
    expect(result.projectReferences).toEqual([
      expect.objectContaining({
        sourceRelativePath: 'dotnet/App/App.csproj',
        targetReference: '../Core/Core.csproj',
      }),
    ]);
  });

  it('selects the deepest language-compatible boundary for a file', () => {
    const result = discoverProjects({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        { relativePath: 'package.json', content: '{}' },
        { relativePath: 'packages/widget/package.json', content: '{}' },
      ],
    });
    const project = projectForPath(result.projects, 'packages/widget/src/View.ts', 'typescript');
    expect(project?.relativePath).toBe('packages/widget');
    expect(projectForPath(result.projects, 'packages/widget/src/View.py', 'python')).toBeUndefined();
  });

  it('retains explicit local build/package references for every v1 project ecosystem', () => {
    const result = discoverProjects({
      repositoryId: 'history-one',
      analysisRevision: 'revision-a',
      files: [
        { relativePath: 'maven/pom.xml', content: '<project><modules><module>core</module></modules></project>' },
        { relativePath: 'maven/core/pom.xml', content: '<project />' },
        { relativePath: 'gradle/settings.gradle.kts', content: 'include(\":core\")' },
        { relativePath: 'gradle/core/build.gradle.kts', content: 'plugins {}' },
        { relativePath: 'node/app/package.json', content: '{"dependencies":{"@demo/core":"workspace:*","other":"file:../other"}}' },
        { relativePath: 'node/core/package.json', content: '{"name":"@demo/core"}' },
        { relativePath: 'node/other/package.json', content: '{"name":"other"}' },
        { relativePath: 'cargo/app/Cargo.toml', content: '[dependencies]\ncore = { path = "../core" }' },
        { relativePath: 'cargo/core/Cargo.toml', content: '[package]\nname = "core"' },
        { relativePath: 'go/app/go.mod', content: 'module demo/app\nreplace demo/core => ../core' },
        { relativePath: 'go/core/go.mod', content: 'module demo/core' },
        { relativePath: 'python/app/pyproject.toml', content: '[tool.poetry.dependencies]\ncore = { path = "../core" }' },
        { relativePath: 'python/core/pyproject.toml', content: '[project]\nname = "core"' },
      ],
    });

    const pairs = result.projectReferences.map((reference) =>
      `${reference.sourceRelativePath}->${reference.targetReference}`,
    );
    expect(pairs).toEqual(expect.arrayContaining([
      'maven/pom.xml->core/pom.xml',
      'gradle/settings.gradle.kts->core/build.gradle.kts',
      'node/app/package.json->../core/package.json',
      'node/app/package.json->../other/package.json',
      'cargo/app/Cargo.toml->../core/Cargo.toml',
      'go/app/go.mod->../core/go.mod',
      'python/app/pyproject.toml->../core/pyproject.toml',
    ]));
  });
});
