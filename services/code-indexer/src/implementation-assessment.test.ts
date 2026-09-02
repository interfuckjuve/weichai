import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assessRepositoryImplementations,
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

  it('keeps unsupported languages explicit and allows a registered detector', async () => {
    const root = await createRepository();
    await writeSource(root, 'worker.ts', 'export function run(): void { throw new Error("TODO"); }\n');
    const analysis = await analyzeRepository({ root });
    const bridge = bridgeRepositoryStaticAnalysis(analysis);
    const unsupported = await assessRepositoryImplementations({ root, analysis, ir: bridge.unifiedIr });
    expect(unsupported).toEqual([
      expect.objectContaining({
        state: 'unknown',
        reasonCodes: ['IMPLEMENTATION_DETECTOR_UNAVAILABLE'],
      }),
    ]);

    const registry = new RepositoryImplementationDetectorRegistry([{
      descriptor: { id: 'test.typescript', version: '1.0.0', languageId: 'typescript' },
      detect: () => ({
        state: 'partial',
        basis: 'heuristic',
        reasonCodes: ['TEST_PROVIDER'],
      }),
    }]);
    const detected = await assessRepositoryImplementations({
      root,
      analysis,
      ir: bridge.unifiedIr,
      detectorRegistry: registry,
    });
    // Generic declaration slicing has no end range, so the host retains an
    // explicit unknown instead of letting a detector invent body evidence.
    expect(detected).toEqual([
      expect.objectContaining({
        state: 'unknown',
        reasonCodes: ['CALLABLE_RANGE_INCOMPLETE'],
      }),
    ]);
  });
});
