import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  EntityImplementationAssessmentDraft,
  ImplementationAssessmentBasis,
  ImplementationDetector,
  ImplementationState,
  RepositoryEvidenceRef,
  RepositoryIRFile,
  RepositoryIREntity,
  RepositoryStaticAnalysis,
  StaticSourceRange,
  StaticSymbol,
  UnifiedRepositoryIR,
} from '@forexplore/contracts';

export const implementationAssessmentDetectorVersion = '1.0.0';

export interface RepositoryImplementationDetectionInput {
  entity: RepositoryIREntity;
  file: RepositoryIRFile;
  symbol: StaticSymbol;
  /** Exact source range represented by `symbol.range`. */
  source: string;
  /** Source with comments and literals masked while offsets are preserved. */
  maskedSource: string;
  owner?: StaticSymbol;
}

export interface RepositoryImplementationDetectionResult {
  state: ImplementationState;
  basis: ImplementationAssessmentBasis;
  reasonCodes: string[];
}

/**
 * Open language seam for static implementation evidence. Supporting repository
 * analysis for a language does not imply that a detector exists for it.
 */
export interface RepositoryImplementationDetector {
  descriptor: ImplementationDetector & { languageId: string };
  detect(input: RepositoryImplementationDetectionInput): RepositoryImplementationDetectionResult;
}

export class RepositoryImplementationDetectorRegistry {
  private readonly byLanguage = new Map<string, RepositoryImplementationDetector>();

  constructor(detectors: readonly RepositoryImplementationDetector[] = []) {
    for (const detector of detectors) this.register(detector);
  }

  register(detector: RepositoryImplementationDetector): void {
    const languageId = canonicalLanguage(detector.descriptor.languageId);
    if (!languageId || !detector.descriptor.id.trim() || !detector.descriptor.version.trim()) {
      throw new Error('Implementation detector requires stable id, version, and languageId.');
    }
    if (this.byLanguage.has(languageId)) {
      throw new Error(`Implementation detector is already registered for ${languageId}.`);
    }
    this.byLanguage.set(languageId, detector);
  }

  detectorFor(languageId: string): RepositoryImplementationDetector | undefined {
    return this.byLanguage.get(canonicalLanguage(languageId));
  }

  descriptors(): ImplementationDetector[] {
    return [...this.byLanguage.values()]
      .map((detector) => ({ ...detector.descriptor }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export interface AssessRepositoryImplementationsRequest {
  root: string;
  analysis: RepositoryStaticAnalysis;
  ir: UnifiedRepositoryIR;
  detectorRegistry?: RepositoryImplementationDetectorRegistry;
}

/**
 * Produces exactly one draft for every callable in the supplied IR. The caller
 * must bind these drafts to IR/catalog lineage through workflow-core before
 * exposing rollups. Source bytes are re-hashed first so stale worktree state
 * cannot masquerade as evidence for the immutable analysis snapshot.
 */
export async function assessRepositoryImplementations(
  request: AssessRepositoryImplementationsRequest,
): Promise<EntityImplementationAssessmentDraft[]> {
  assertAnalysisLineage(request.analysis, request.ir);
  const root = path.resolve(request.root);
  if (
    request.analysis.repository.root !== undefined &&
    path.resolve(request.analysis.repository.root) !== root
  ) {
    throw new Error('Implementation assessment root does not match the static-analysis root.');
  }
  const registry = request.detectorRegistry ?? createDefaultRepositoryImplementationDetectorRegistry();
  const symbols = new Map(request.analysis.symbols.map((symbol) => [symbol.id, symbol]));
  const files = new Map(request.ir.files.map((file) => [file.id, file]));
  const analysisFiles = new Map(request.analysis.files.map((file) => [file.path, file]));
  const sourceCache = new Map<string, string>();
  const callables = request.ir.entities
    .filter((entity) => entity.kind === 'callable')
    .sort((left, right) => left.id.localeCompare(right.id));
  const drafts: EntityImplementationAssessmentDraft[] = [];

  for (const entity of callables) {
    const symbol = symbols.get(entity.id);
    const file = entity.fileId ? files.get(entity.fileId) : undefined;
    if (!symbol || !file) {
      drafts.push(unavailableDraft(entity, file, symbol, 'CALLABLE_SOURCE_UNAVAILABLE'));
      continue;
    }
    const analysisFile = analysisFiles.get(file.path);
    if (!analysisFile || analysisFile.sha256 !== file.contentHash) {
      throw new Error(`IR/static-analysis file lineage mismatch: ${file.path}`);
    }
    let fileSource = sourceCache.get(file.path);
    if (fileSource === undefined) {
      fileSource = await readSnapshotFile(root, file.path, file.contentHash);
      sourceCache.set(file.path, fileSource);
    }
    const source = sourceForRange(fileSource, symbol.range);
    const bodySource = source === undefined ? undefined : isolatedBodySource(source);
    const owner = symbol.containerSymbolId
      ? symbols.get(symbol.containerSymbolId)
      : undefined;
    const detector = registry.detectorFor(entity.languageId ?? symbol.language);
    const evidenceRefs = evidenceFor(entity, file, symbol.range);

    if (file.role === 'test' || entity.testOnly === true || symbol.testOnly === true) {
      drafts.push({
        entityId: entity.id,
        fileId: file.id,
        ...(bodySource === undefined ? {} : { bodyHash: sha256(bodySource) }),
        state: 'not-applicable',
        basis: 'unavailable',
        reasonCodes: ['TEST_CALLABLE_EXCLUDED'],
        evidenceRefs,
        detector: detector?.descriptor ?? unavailableDetector(entity.languageId ?? symbol.language),
      });
      continue;
    }
    if (file.role === 'generated' || file.generated === true) {
      drafts.push({
        entityId: entity.id,
        fileId: file.id,
        ...(bodySource === undefined ? {} : { bodyHash: sha256(bodySource) }),
        state: 'not-applicable',
        basis: 'unavailable',
        reasonCodes: ['GENERATED_CALLABLE_EXCLUDED'],
        evidenceRefs,
        detector: detector?.descriptor ?? unavailableDetector(entity.languageId ?? symbol.language),
      });
      continue;
    }
    if (!detector) {
      drafts.push({
        entityId: entity.id,
        fileId: file.id,
        ...(bodySource === undefined ? {} : { bodyHash: sha256(bodySource) }),
        state: 'unknown',
        basis: 'unavailable',
        reasonCodes: ['IMPLEMENTATION_DETECTOR_UNAVAILABLE'],
        evidenceRefs,
        detector: unavailableDetector(entity.languageId ?? symbol.language),
      });
      continue;
    }
    if (source === undefined) {
      drafts.push({
        entityId: entity.id,
        fileId: file.id,
        state: 'unknown',
        basis: 'unavailable',
        reasonCodes: ['CALLABLE_RANGE_INCOMPLETE'],
        evidenceRefs,
        detector: detector.descriptor,
      });
      continue;
    }
    const result = detector.detect({
      entity,
      file,
      symbol,
      source,
      maskedSource: maskCommentsAndLiterals(source),
      owner,
    });
    drafts.push({
      entityId: entity.id,
      fileId: file.id,
      ...(bodySource === undefined ? {} : { bodyHash: sha256(bodySource) }),
      state: result.state,
      basis: result.basis,
      reasonCodes: sortedUnique(result.reasonCodes),
      evidenceRefs,
      detector: detector.descriptor,
    });
  }
  if (drafts.length !== callables.length) {
    throw new Error('Implementation assessment did not cover every callable entity.');
  }
  return drafts;
}

export function createDefaultRepositoryImplementationDetectorRegistry(): RepositoryImplementationDetectorRegistry {
  return new RepositoryImplementationDetectorRegistry([
    createJavaOrCsharpDetector('java'),
    createJavaOrCsharpDetector('csharp'),
  ]);
}

function createJavaOrCsharpDetector(languageId: 'java' | 'csharp'): RepositoryImplementationDetector {
  return {
    descriptor: {
      id: `forexplore.implementation.${languageId}.syntax`,
      version: implementationAssessmentDetectorVersion,
      languageId,
    },
    detect(input) {
      return detectJavaOrCsharp(input, languageId);
    },
  };
}

function detectJavaOrCsharp(
  input: RepositoryImplementationDetectionInput,
  languageId: 'java' | 'csharp',
): RepositoryImplementationDetectionResult {
  const masked = input.maskedSource.trim();
  const original = input.source.trim();
  const signature = input.symbol.signature ?? '';
  const declarationOnly = masked.endsWith(';') && !masked.includes('=>') && !masked.includes('{');
  if (declarationOnly) {
    const isContractDeclaration =
      input.owner?.kind === 'interface' ||
      /\b(?:abstract|extern|native)\b/.test(signature);
    return isContractDeclaration
      ? {
        state: 'not-applicable',
        basis: 'declaration-only',
        reasonCodes: ['CONTRACT_DECLARATION_WITHOUT_BODY'],
      }
      : {
        state: 'unknown',
        basis: 'declaration-only',
        reasonCodes: ['CALLABLE_DECLARATION_WITHOUT_BODY'],
      };
  }

  const executable = executableBody(masked);
  const originalExecutable = executableBody(original);
  if (languageId === 'csharp' && isSoleCsharpNotImplementedThrow(executable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['CSHARP_NOT_IMPLEMENTED_EXCEPTION'],
    };
  }
  if (languageId === 'java' && isSoleJavaExplicitStub(originalExecutable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['JAVA_EXPLICIT_NOT_IMPLEMENTED_THROW'],
    };
  }
  if (!executable.replace(/[{};\s]/g, '')) {
    return {
      state: 'unknown',
      basis: 'heuristic',
      reasonCodes: ['EMPTY_BODY_AMBIGUOUS'],
    };
  }
  if (/\b(?:TODO|FIXME)\b/i.test(original)) {
    return {
      state: 'partial',
      basis: 'heuristic',
      reasonCodes: ['TODO_MARKER_PRESENT'],
    };
  }
  if (isSolePlaceholderReturn(executable)) {
    return {
      state: 'partial',
      basis: 'heuristic',
      reasonCodes: ['PLACEHOLDER_RETURN_ONLY'],
    };
  }
  return {
    state: 'implemented',
    basis: 'syntactic-body',
    reasonCodes: ['NON_EMPTY_SYNTACTIC_BODY'],
  };
}

function isSoleCsharpNotImplementedThrow(value: string): boolean {
  return /^throw\s+new\s+(?:global::)?(?:System\.)?NotImplementedException\s*\([^;]*\)\s*;?$/.test(
    normalizeExecutable(value),
  );
}

function isSoleJavaExplicitStub(value: string): boolean {
  const normalized = normalizeExecutable(value);
  if (/^throw\s+new\s+(?:[\w$.]+\.)?NotImplemented(?:Exception|Error)\s*\([^;]*\)\s*;?$/.test(normalized)) {
    return true;
  }
  const unsupported = /^throw\s+new\s+(?:java\.lang\.)?UnsupportedOperationException\s*\(([^;]*)\)\s*;?$/.exec(normalized);
  return unsupported !== null && /\b(?:TODO|not\s+implemented)\b/i.test(unsupported[1] ?? '');
}

function isSolePlaceholderReturn(value: string): boolean {
  return /^return\s+(?:null|default(?:\s*\([^)]*\)|\s*!?)?|0|false)\s*;?$/.test(
    normalizeExecutable(value),
  );
}

function executableBody(value: string): string {
  const trimmed = value.trim();
  const arrow = trimmed.indexOf('=>');
  if (arrow !== -1) return trimmed.slice(arrow + 2).replace(/;\s*$/, '').trim();
  const opening = trimmed.indexOf('{');
  const closing = trimmed.lastIndexOf('}');
  if (opening !== -1 && closing > opening) return trimmed.slice(opening + 1, closing).trim();
  return trimmed.replace(/^[^{;]*\)\s*/, '').trim();
}

/** Return the exact body bytes represented by the parsed callable range. */
function isolatedBodySource(source: string): string | undefined {
  const masked = maskCommentsAndLiterals(source);
  const arrow = masked.indexOf('=>');
  if (arrow !== -1) return source.slice(arrow);
  const opening = masked.indexOf('{');
  const closing = masked.lastIndexOf('}');
  if (opening !== -1 && closing > opening) return source.slice(opening, closing + 1);
  return undefined;
}

function normalizeExecutable(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function unavailableDraft(
  entity: RepositoryIREntity,
  file: RepositoryIRFile | undefined,
  symbol: StaticSymbol | undefined,
  reason: string,
): EntityImplementationAssessmentDraft {
  return {
    entityId: entity.id,
    fileId: file?.id ?? entity.fileId ?? `missing-file:${entity.id}`,
    state: 'unknown',
    basis: 'unavailable',
    reasonCodes: [reason],
    evidenceRefs: file ? evidenceFor(entity, file, symbol?.range ?? entity.range) : [],
    detector: unavailableDetector(entity.languageId ?? symbol?.language),
  };
}

function unavailableDetector(languageId: string | undefined): ImplementationDetector {
  return {
    id: 'forexplore.implementation.unavailable',
    version: implementationAssessmentDetectorVersion,
    ...(languageId ? { languageId } : {}),
  };
}

function evidenceFor(
  entity: RepositoryIREntity,
  file: RepositoryIRFile,
  range: StaticSourceRange | undefined,
): RepositoryEvidenceRef[] {
  return [{
    id: `implementation-source:${entity.id}`,
    kind: 'syntactic-analysis',
    sourceArtifactId: entity.id,
    path: file.path,
    ...(range ? { range } : {}),
    summary: 'Static callable implementation evidence; not proof of business correctness.',
  }];
}

async function readSnapshotFile(root: string, relativePath: string, expectedHash: string): Promise<string> {
  const target = resolveInside(root, relativePath);
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Implementation assessment source is not a regular file: ${relativePath}`);
  }
  const bytes = await readFile(target);
  if (sha256(bytes) !== expectedHash) {
    throw new Error(`Target workspace changed after static analysis: ${relativePath}`);
  }
  return bytes.toString('utf8');
}

function resolveInside(root: string, relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Implementation assessment path is unsafe: ${relativePath}`);
  }
  const target = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Implementation assessment path escapes the repository root: ${relativePath}`);
  }
  return target;
}

function sourceForRange(source: string, range: StaticSourceRange | undefined): string | undefined {
  if (!range?.endLine) return undefined;
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  if (range.startLine < 1 || range.endLine < range.startLine || range.endLine > starts.length) {
    return undefined;
  }
  const start = (starts[range.startLine - 1] ?? 0) + Math.max(0, (range.startColumn ?? 1) - 1);
  const endLineStart = starts[range.endLine - 1] ?? source.length;
  const end = range.endColumn === undefined
    ? (starts[range.endLine] ?? source.length)
    : endLineStart + range.endColumn;
  if (start < 0 || end <= start || end > source.length) return undefined;
  return source.slice(start, end);
}

/** Masks comments and string/character literals without changing offsets. */
function maskCommentsAndLiterals(source: string): string {
  const output = source.split('');
  let index = 0;
  const mask = (start: number, end: number): void => {
    for (let cursor = start; cursor < end; cursor += 1) {
      if (output[cursor] !== '\n' && output[cursor] !== '\r') output[cursor] = ' ';
    }
  };
  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (current === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      const stop = end === -1 ? source.length : end;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (current === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (current === '@' && next === '"') {
      let cursor = index + 2;
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') cursor += 2;
        else if (source[cursor] === '"') { cursor += 1; break; }
        else cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    if (current === '"' || current === '\'') {
      const quote = current;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') cursor += 2;
        else if (source[cursor] === quote) { cursor += 1; break; }
        else cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }
  return output.join('');
}

function assertAnalysisLineage(analysis: RepositoryStaticAnalysis, ir: UnifiedRepositoryIR): void {
  if (ir.repositoryContentHash !== analysis.contentHash) {
    throw new Error('Unified IR is not derived from the supplied static-analysis snapshot.');
  }
  if (!ir.sourceShardIds.length || !ir.files.length) {
    throw new Error('Implementation assessment requires a materialized Unified Repository IR.');
  }
}

function canonicalLanguage(value: string): string {
  return value.trim().toLowerCase();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
