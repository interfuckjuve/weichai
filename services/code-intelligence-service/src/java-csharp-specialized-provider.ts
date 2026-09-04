import type {
  DefinitionLocation,
  FindDefinitionRequest,
  FindReferencesRequest,
  ReferenceLocation,
  RepositoryRevisionScope,
  RepositoryStaticAnalysis,
  SemanticEvidenceResult,
  SourceRange,
  StaticSourceRange,
  StaticSymbol,
  SymbolRecord,
} from '@forexplore/contracts';
import {
  compilerConfirmedSemanticEdges,
  verifyCompilerProbeAnalysis,
} from '@forexplore/code-indexer';
import type { IndexStore } from './index-store.js';
import type { SemanticProvider } from './semantic-query-service.js';

export interface JavaCsharpSpecializedBinding extends RepositoryRevisionScope {
  /** Must equal the code-intelligence structural revision hash at registration time. */
  analysisHash: string;
  /** Host-verified legacy Java/C# compiler-probe snapshot. */
  analysis: RepositoryStaticAnalysis;
}

function scopeKey(scope: RepositoryRevisionScope): string {
  return `${scope.repositoryId}\u0000${scope.analysisRevision}`;
}

function toRange(value: StaticSourceRange): SourceRange {
  const startLine = Math.max(1, value.startLine);
  const startColumn = Math.max(1, value.startColumn ?? 1);
  const endLine = Math.max(startLine, value.endLine ?? startLine);
  const endColumn = Math.max(
    endLine === startLine ? startColumn + 1 : 1,
    value.endColumn ?? (endLine === startLine ? startColumn + 1 : 1),
  );
  return { startLine, startColumn, endLine, endColumn };
}

function overlaps(left: SourceRange, right: SourceRange): boolean {
  const point = (line: number, column: number): [number, number] => [line, column];
  const less = (a: [number, number], b: [number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  return less(point(left.startLine, left.startColumn), point(right.endLine, right.endColumn))
    && less(point(right.startLine, right.startColumn), point(left.endLine, left.endColumn));
}

function matchingStructuralSymbol(
  symbol: StaticSymbol | undefined,
  symbols: readonly SymbolRecord[],
): SymbolRecord | undefined {
  if (!symbol) return undefined;
  const exact = symbols.find((candidate) =>
    candidate.relativePath === symbol.path &&
    candidate.qualifiedName === symbol.qualifiedName,
  );
  return exact ?? symbols.find((candidate) =>
    candidate.relativePath === symbol.path && candidate.name === symbol.name,
  );
}

function semanticEdges(analysis: RepositoryStaticAnalysis) {
  return compilerConfirmedSemanticEdges(analysis);
}

/**
 * Read-only bridge for existing Java/C# compiler probes. It emits results only
 * for compiler-confirmed legacy edges and only after a host binds that legacy
 * snapshot to the same code-intelligence analysis hash. Tree-sitter facts can
 * never be upgraded by this adapter.
 */
export class JavaCsharpSpecializedProvider implements SemanticProvider {
  readonly provider = 'java-csharp-specialized' as const;
  readonly supportedLanguageIds = ['java', 'csharp'] as const;
  readonly #bindings = new Map<string, JavaCsharpSpecializedBinding>();

  constructor(private readonly store: IndexStore) {}

  async register(binding: JavaCsharpSpecializedBinding): Promise<void> {
    const analysis = verifyCompilerProbeAnalysis(binding.analysis);
    const index = await this.store.getStructuralIndex(binding);
    if (!index || index.analysisHash !== binding.analysisHash) {
      throw new Error('Java/C# specialized evidence must bind to the matching completed structural analysis hash.');
    }
    if (semanticEdges(analysis).length === 0) {
      throw new Error('Java/C# specialized binding contains no compiler-confirmed semantic edges.');
    }
    this.#bindings.set(scopeKey(binding), { ...binding, analysis });
  }

  unregister(scope: RepositoryRevisionScope): void {
    this.#bindings.delete(scopeKey(scope));
  }

  async isAvailable(scope: RepositoryRevisionScope): Promise<{ available: boolean; reason?: string }> {
    return this.#bindings.has(scopeKey(scope))
      ? { available: true }
      : { available: false, reason: 'No compiler-confirmed Java/C# semantic binding is registered for this revision.' };
  }

  async findDefinition(
    request: FindDefinitionRequest,
  ): Promise<Array<SemanticEvidenceResult<DefinitionLocation>>> {
    const binding = this.#bindings.get(scopeKey(request));
    if (!binding) return [];
    const index = await this.store.getStructuralIndex(request);
    if (!index || index.analysisHash !== binding.analysisHash) return [];
    const symbolsById = new Map(binding.analysis.symbols.map((symbol) => [symbol.id, symbol]));
    const referenceRange = request.sourceRange;
    const results: Array<SemanticEvidenceResult<DefinitionLocation>> = [];
    for (const edge of semanticEdges(binding.analysis)) {
      if (edge.sourcePath !== request.relativePath || !edge.targetSymbolId) continue;
      if (!edge.evidenceRanges.some((range) => overlaps(toRange(range), referenceRange))) continue;
      const target = matchingStructuralSymbol(symbolsById.get(edge.targetSymbolId), index.symbols);
      if (!target) continue;
      results.push({
        repositoryId: request.repositoryId,
        analysisRevision: request.analysisRevision,
        evidenceId: `java-csharp:${binding.analysis.snapshotId}:${edge.id}`,
        provider: 'java-csharp-specialized',
        confidence: 1,
        evidenceLevel: 'semantic',
        relativePath: target.relativePath,
        sourceRange: target.sourceRange,
        value: { symbol: target },
      });
    }
    return dedupe(results);
  }

  async findReferences(
    request: FindReferencesRequest,
  ): Promise<Array<SemanticEvidenceResult<ReferenceLocation>>> {
    const binding = this.#bindings.get(scopeKey(request));
    if (!binding) return [];
    const index = await this.store.getStructuralIndex(request);
    if (!index || index.analysisHash !== binding.analysisHash) return [];
    const target = index.symbols.find((symbol) => symbol.symbolKey === request.symbolKey);
    if (!target) return [];
    const legacyTargets = binding.analysis.symbols.filter((symbol) =>
      matchingStructuralSymbol(symbol, [target]) !== undefined,
    );
    const targetIds = new Set(legacyTargets.map((symbol) => symbol.id));
    const results: Array<SemanticEvidenceResult<ReferenceLocation>> = [];
    for (const edge of semanticEdges(binding.analysis)) {
      if (!edge.targetSymbolId || !targetIds.has(edge.targetSymbolId)) continue;
      for (const range of edge.evidenceRanges) {
        results.push({
          repositoryId: request.repositoryId,
          analysisRevision: request.analysisRevision,
          evidenceId: `java-csharp:${binding.analysis.snapshotId}:${edge.id}:${range.path}:${range.startLine}:${range.startColumn ?? 1}`,
          provider: 'java-csharp-specialized',
          confidence: 1,
          evidenceLevel: 'semantic',
          relativePath: edge.sourcePath,
          sourceRange: toRange(range),
          value: {
            symbolKey: target.symbolKey,
            relativePath: edge.sourcePath,
            sourceRange: toRange(range),
            referenceKind: edge.kind,
          },
        });
      }
    }
    return dedupe(results);
  }
}

function dedupe<T>(values: Array<SemanticEvidenceResult<T>>): Array<SemanticEvidenceResult<T>> {
  const records = new Map(values.map((value) => [value.evidenceId, value]));
  return [...records.values()].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

export const javaCsharpSpecializedInternals = {
  matchingStructuralSymbol,
  overlaps,
  semanticEdges,
  toRange,
};
