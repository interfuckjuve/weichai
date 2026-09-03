import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeRepository,
  createGenericRepositoryLanguageAdapter,
  readRepositoryAnalysisArtifact,
  RepositoryLanguageRegistry,
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
  it('records Java and C# visibility, callable shapes, and declaring containers', async () => {
    const root = await createRepository();
    await writeSource(root, 'java/Outer.java', [
      'package sample;',
      'public class Outer {',
      '  protected class Inner {',
      '    private String secret;',
      '    public int compute(String value, int count) { return count; }',
      '  }',
      '  void packageMethod() {}',
      '}',
    ].join('\n'));
    await writeSource(root, 'dotnet/Worker.cs', [
      'namespace Demo;',
      'public interface IWorker {',
      '  int Missing(string input);',
      '}',
      'public abstract class BaseWorker {',
      '  public abstract void Pending();',
      '}',
      'internal class Worker {',
      '  public Worker() {}',
      '  public string Name { get; set; }',
      '  protected int Run(string input, int count) { return count; }',
      '  public int Expression() => 1;',
      '  private class Nested {}',
      '}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root });
    const symbol = (language: string, name: string, kind?: string) => analysis.symbols.find(
      (entry) => entry.language === language && entry.name === name && (!kind || entry.kind === kind),
    );
    const outer = symbol('java', 'Outer', 'class');
    const inner = symbol('java', 'Inner', 'class');
    const secret = symbol('java', 'secret', 'field');
    const compute = symbol('java', 'compute', 'method');
    const packageMethod = symbol('java', 'packageMethod', 'method');
    const worker = symbol('csharp', 'Worker', 'class');
    const nested = symbol('csharp', 'Nested', 'class');
    const run = symbol('csharp', 'Run', 'method');
    const constructor = symbol('csharp', 'Worker', 'constructor');
    const expression = symbol('csharp', 'Expression', 'method');
    const missing = symbol('csharp', 'Missing', 'method');
    const pending = symbol('csharp', 'Pending', 'method');
    const property = symbol('csharp', 'Name', 'property');

    expect(outer).toEqual(expect.objectContaining({ visibility: 'public' }));
    expect(inner).toEqual(expect.objectContaining({
      qualifiedName: 'sample.Outer.Inner',
      visibility: 'protected',
      containerSymbolId: outer?.id,
    }));
    expect(secret).toEqual(expect.objectContaining({
      visibility: 'private',
      containerSymbolId: inner?.id,
      returnShape: 'String',
    }));
    expect(compute).toEqual(expect.objectContaining({
      visibility: 'public',
      containerSymbolId: inner?.id,
      parameters: [
        { name: 'value', type: 'String', required: true },
        { name: 'count', type: 'int', required: true },
      ],
      returnShape: 'int',
    }));
    expect(packageMethod).toEqual(expect.objectContaining({ visibility: 'package' }));
    expect(worker).toEqual(expect.objectContaining({ visibility: 'internal' }));
    expect(nested).toEqual(expect.objectContaining({
      qualifiedName: 'Demo.Worker.Nested',
      visibility: 'private',
      containerSymbolId: worker?.id,
    }));
    expect(run).toEqual(expect.objectContaining({
      visibility: 'protected',
      containerSymbolId: worker?.id,
      returnShape: 'int',
    }));
    expect(constructor).toEqual(expect.objectContaining({
      visibility: 'public',
      containerSymbolId: worker?.id,
    }));
    expect(expression).toEqual(expect.objectContaining({
      visibility: 'public',
      containerSymbolId: worker?.id,
      returnShape: 'int',
    }));
    expect(missing).toEqual(expect.objectContaining({
      visibility: 'public',
      signature: 'int Missing(string input)',
    }));
    expect(pending).toEqual(expect.objectContaining({
      visibility: 'public',
      signature: 'public abstract void Pending()',
    }));
    expect(property).toEqual(expect.objectContaining({
      visibility: 'public',
      containerSymbolId: worker?.id,
      returnShape: 'string',
    }));
  });

  it('uses explicit built-in export rules and leaves an unknown custom language unknown', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/api.ts', [
      'export class PublicType {}',
      'function localFunction(): void {}',
    ].join('\n'));
    await writeSource(root, 'src/lib.rs', [
      'pub struct PublicRecord {}',
      'fn local_rust() {}',
    ].join('\n'));
    await writeSource(root, 'src/api.go', [
      'package api',
      'func Exported() {}',
      'func localGo() {}',
    ].join('\n'));
    await writeSource(root, 'src/api.py', [
      'def visible():',
      '    pass',
      'def _private():',
      '    pass',
    ].join('\n'));
    await writeSource(root, 'src/api.acme', 'class CustomType {}\n');
    const registry = new RepositoryLanguageRegistry([
      createGenericRepositoryLanguageAdapter({ languageId: 'typescript', fileExtensions: ['.ts'] }),
      createGenericRepositoryLanguageAdapter({ languageId: 'rust', fileExtensions: ['.rs'] }),
      createGenericRepositoryLanguageAdapter({ languageId: 'go', fileExtensions: ['.go'] }),
      createGenericRepositoryLanguageAdapter({ languageId: 'python', fileExtensions: ['.py'] }),
      createGenericRepositoryLanguageAdapter({ languageId: 'acme', fileExtensions: ['.acme'] }),
    ]);

    const analysis = await analyzeRepository({ root, languageRegistry: registry });
    const byName = (name: string) => analysis.symbols.find((symbol) => symbol.name === name);

    expect(byName('PublicType')?.exported).toBe(true);
    expect(byName('localFunction')?.exported).toBe(false);
    expect(byName('PublicRecord')?.exported).toBe(true);
    expect(byName('local_rust')?.exported).toBe(false);
    expect(byName('Exported')?.exported).toBe(true);
    expect(byName('localGo')?.exported).toBe(false);
    expect(byName('visible')?.exported).toBe(true);
    expect(byName('_private')?.exported).toBe(false);
    expect(byName('CustomType')).toEqual(expect.objectContaining({ visibility: 'unknown' }));
    expect(byName('CustomType')?.exported).toBeUndefined();
    expect(analysis.analysisAdapters?.find((adapter) => adapter.languageId === 'acme')?.capabilities)
      .not.toContain('api-surface');
  });

  it('normalizes and fingerprints the registered adapter set in analyzer identity', async () => {
    const firstRegistry = new RepositoryLanguageRegistry([
      createGenericRepositoryLanguageAdapter({
        id: 'acme.adapter:a',
        version: '2.0.0',
        languageId: 'acme-a',
        fileExtensions: ['.A'],
      }),
      createGenericRepositoryLanguageAdapter({
        id: 'acme.adapter:b',
        version: '3.0.0',
        languageId: 'acme-b',
        fileExtensions: ['.b'],
      }),
    ]);
    const secondRegistry = new RepositoryLanguageRegistry([
      createGenericRepositoryLanguageAdapter({
        id: 'acme.adapter:b',
        version: '3.0.0',
        languageId: 'acme-b',
        fileExtensions: ['.b'],
      }),
      createGenericRepositoryLanguageAdapter({
        id: 'acme.adapter:a',
        version: '2.0.0',
        languageId: 'acme-a',
        fileExtensions: ['.a'],
      }),
    ]);
    expect(firstRegistry.descriptors()).toEqual(secondRegistry.descriptors());
    expect(firstRegistry.fingerprint()).toBe(secondRegistry.fingerprint());

    const root = await createRepository();
    await writeSource(root, 'src/value.a', 'class Value {}\n');
    const first = await analyzeRepository({ root, languageRegistry: firstRegistry });
    const second = await analyzeRepository({ root, languageRegistry: secondRegistry });
    expect(first.analyzerVersion).toContain(`adapters-${firstRegistry.fingerprint().slice(0, 16)}`);
    expect(second.analyzerVersion).toBe(first.analyzerVersion);
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it('creates safe collision-resistant default adapter IDs for every open LanguageId', () => {
    const inputs = [
      { languageId: 'C#', fileExtensions: ['.legacy-cs'] },
      { languageId: 'vendor language/next', fileExtensions: ['.vendor-next'] },
      { languageId: '语言', fileExtensions: ['.unicode-language'] },
    ] as const;
    const first = inputs.map((input) => createGenericRepositoryLanguageAdapter(input).id);
    const second = inputs.map((input) => createGenericRepositoryLanguageAdapter(input).id);

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id))).toBe(true);
    expect(() => new RepositoryLanguageRegistry([
      createGenericRepositoryLanguageAdapter({
        id: 'unsafe/adapter',
        languageId: 'unsafe-explicit',
        fileExtensions: ['.unsafe-explicit'],
      }),
    ])).toThrow(/safe stable id/i);
  });

  it('keeps every contract language visible and reports generic-analysis boundaries', async () => {
    const root = await createRepository();
    await writeSource(root, 'typescript/checkout.ts', [
      'export class Checkout {}',
      'export function submit() {}',
    ].join('\n'));
    await writeSource(root, 'python/worker.py', [
      'class Worker:',
      '    pass',
      '',
      'def run():',
      '    pass',
    ].join('\n'));
    await writeSource(root, 'rust/ledger.rs', [
      'pub struct Ledger {}',
      'pub fn total() {}',
    ].join('\n'));
    await writeSource(root, 'go/server.go', [
      'package server',
      'type Server struct {}',
      'func Run() {}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root });

    expect(analysis.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'typescript/checkout.ts', language: 'typescript' }),
      expect.objectContaining({ path: 'python/worker.py', language: 'python' }),
      expect.objectContaining({ path: 'rust/ledger.rs', language: 'rust' }),
      expect.objectContaining({ path: 'go/server.go', language: 'go' }),
    ]));
    expect(analysis.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Checkout', language: 'typescript', kind: 'class' }),
      expect.objectContaining({ name: 'Worker', language: 'python', kind: 'class' }),
      expect.objectContaining({ name: 'Ledger', language: 'rust', kind: 'class' }),
      expect.objectContaining({ name: 'Server', language: 'go', kind: 'class' }),
    ]));
    expect(analysis.diagnostics.filter(
      (entry) => entry.code === 'GENERIC_LANGUAGE_STATIC_SLICE',
    ).map((entry) => entry.path).sort()).toEqual([
      'go/server.go',
      'python/worker.py',
      'rust/ledger.rs',
      'typescript/checkout.ts',
    ]);
  });

  it('accepts a runtime registry with a custom source extension', async () => {
    const root = await createRepository();
    await writeSource(root, 'ui/View.tsx', 'export class View {}');
    const languageRegistry = new RepositoryLanguageRegistry([
      createGenericRepositoryLanguageAdapter({
        languageId: 'typescript-react',
        fileExtensions: ['.tsx'],
      }),
    ]);
    expect(languageRegistry.adapterForLanguageId('typescript-react')?.languageId).toBe(
      'typescript-react',
    );

    const analysis = await analyzeRepository({ root, languageRegistry });

    expect(analysis.files).toEqual([
      expect.objectContaining({ path: 'ui/View.tsx', language: 'typescript-react' }),
    ]);
    expect(analysis.symbols).toEqual([
      expect.objectContaining({ name: 'View', language: 'typescript-react', kind: 'class' }),
    ]);
    expect(analysis.diagnostics).toEqual([
      expect.objectContaining({
        code: 'GENERIC_LANGUAGE_STATIC_SLICE',
        path: 'ui/View.tsx',
      }),
    ]);
  });

  it('preserves unregistered languages and non-source files in the baseline inventory', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Service.kt', 'class Service\n');
    await writeSource(root, 'README.md', '# Fixture\n');
    await writeSource(root, 'assets/logo.svg', '<svg/>\n');

    const analysis = await analyzeRepository({
      root,
      languageRegistry: new RepositoryLanguageRegistry(),
    });

    expect(analysis.files).toEqual([
      expect.objectContaining({ path: 'README.md', role: 'documentation' }),
      expect.objectContaining({ path: 'assets/logo.svg', role: 'asset' }),
      expect.objectContaining({ path: 'src/Service.kt', role: 'other' }),
    ]);
    expect(analysis.files.every((file) => file.language === undefined)).toBe(true);
    expect(analysis.symbols).toEqual([]);
    expect(analysis.diagnostics).toEqual([
      expect.objectContaining({
        code: 'UNCLASSIFIED_REPOSITORY_FILES',
        message: expect.stringContaining('3 repository file(s)'),
      }),
    ]);
  });

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

  it('records a stable Git remote identity without persisting embedded credentials', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/Service.ts', 'export class Service {}\n');
    await execFileAsync('git', ['init', '--quiet', root]);
    await execFileAsync('git', [
      '-C', root,
      'config',
      'remote.origin.url',
      'https://token-user:secret-token@Example.COM/org/repository.git?access_token=leak',
    ]);

    const analysis = await analyzeRepository({ root });

    expect(analysis.repository.remote).toBe('https://example.com/org/repository');
    expect(JSON.stringify(analysis.repository)).not.toMatch(/token-user|secret-token|access_token/);
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
