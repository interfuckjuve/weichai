import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeRepository,
  readRepositoryAnalysisArtifact,
  writeRepositoryAnalysisArtifact,
} from './repository-analysis.js';
import type { CompilerProbe } from './repository-analysis.js';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-static-analysis-'));
  temporaryRoots.push(root);
  return root;
}

async function writeSource(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function initializeTrackedDirtyGitRepository(root: string): Promise<void> {
  await execFileAsync('git', ['init', '--quiet', root]);
  await execFileAsync('git', ['-C', root, 'add', '.']);
}

async function supportsJdkCompilerApi(): Promise<boolean> {
  try {
    await Promise.all([
      execFileAsync('javac', ['-version']),
      execFileAsync('java', ['-version']),
    ]);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe('analyzeRepository', () => {
  it('rejects a tracked-dirty Git worktree unless a planning-only caller opts in', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'public class Service {}',
    ].join('\n'));
    await initializeTrackedDirtyGitRepository(root);

    await expect(analyzeRepository({ root })).rejects.toThrow(/tracked-dirty Git worktree/i);

    const planningAnalysis = await analyzeRepository({
      root,
      allowDirtyWorktreeForPlanning: true,
    });
    expect(planningAnalysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DIRTY_GIT_WORKTREE_PLANNING_ONLY' }),
    ]));
  });

  it('collects deterministic Java and C# syntactic dependency evidence without changing retrieval indexing', async () => {
    const root = await createRepository();
    await writeSource(root, 'java/shared/Contract.java', [
      'package sample.shared;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'java/core/Base.java', [
      'package sample.core;',
      'public class Base {}',
    ].join('\n'));
    await writeSource(root, 'java/core/Service.java', [
      'package sample.core;',
      'import sample.shared.Contract;',
      'public class Service extends Base implements Contract {',
      '  private Contract contract;',
      '}',
    ].join('\n'));
    await writeSource(root, 'dotnet/Shared/Shared.csproj', '<Project Sdk="Microsoft.NET.Sdk" />');
    await writeSource(root, 'dotnet/Shared/IContract.cs', [
      'namespace Demo.Shared;',
      'public interface IContract {}',
    ].join('\n'));
    await writeSource(root, 'dotnet/App/App.csproj', [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup>',
      '    <ProjectReference Include="../Shared/Shared.csproj" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n'));
    await writeSource(root, 'dotnet/App/Worker.cs', [
      'using Demo.Shared;',
      'namespace Demo.App;',
      'public sealed class Worker : IContract {',
      '  private IContract contract;',
      '}',
    ].join('\n'));
    await writeSource(root, 'dotnet/App/WorkerTests.cs', [
      'using Demo.App;',
      'namespace Demo.App.Tests;',
      'public sealed class WorkerTests {}',
    ].join('\n'));

    const first = await analyzeRepository({ root, createdAt: '2026-08-26T00:00:00.000Z' });
    const second = await analyzeRepository({ root, createdAt: '2026-08-26T00:00:00.000Z' });

    expect(second).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual([...first.files.map((file) => file.path)].sort());
    expect(first.files.find((file) => file.path === 'dotnet/App/WorkerTests.cs')?.role).toBe('test');
    expect(first.symbols.some((symbol) => symbol.qualifiedName === 'sample.core.Service')).toBe(true);
    expect(first.symbols.some((symbol) => symbol.qualifiedName === 'Demo.App.Worker')).toBe(true);
    expect(first.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePath: 'java/core/Service.java',
        targetPath: 'java/shared/Contract.java',
        kind: 'import',
        resolution: 'resolved',
        evidence: 'syntactic',
        internal: true,
      }),
      expect.objectContaining({
        sourcePath: 'java/core/Service.java',
        targetPath: 'java/core/Base.java',
        kind: 'inheritance',
        resolution: 'resolved',
      }),
      expect.objectContaining({
        sourcePath: 'java/core/Service.java',
        targetPath: 'java/shared/Contract.java',
        kind: 'implementation',
        resolution: 'resolved',
      }),
      expect.objectContaining({
        sourcePath: 'dotnet/App/App.csproj',
        targetPath: 'dotnet/Shared/Shared.csproj',
        kind: 'project-reference',
        resolution: 'resolved',
        internal: true,
      }),
      expect.objectContaining({
        sourcePath: 'dotnet/App/Worker.cs',
        targetPath: 'dotnet/Shared/IContract.cs',
        kind: 'import',
        resolution: 'resolved',
      }),
      expect.objectContaining({
        sourcePath: 'dotnet/App/Worker.cs',
        targetPath: 'dotnet/Shared/IContract.cs',
        kind: 'implementation',
        resolution: 'resolved',
      }),
      expect.objectContaining({
        sourcePath: 'dotnet/App/WorkerTests.cs',
        targetPath: 'dotnet/App/Worker.cs',
        kind: 'test-reference',
        resolution: 'resolved',
      }),
    ]));
    expect(first.dependencies.every((edge) => edge.snapshotId === first.snapshotId)).toBe(true);
    expect(first.dependencies.every((edge) => edge.evidence !== 'semantic')).toBe(true);

    const withoutTests = await analyzeRepository({ root, includeTests: false });
    expect(withoutTests.files.some((file) => file.role === 'test')).toBe(false);
    expect(withoutTests.dependencies.some((edge) => edge.kind === 'test-reference')).toBe(false);
  });

  it('keeps ambiguous internal references as blocking evidence rather than selecting a target', async () => {
    const root = await createRepository();
    await writeSource(root, 'one/User.java', [
      'package sample.one;',
      'public class User {}',
    ].join('\n'));
    await writeSource(root, 'two/User.java', [
      'package sample.two;',
      'public class User {}',
    ].join('\n'));
    await writeSource(root, 'core/Service.java', [
      'package sample.core;',
      'import sample.one.*;',
      'import sample.two.*;',
      'public class Service {',
      '  private User user;',
      '}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root });
    const ambiguous = analysis.dependencies.find(
      (edge) => edge.sourcePath === 'core/Service.java' && edge.targetReference === 'User',
    );

    expect(ambiguous).toMatchObject({
      kind: 'type-reference',
      internal: true,
      resolution: 'ambiguous',
      evidence: 'ambiguous',
    });
    expect(ambiguous?.targetPath).toBeUndefined();
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AMBIGUOUS_INTERNAL_REFERENCE', path: 'core/Service.java' }),
    ]));
  });

  it('collects invocation and member-access edges with method/member ownership', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Helper.java', [
      'package sample;',
      'public class Helper {',
      '  public int execute() { return 1; }',
      '  public int value;',
      '}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'public class Service {',
      '  private Helper helper;',
      '  public int run() {',
      '    helper.execute();',
      '    return helper.value;',
      '  }',
      '}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root });
    const invocation = analysis.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'invocation',
    );
    const memberAccess = analysis.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'member-access',
    );
    const helperMethod = analysis.symbols.find(
      (symbol) => symbol.path === 'src/Helper.java' && symbol.kind === 'method' && symbol.name === 'execute',
    );
    const helperField = analysis.symbols.find(
      (symbol) => symbol.path === 'src/Helper.java' && symbol.kind === 'field' && symbol.name === 'value',
    );
    const serviceMethod = analysis.symbols.find(
      (symbol) => symbol.path === 'src/Service.java' && symbol.kind === 'method' && symbol.name === 'run',
    );

    expect(invocation).toMatchObject({
      sourceSymbolId: serviceMethod?.id,
      targetPath: 'src/Helper.java',
      targetSymbolId: helperMethod?.id,
      targetReference: 'helper.execute',
      resolution: 'resolved',
      evidence: 'syntactic',
      internal: true,
    });
    expect(memberAccess).toMatchObject({
      sourceSymbolId: serviceMethod?.id,
      targetPath: 'src/Helper.java',
      targetSymbolId: helperField?.id,
      targetReference: 'helper.value',
      resolution: 'resolved',
      evidence: 'syntactic',
      internal: true,
    });
  });

  it('does not turn an unproven receiver-qualified member into a global simple-name dependency', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Target.java', [
      'package sample;',
      'public class Target { public void execute() {} }',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'public class Service {',
      '  public void run() { unknown.execute(); }',
      '}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root });
    const invocation = analysis.dependencies.find((edge) =>
      edge.sourcePath === 'src/Service.java' &&
      edge.kind === 'invocation' &&
      edge.targetReference === 'unknown.execute',
    );

    expect(invocation).toMatchObject({
      internal: true,
      resolution: 'unresolved',
      evidence: 'unresolved',
    });
    expect(invocation?.targetPath).toBeUndefined();
  });

  it('changes the snapshot when analysed content changes', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'public class Service {}',
    ].join('\n'));

    const before = await analyzeRepository({ root });
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'public class Service { public int Version() { return 2; } }',
    ].join('\n'));
    const after = await analyzeRepository({ root });

    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.snapshotId).not.toBe(before.snapshotId);
    expect(after.files[0]?.sha256).not.toBe(before.files[0]?.sha256);
  });

  it('does not bind a snapshot to an informational checkout root', async () => {
    const firstRoot = await createRepository();
    const secondRoot = await createRepository();
    const source = [
      'package sample;',
      'public class Service {}',
    ].join('\n');
    await writeSource(firstRoot, 'src/Service.java', source);
    await writeSource(secondRoot, 'src/Service.java', source);

    const first = await analyzeRepository({
      root: firstRoot,
      createdAt: '2026-08-26T00:00:00.000Z',
    });
    const second = await analyzeRepository({
      root: secondRoot,
      createdAt: '2026-08-26T00:00:00.000Z',
    });

    expect(first.repository.root).not.toBe(second.repository.root);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.snapshotId).toBe(second.snapshotId);
  });

  it('reuses an immutable analysis artifact when collection time is the only difference', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'public class Service {}',
    ].join('\n'));

    const first = await analyzeRepository({ root, createdAt: '2026-08-26T00:00:00.000Z' });
    const laterCollection = await analyzeRepository({ root, createdAt: '2026-08-26T01:00:00.000Z' });
    expect(laterCollection.snapshotId).toBe(first.snapshotId);

    const artifactPath = await writeRepositoryAnalysisArtifact(root, first);
    await expect(writeRepositoryAnalysisArtifact(root, laterCollection)).resolves.toBe(artifactPath);

    const persisted = JSON.parse(await readFile(artifactPath, 'utf8')) as { createdAt: string };
    expect(persisted.createdAt).toBe(first.createdAt);
  });

  it('rejects persisted artifacts whose symbols, edge evidence, or diagnostics are tampered', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root, createdAt: '2026-08-26T00:00:00.000Z' });
    const artifactPath = await writeRepositoryAnalysisArtifact(root, analysis);
    const original = await readFile(artifactPath, 'utf8');
    const symbol = analysis.symbols.find((entry) => entry.name === 'Service');
    const dependency = analysis.dependencies.find((entry) => entry.kind === 'import');
    const diagnostic = analysis.diagnostics[0];
    if (!symbol || !dependency || !diagnostic) {
      throw new Error('Expected fixture static evidence for tamper test.');
    }

    const tamperCases: Array<{
      mutate: (artifact: typeof analysis) => void;
      name: string;
    }> = [
      {
        name: 'symbol',
        mutate: (artifact) => {
          const target = artifact.symbols.find((entry) => entry.id === symbol.id);
          if (!target) throw new Error('Expected symbol in persisted artifact.');
          target.name = 'TamperedService';
        },
      },
      {
        name: 'dependency edge',
        mutate: (artifact) => {
          const target = artifact.dependencies.find((entry) => entry.id === dependency.id);
          if (!target) throw new Error('Expected dependency edge in persisted artifact.');
          target.evidence = target.evidence === 'semantic' ? 'syntactic' : 'semantic';
        },
      },
      {
        name: 'diagnostic',
        mutate: (artifact) => {
          const target = artifact.diagnostics.find((entry) => entry.id === diagnostic.id);
          if (!target) throw new Error('Expected diagnostic in persisted artifact.');
          target.message = `${target.message} tampered`;
        },
      },
    ];

    for (const tamper of tamperCases) {
      const altered = JSON.parse(original) as typeof analysis;
      tamper.mutate(altered);
      await writeFile(artifactPath, `${JSON.stringify(altered, null, 2)}\n`, 'utf8');
      await expect(readRepositoryAnalysisArtifact(root, analysis.snapshotId))
        .rejects
        .toThrow(/content hash/i);
    }
    await writeFile(artifactPath, original, 'utf8');
  });

  it('promotes only an exact compiler-confirmed binding and fingerprints semantic enrichment separately', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));

    const syntactic = await analyzeRepository({ root, createdAt: '2026-08-26T00:00:00.000Z' });
    const importEdge = syntactic.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'import',
    );
    if (!importEdge?.targetPath || !importEdge.evidenceRanges[0]) {
      throw new Error('Expected a resolved Java import edge in the fixture.');
    }

    const probe: CompilerProbe = {
      async probe(request) {
        expect(request.language).toBe('Java');
        expect(request.candidates).toEqual(expect.arrayContaining([
          expect.objectContaining({
            sourcePath: importEdge.sourcePath,
            targetPath: importEdge.targetPath,
            kind: importEdge.kind,
          }),
        ]));
        return {
          status: 'available',
          compiler: 'fixture-javac',
          bindings: [{
            sourcePath: importEdge.sourcePath,
            targetPath: importEdge.targetPath,
            kind: importEdge.kind,
            evidenceRange: importEdge.evidenceRanges[0],
            ...(importEdge.sourceSymbolId ? { sourceSymbolId: importEdge.sourceSymbolId } : {}),
            ...(importEdge.targetSymbolId ? { targetSymbolId: importEdge.targetSymbolId } : {}),
          }],
        };
      },
    };

    const enriched = await analyzeRepository({
      root,
      compilerProbe: probe,
      createdAt: '2026-08-26T00:00:00.000Z',
    });
    const semanticImport = enriched.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'import',
    );
    const implementation = enriched.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'implementation',
    );

    expect(semanticImport?.evidence).toBe('semantic');
    expect(implementation?.evidence).toBe('syntactic');
    expect(enriched.snapshotId).not.toBe(syntactic.snapshotId);
    expect(enriched.analyzerVersion).toContain('+compiler-probe');
    expect(enriched.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SEMANTIC_BINDINGS_APPLIED' }),
      expect.objectContaining({ code: 'COMPILER_SEMANTIC_ENRICHMENT_APPLIED' }),
    ]));
  });

  it('uses the JDK Compiler API to confirm real Java bindings when semantic enrichment is enabled', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root, semanticEnrichment: true });
    const importEdge = analysis.dependencies.find((edge) =>
      edge.sourcePath === 'src/Service.java' && edge.kind === 'import',
    );
    const implementationEdge = analysis.dependencies.find((edge) =>
      edge.sourcePath === 'src/Service.java' && edge.kind === 'implementation',
    );

    if (!await supportsJdkCompilerApi()) {
      expect(importEdge?.evidence).toBe('syntactic');
      expect(analysis.diagnostics.some((diagnostic) =>
        diagnostic.code === 'JAVA_COMPILER_UNAVAILABLE' || diagnostic.code === 'JAVA_RUNTIME_UNAVAILABLE',
      )).toBe(true);
      return;
    }
    expect(importEdge?.evidence).toBe('semantic');
    expect(implementationEdge?.evidence).toBe('semantic');
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SEMANTIC_BINDINGS_APPLIED' }),
      expect.objectContaining({ code: 'COMPILER_SEMANTIC_ENRICHMENT_APPLIED' }),
      expect.objectContaining({ code: 'JAVA_SEMANTIC_TOOLCHAIN' }),
    ]));
  });

  it('uses the JDK Compiler API for Java invocation and member-access bindings', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Helper.java', [
      'package sample;',
      'public class Helper {',
      '  public int execute() { return 1; }',
      '  public int value;',
      '}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'public class Service {',
      '  private Helper helper;',
      '  public int run() {',
      '    helper.execute();',
      '    return helper.value;',
      '  }',
      '}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root, semanticEnrichment: true });
    const invocation = analysis.dependencies.find((edge) =>
      edge.sourcePath === 'src/Service.java' && edge.kind === 'invocation',
    );
    const memberAccess = analysis.dependencies.find((edge) =>
      edge.sourcePath === 'src/Service.java' && edge.kind === 'member-access',
    );

    if (!await supportsJdkCompilerApi()) {
      expect(invocation?.evidence).toBe('syntactic');
      expect(memberAccess?.evidence).toBe('syntactic');
      return;
    }
    expect(invocation?.evidence).toBe('semantic');
    expect(memberAccess?.evidence).toBe('semantic');
  });

  it('preserves syntactic evidence and records a diagnostic when a compiler is unavailable', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));

    const unavailableProbe: CompilerProbe = {
      async probe() {
        return { status: 'unavailable' };
      },
    };
    const analysis = await analyzeRepository({ root, compilerProbe: unavailableProbe });

    expect(analysis.dependencies.some((edge) => edge.evidence === 'semantic')).toBe(false);
    expect(analysis.dependencies.some((edge) => edge.kind === 'import' && edge.evidence === 'syntactic')).toBe(true);
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'JAVA_COMPILER_UNAVAILABLE' }),
      expect.objectContaining({ code: 'SYNTACTIC_ANALYSIS_ONLY' }),
    ]));
  });

  it('allows a C# MSBuild adapter to confirm an existing project-reference edge', async () => {
    const root = await createRepository();
    await writeSource(root, 'Shared/Shared.csproj', '<Project Sdk="Microsoft.NET.Sdk" />');
    await writeSource(root, 'App/App.csproj', [
      '<Project Sdk="Microsoft.NET.Sdk">',
      '  <ItemGroup>',
      '    <ProjectReference Include="../Shared/Shared.csproj" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n'));

    const syntactic = await analyzeRepository({ root });
    const projectReference = syntactic.dependencies.find((edge) => edge.kind === 'project-reference');
    if (!projectReference?.targetPath || !projectReference.evidenceRanges[0]) {
      throw new Error('Expected a resolved C# project reference edge in the fixture.');
    }
    const probe: CompilerProbe = {
      async probe(request) {
        expect(request.language).toBe('C#');
        return {
          status: 'available',
          compiler: 'fixture-msbuild',
          bindings: [{
            sourcePath: projectReference.sourcePath,
            targetPath: projectReference.targetPath,
            kind: 'project-reference',
            evidenceRange: projectReference.evidenceRanges[0],
          }],
        };
      },
    };

    const analysis = await analyzeRepository({ root, compilerProbe: probe });
    expect(analysis.dependencies.find((edge) => edge.kind === 'project-reference')?.evidence).toBe('semantic');
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SEMANTIC_BINDINGS_APPLIED' }),
    ]));
  });

  it('rejects a compiler binding that does not exactly prove an existing syntactic edge', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));

    const syntactic = await analyzeRepository({ root });
    const importEdge = syntactic.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'import',
    );
    if (!importEdge?.targetPath || !importEdge.evidenceRanges[0]) {
      throw new Error('Expected a resolved Java import edge in the fixture.');
    }
    const incorrectRange = {
      ...importEdge.evidenceRanges[0],
      startLine: importEdge.evidenceRanges[0].startLine + 1,
    };
    const probe: CompilerProbe = {
      async probe() {
        return {
          status: 'available',
          bindings: [{
            sourcePath: importEdge.sourcePath,
            targetPath: importEdge.targetPath,
            kind: importEdge.kind,
            evidenceRange: incorrectRange,
          }],
        };
      },
    };

    const analysis = await analyzeRepository({ root, compilerProbe: probe });
    expect(analysis.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'import',
    )?.evidence).toBe('syntactic');
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SEMANTIC_BINDING_REJECTED' }),
    ]));
  });

  it('requires a compiler binding to retain the resolved target symbol identity', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Contract.java', [
      'package sample;',
      'public interface Contract {}',
    ].join('\n'));
    await writeSource(root, 'src/Service.java', [
      'package sample;',
      'import sample.Contract;',
      'public class Service implements Contract {}',
    ].join('\n'));

    const syntactic = await analyzeRepository({ root });
    const importEdge = syntactic.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'import',
    );
    if (!importEdge?.targetPath || !importEdge.evidenceRanges[0]) {
      throw new Error('Expected a resolved Java import edge in the fixture.');
    }
    const probe: CompilerProbe = {
      async probe() {
        return {
          status: 'available',
          bindings: [{
            sourcePath: importEdge.sourcePath,
            targetPath: importEdge.targetPath,
            kind: importEdge.kind,
            evidenceRange: importEdge.evidenceRanges[0],
          }],
        };
      },
    };

    const analysis = await analyzeRepository({ root, compilerProbe: probe });
    expect(analysis.dependencies.find(
      (edge) => edge.sourcePath === 'src/Service.java' && edge.kind === 'import',
    )?.evidence).toBe('syntactic');
    expect(analysis.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SEMANTIC_BINDING_REJECTED' }),
    ]));
  });
});
