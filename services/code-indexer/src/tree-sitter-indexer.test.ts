import { describe, expect, it } from 'vitest';
import { createDefaultLanguageRegistry } from './language-registry.js';
import { indexTreeSitterFile } from './tree-sitter-indexer.js';

const samples: ReadonlyArray<{
  expectedImport: string;
  expectedName: string;
  languageId: string;
  path: string;
  source: string;
}> = [
  {
    languageId: 'java',
    path: 'src/Foo.java',
    expectedName: 'Foo',
    expectedImport: 'sample.contract.Contract',
    source: [
      'package sample.app;',
      'import sample.contract.Contract;',
      'public class Foo implements Contract { public void run() {} }',
    ].join('\n'),
  },
  {
    languageId: 'csharp',
    path: 'src/Foo.cs',
    expectedName: 'Foo',
    expectedImport: 'Demo.Contract',
    source: [
      'using Demo.Contract;',
      'namespace Demo.App;',
      'public class Foo { public void Run() {} }',
    ].join('\n'),
  },
  {
    languageId: 'typescript',
    path: 'src/Foo.ts',
    expectedName: 'Foo',
    expectedImport: './contract',
    source: 'import { Contract } from "./contract"; export class Foo { run(value: Contract): void {} }',
  },
  {
    languageId: 'javascript',
    path: 'src/Foo.js',
    expectedName: 'Foo',
    expectedImport: './contract',
    source: 'import { Contract } from "./contract"; export class Foo { run(value) {} }',
  },
  {
    languageId: 'python',
    path: 'src/foo.py',
    expectedName: 'Foo',
    expectedImport: 'sample.contract',
    source: 'from sample.contract import Contract\nclass Foo(Contract):\n  def run(self):\n    pass\n',
  },
  {
    languageId: 'go',
    path: 'src/foo.go',
    expectedName: 'Foo',
    expectedImport: 'example.com/contract',
    source: 'package sample\nimport "example.com/contract"\ntype Foo struct{}\nfunc (f Foo) Run() {}',
  },
  {
    languageId: 'rust',
    path: 'src/foo.rs',
    expectedName: 'Foo',
    expectedImport: 'crate::contract::Contract',
    source: 'use crate::contract::Contract;\npub struct Foo;\nimpl Foo { pub fn run(&self, _: Contract) {} }',
  },
];

describe('Tree-sitter structural indexer', () => {
  it('indexes declarations and explicit import/export syntax for every registered v1 grammar', () => {
    const registry = createDefaultLanguageRegistry();
    expect(registry.describe().map((entry) => entry.languageId)).toEqual([
      'arkts', 'c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'kotlin', 'python', 'rust', 'typescript',
    ]);

    for (const sample of samples) {
      const language = registry.resolvePath(sample.path);
      expect(language?.languageId).toBe(sample.languageId);
      if (!language) throw new Error(`No grammar registered for ${sample.path}`);
      const result = indexTreeSitterFile({
        content: sample.source,
        language,
        relativePath: sample.path,
      });
      const declaration = result.declarations.find((entry) => entry.name === sample.expectedName);
      expect(declaration).toMatchObject({
        relativePath: sample.path,
        name: sample.expectedName,
      });
      expect(declaration?.sourceRange.endLine).toBeGreaterThanOrEqual(declaration?.sourceRange.startLine ?? 0);
      expect(declaration?.symbolKey).toMatch(/^symbol:/);
      expect(declaration?.astDeclarationId).toMatch(/^ast:/);
      expect(result.imports.map((entry) => entry.targetReference)).toContain(sample.expectedImport);
    }
  });

  it('uses the TSX grammar while preserving the TypeScript language identity', () => {
    const language = createDefaultLanguageRegistry().resolvePath('src/View.tsx');
    expect(language?.languageId).toBe('typescript');
    if (!language) throw new Error('TSX grammar missing');
    const result = indexTreeSitterFile({
      content: 'export const View = () => <main>Hello</main>;',
      language,
      relativePath: 'src/View.tsx',
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('indexes exported JavaScript and TypeScript lexical bindings as declarations', () => {
    const registry = createDefaultLanguageRegistry();
    for (const [relativePath, languageId] of [
      ['src/runtime.ts', 'typescript'],
      ['src/runtime.js', 'javascript'],
    ] as const) {
      const language = registry.resolvePath(relativePath);
      expect(language?.languageId).toBe(languageId);
      if (!language) throw new Error(`Missing grammar for ${relativePath}`);
      const result = indexTreeSitterFile({
        content: 'export const run = () => 1;',
        language,
        relativePath,
      });
      expect(result.declarations).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'run', isExported: true }),
      ]));
      expect(result.declarations.find((entry) => entry.name === 'run')?.isExported).toBe(true);
      expect(result.exports).toEqual(expect.arrayContaining([
        expect.objectContaining({ exportKind: 'declaration', targetReference: 'run' }),
      ]));
    }
  });

  it('retains syntax errors as diagnostics instead of rejecting the whole file', () => {
    const language = createDefaultLanguageRegistry().resolvePath('src/Broken.ts');
    if (!language) throw new Error('TypeScript grammar missing');
    const result = indexTreeSitterFile({
      content: 'export const = ;',
      language,
      relativePath: 'src/Broken.ts',
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TREE_SITTER_PARSE_ERROR', relativePath: 'src/Broken.ts' }),
    ]));
  });
});
