import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessRepositoryImplementations,
  createDefaultRepositoryImplementationDetectorRegistry,
  RepositoryImplementationDetectorRegistry,
} from './implementation-assessment.js';
import { analyzeRepository } from './repository-analysis.js';
import { bridgeRepositoryStaticAnalysis } from './repository-ingestion-bridge.js';

const roots: string[] = [];

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'forexplore-target-assessment-'));
  roots.push(root);
  return root;
}

async function writeSource(root: string, relativePath: string, source: string): Promise<void> {
  const target = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, source, 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('assessRepositoryImplementations', () => {
  it('covers every Java/C# callable without treating static evidence as business correctness', async () => {
    const root = await createRepository();
    await writeSource(root, 'dotnet/Worker.cs', [
      'namespace Target;',
      'public interface IWorker {',
      '  void Declared();',
      '}',
      'public abstract class BaseWorker {',
      '  public abstract void Pending();',
      '}',
      'public class Worker {',
      '  public Worker() { Initialize(); }',
      '  public void Ready() { Console.WriteLine("NotImplementedException"); }',
      '  public void Stub() { throw new NotImplementedException(); }',
      '  public int Placeholder() { return 0; }',
      '  public void Empty() {}',
      '  public void Todo() { /* TODO: add retry */ Console.WriteLine("now"); }',
      '  public void LegalFailure() { throw new InvalidOperationException(); }',
      '  public int Expression() => 42;',
      '  private void Initialize() { Console.WriteLine("ready"); }',
      '}',
    ].join('\n'));
    await writeSource(root, 'java/Service.java', [
      'package target;',
      'public class Service {',
      '  public void Stub() { throw new UnsupportedOperationException("TODO"); }',
      '  public void LegalFailure() { throw new UnsupportedOperationException("read only"); }',
      '  public void Ready() { System.out.println("ok"); }',
      '}',
    ].join('\n'));

    const analysis = await analyzeRepository({ root });
    const bridge = bridgeRepositoryStaticAnalysis(analysis);
    const drafts = await assessRepositoryImplementations({
      root,
      analysis,
      ir: bridge.unifiedIr,
    });
    const symbols = new Map(analysis.symbols.map((symbol) => [symbol.id, symbol]));
    const by = (language: string, name: string) => drafts.find((draft) => {
      const symbol = symbols.get(draft.entityId);
      return symbol?.language === language && symbol.name === name;
    });

    expect(drafts).toHaveLength(bridge.unifiedIr.entities.filter((entity) => entity.kind === 'callable').length);
    expect(by('csharp', 'Ready')).toMatchObject({
      state: 'implemented',
      basis: 'syntactic-body',
    });
    expect(by('csharp', 'Stub')).toMatchObject({
      state: 'unimplemented',
      basis: 'explicit-stub',
    });
    expect(by('csharp', 'Placeholder')).toMatchObject({ state: 'partial' });
    expect(by('csharp', 'Empty')).toMatchObject({
      state: 'unknown',
      reasonCodes: ['EMPTY_BODY_AMBIGUOUS'],
    });
    expect(by('csharp', 'Todo')).toMatchObject({ state: 'partial' });
    expect(by('csharp', 'LegalFailure')).toMatchObject({ state: 'implemented' });
    expect(by('csharp', 'Expression')).toMatchObject({ state: 'implemented' });
    expect(by('csharp', 'Declared')).toMatchObject({ state: 'not-applicable' });
    expect(by('csharp', 'Pending')).toMatchObject({ state: 'not-applicable' });
    expect(by('java', 'Stub')).toMatchObject({ state: 'unimplemented' });
    expect(by('java', 'LegalFailure')).toMatchObject({ state: 'implemented' });
    expect(drafts.every((draft) =>
      draft.bodyHash || draft.state === 'unknown' || draft.basis === 'declaration-only',
    )).toBe(true);
  }, 30_000);

  it('fails closed when source bytes change after the 01A analysis snapshot', async () => {
    const root = await createRepository();
    await writeSource(root, 'Worker.cs', 'public class Worker { public void Run() {} }\n');
    const analysis = await analyzeRepository({ root });
    const bridge = bridgeRepositoryStaticAnalysis(analysis);
    await writeSource(root, 'Worker.cs', 'public class Worker { public void Run() { return; } }\n');

    await expect(assessRepositoryImplementations({
      root,
      analysis,
      ir: bridge.unifiedIr,
    })).rejects.toThrow(/changed after static analysis/i);
  });

  it('keeps missing detector capability explicit and allows a registered detector to own body evidence', async () => {
    const root = await createRepository();
    await writeSource(root, 'worker.ts', 'export function run(): void { throw new Error("TODO"); }\n');
    const analysis = await analyzeRepository({ root });
    const bridge = bridgeRepositoryStaticAnalysis(analysis);
    const unsupported = await assessRepositoryImplementations({
      root,
      analysis,
      ir: bridge.unifiedIr,
      detectorRegistry: new RepositoryImplementationDetectorRegistry(),
    });
    expect(unsupported).toEqual([
      expect.objectContaining({
        state: 'unknown',
        reasonCodes: ['IMPLEMENTATION_DETECTOR_UNAVAILABLE'],
      }),
    ]);

    const registry = new RepositoryImplementationDetectorRegistry([{
      descriptor: {
        id: 'test.typescript',
        version: '1.0.0',
        languageId: 'typescript',
        capability: {
          bodyIsolation: 'brace-balanced',
          commentAndLiteralMasking: 'typescript-template-aware',
          declarationForms: ['top-level-function'],
          failClosed: true,
        },
        quality: {
          level: 'language-aware-lexical-heuristic',
          provesBehavioralCorrectness: false,
          limitations: ['test detector'],
        },
      },
      detect: ({ fileSource }) => ({
        state: 'partial',
        basis: 'heuristic',
        reasonCodes: ['TEST_PROVIDER'],
        bodyHash: createHash('sha256').update(fileSource).digest('hex'),
      }),
    }]);
    const detected = await assessRepositoryImplementations({
      root,
      analysis,
      ir: bridge.unifiedIr,
      detectorRegistry: registry,
    });
    expect(detected).toEqual([
      expect.objectContaining({
        state: 'partial',
        reasonCodes: ['TEST_PROVIDER'],
        bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    const missingBodyEvidence = new RepositoryImplementationDetectorRegistry([{
      descriptor: {
        ...registry.descriptors()[0]!,
        id: 'test.typescript.missing-body-evidence',
      },
      detect: () => ({
        state: 'implemented',
        basis: 'syntactic-body',
        reasonCodes: ['CLAIM_WITHOUT_BODY_HASH'],
      }),
    }]);
    const failedClosed = await assessRepositoryImplementations({
      root,
      analysis,
      ir: bridge.unifiedIr,
      detectorRegistry: missingBodyEvidence,
    });
    expect(failedClosed).toEqual([
      expect.objectContaining({
        state: 'unknown',
        basis: 'unavailable',
        reasonCodes: ['CALLABLE_BODY_ISOLATION_UNAVAILABLE'],
      }),
    ]);
  });

  it('detects Python top-level functions with indentation, comments, and triple-quoted literals', async () => {
    const root = await createRepository();
    await writeSource(root, 'src/worker.py', [
      'def ready(value: int) -> str:',
      '    marker = """This is data, not a # TODO and not a fake dedent:',
      'def imaginary(): pass',
      '"""',
      '    return f"{value}:{marker}"',
      '',
      'def stub():',
      '    """Documented but deliberately unavailable."""',
      '    # explanation only',
      '    raise NotImplementedError("later")',
      '',
      'def partial():',
      '    # TODO: choose the real fallback',
      '    return 0',
      '',
      'def empty():',
      '    """Documentation is not executable implementation evidence."""',
    ].join('\n'));
    const analysis = await analyzeRepository({ root });
    const bridge = bridgeRepositoryStaticAnalysis(analysis);
    const drafts = await assessRepositoryImplementations({ root, analysis, ir: bridge.unifiedIr });
    const symbols = new Map(analysis.symbols.map((symbol) => [symbol.id, symbol]));
    const byName = (name: string) => drafts.find((draft) => symbols.get(draft.entityId)?.name === name);

    expect(byName('ready')).toMatchObject({
      state: 'implemented',
      basis: 'syntactic-body',
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(byName('stub')).toMatchObject({
      state: 'unimplemented',
      reasonCodes: ['PYTHON_EXPLICIT_NOT_IMPLEMENTED_STUB'],
    });
    expect(byName('partial')).toMatchObject({
      state: 'partial',
      reasonCodes: ['TODO_MARKER_PRESENT'],
    });
    expect(byName('empty')).toMatchObject({
      state: 'unknown',
      reasonCodes: ['EMPTY_BODY_AMBIGUOUS'],
    });
  });

  it('publishes fail-closed detector capability and masks TypeScript template literals', async () => {
    const registry = createDefaultRepositoryImplementationDetectorRegistry();
    expect(registry.descriptors().map((descriptor) => descriptor.languageId)).toEqual([
      'csharp',
      'go',
      'java',
      'python',
      'rust',
      'typescript',
    ]);
    const typescript = registry.descriptors().find((descriptor) => descriptor.languageId === 'typescript');
    expect(typescript).toMatchObject({
      capability: {
        bodyIsolation: 'brace-balanced',
        commentAndLiteralMasking: 'typescript-template-aware',
        failClosed: true,
      },
      quality: {
        level: 'language-aware-lexical-heuristic',
        provesBehavioralCorrectness: false,
      },
    });

    const root = await createRepository();
    await writeSource(root, 'src/worker.ts', [
      'export function render(value: string): string {',
      '  const template = `literal } // TODO ${value}`;',
      '  return template;',
      '}',
    ].join('\n'));
    await writeSource(root, 'src/worker.go', [
      'package worker',
      'func Pending() int {',
      '  panic("not implemented")',
      '}',
    ].join('\n'));
    await writeSource(root, 'src/worker.rs', [
      'pub fn pending() -> usize {',
      '    todo!()',
      '}',
    ].join('\n'));
    const analysis = await analyzeRepository({ root });
    const bridge = bridgeRepositoryStaticAnalysis(analysis);
    const drafts = await assessRepositoryImplementations({ root, analysis, ir: bridge.unifiedIr });
    const symbols = new Map(analysis.symbols.map((symbol) => [symbol.id, symbol]));
    const byLanguage = (language: string) => drafts.find(
      (draft) => symbols.get(draft.entityId)?.language === language,
    );
    expect(byLanguage('typescript')).toMatchObject({
      state: 'implemented',
      reasonCodes: ['NON_EMPTY_SYNTACTIC_BODY'],
      bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(byLanguage('go')).toMatchObject({
      state: 'unimplemented',
      reasonCodes: ['GO_EXPLICIT_NOT_IMPLEMENTED_PANIC'],
    });
    expect(byLanguage('rust')).toMatchObject({
      state: 'unimplemented',
      reasonCodes: ['RUST_EXPLICIT_NOT_IMPLEMENTED_MACRO'],
    });
  });
});
