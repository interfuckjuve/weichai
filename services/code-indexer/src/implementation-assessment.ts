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

export const implementationAssessmentDetectorVersion = '2.0.0';

export type ImplementationBodyIsolation = 'brace-balanced' | 'indentation-aware';
export type ImplementationMaskingProfile =
  | 'java-lexical'
  | 'csharp-lexical'
  | 'typescript-template-aware'
  | 'python-triple-quote-aware'
  | 'go-raw-string-aware'
  | 'rust-raw-string-aware';

/**
 * Runtime capability metadata. It is intentionally more explicit than the
 * persisted contracts descriptor: callers can decide whether a lexical
 * detector is sufficient before asking it to classify target code.
 */
export interface RepositoryImplementationDetectorCapability {
  bodyIsolation: ImplementationBodyIsolation;
  commentAndLiteralMasking: ImplementationMaskingProfile;
  declarationForms: readonly string[];
  failClosed: true;
}

export interface RepositoryImplementationDetectorQuality {
  level: 'language-aware-lexical-heuristic';
  provesBehavioralCorrectness: false;
  limitations: readonly string[];
}

export interface RepositoryImplementationDetectorDescriptor
  extends ImplementationDetector {
  languageId: string;
  capability: RepositoryImplementationDetectorCapability;
  quality: RepositoryImplementationDetectorQuality;
}

export interface RepositoryImplementationDetectionInput {
  entity: RepositoryIREntity;
  file: RepositoryIRFile;
  symbol: StaticSymbol;
  /** Snapshot-verified complete file. The detector owns all syntax slicing. */
  fileSource: string;
  owner?: StaticSymbol;
}

export interface RepositoryImplementationDetectionResult {
  state: ImplementationState;
  basis: ImplementationAssessmentBasis;
  reasonCodes: string[];
  /** Hash of the exact language-specific body isolated by this detector. */
  bodyHash?: string;
}

/**
 * Open language seam for static implementation evidence. Supporting repository
 * analysis for a language does not imply that a detector exists for it.
 */
export interface RepositoryImplementationDetector {
  descriptor: RepositoryImplementationDetectorDescriptor;
  detect(input: RepositoryImplementationDetectionInput): RepositoryImplementationDetectionResult;
}

export class RepositoryImplementationDetectorRegistry {
  private readonly byLanguage = new Map<string, RepositoryImplementationDetector>();

  constructor(detectors: readonly RepositoryImplementationDetector[] = []) {
    for (const detector of detectors) this.register(detector);
  }

  register(detector: RepositoryImplementationDetector): void {
    const languageId = canonicalLanguage(detector.descriptor.languageId);
    assertDetectorDescriptor(detector.descriptor, languageId);
    if (this.byLanguage.has(languageId)) {
      throw new Error(`Implementation detector is already registered for ${languageId}.`);
    }
    this.byLanguage.set(languageId, detector);
  }

  detectorFor(languageId: string): RepositoryImplementationDetector | undefined {
    return this.byLanguage.get(canonicalLanguage(languageId));
  }

  descriptors(): RepositoryImplementationDetectorDescriptor[] {
    return [...this.byLanguage.values()]
      .map((detector) => ({
        ...detector.descriptor,
        capability: {
          ...detector.descriptor.capability,
          declarationForms: [...detector.descriptor.capability.declarationForms],
        },
        quality: {
          ...detector.descriptor.quality,
          limitations: [...detector.descriptor.quality.limitations],
        },
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

function assertDetectorDescriptor(
  descriptor: RepositoryImplementationDetectorDescriptor,
  canonicalLanguageId: string,
): void {
  if (!canonicalLanguageId || !descriptor.id.trim() || !descriptor.version.trim()) {
    throw new Error('Implementation detector requires stable id, version, and languageId.');
  }
  const capability = descriptor.capability;
  const isolationModes: readonly ImplementationBodyIsolation[] = ['brace-balanced', 'indentation-aware'];
  const maskingProfiles: readonly ImplementationMaskingProfile[] = [
    'java-lexical',
    'csharp-lexical',
    'typescript-template-aware',
    'python-triple-quote-aware',
    'go-raw-string-aware',
    'rust-raw-string-aware',
  ];
  if (
    !capability ||
    !isolationModes.includes(capability.bodyIsolation) ||
    !maskingProfiles.includes(capability.commentAndLiteralMasking) ||
    capability.failClosed !== true ||
    !Array.isArray(capability.declarationForms) ||
    !capability.declarationForms.some((form) => typeof form === 'string' && form.trim())
  ) {
    throw new Error(`Implementation detector ${descriptor.id} has an invalid capability descriptor.`);
  }
  if (
    !descriptor.quality ||
    descriptor.quality.level !== 'language-aware-lexical-heuristic' ||
    descriptor.quality.provesBehavioralCorrectness !== false ||
    !Array.isArray(descriptor.quality.limitations) ||
    descriptor.quality.limitations.length === 0
  ) {
    throw new Error(`Implementation detector ${descriptor.id} has an invalid quality descriptor.`);
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
    const owner = symbol.containerSymbolId
      ? symbols.get(symbol.containerSymbolId)
      : undefined;
    const detector = registry.detectorFor(entity.languageId ?? symbol.language);
    const evidenceRefs = evidenceFor(entity, file, symbol.range);

    if (file.role === 'test' || entity.testOnly === true || symbol.testOnly === true) {
      drafts.push({
        entityId: entity.id,
        fileId: file.id,
        state: 'not-applicable',
        basis: 'unavailable',
        reasonCodes: ['TEST_CALLABLE_EXCLUDED'],
        evidenceRefs,
        detector: detector
          ? persistedDetectorDescriptor(detector.descriptor)
          : unavailableDetector(entity.languageId ?? symbol.language),
      });
      continue;
    }
    if (file.role === 'generated' || file.generated === true) {
      drafts.push({
        entityId: entity.id,
        fileId: file.id,
        state: 'not-applicable',
        basis: 'unavailable',
        reasonCodes: ['GENERATED_CALLABLE_EXCLUDED'],
        evidenceRefs,
        detector: detector
          ? persistedDetectorDescriptor(detector.descriptor)
          : unavailableDetector(entity.languageId ?? symbol.language),
      });
      continue;
    }
    if (!detector) {
      drafts.push({
        entityId: entity.id,
        fileId: file.id,
        state: 'unknown',
        basis: 'unavailable',
        reasonCodes: ['IMPLEMENTATION_DETECTOR_UNAVAILABLE'],
        evidenceRefs,
        detector: unavailableDetector(entity.languageId ?? symbol.language),
      });
      continue;
    }
    const result = safelyDetect(detector, {
      entity,
      file,
      symbol,
      fileSource,
      owner,
    });
    drafts.push({
      entityId: entity.id,
      fileId: file.id,
      ...(result.bodyHash ? { bodyHash: result.bodyHash } : {}),
      state: result.state,
      basis: result.basis,
      reasonCodes: sortedUnique(result.reasonCodes),
      evidenceRefs,
      detector: persistedDetectorDescriptor(detector.descriptor),
    });
  }
  if (drafts.length !== callables.length) {
    throw new Error('Implementation assessment did not cover every callable entity.');
  }
  return drafts;
}

export function createDefaultRepositoryImplementationDetectorRegistry(): RepositoryImplementationDetectorRegistry {
  return new RepositoryImplementationDetectorRegistry([
    createBraceLanguageDetector('java', 'java-lexical', [
      'method-block',
      'constructor-block',
      'declaration-only',
    ]),
    createBraceLanguageDetector('csharp', 'csharp-lexical', [
      'method-block',
      'constructor-block',
      'expression-bodied-member',
      'declaration-only',
    ]),
    createBraceLanguageDetector('typescript', 'typescript-template-aware', [
      'top-level-function',
      'method-block',
      'declaration-only',
    ]),
    createPythonDetector(),
    createBraceLanguageDetector('go', 'go-raw-string-aware', [
      'top-level-function',
      'receiver-method',
    ]),
    createBraceLanguageDetector('rust', 'rust-raw-string-aware', [
      'free-function',
      'impl-method',
      'trait-declaration',
    ]),
  ]);
}

type BraceDetectorLanguage = 'java' | 'csharp' | 'typescript' | 'go' | 'rust';

function createBraceLanguageDetector(
  languageId: BraceDetectorLanguage,
  masking: ImplementationMaskingProfile,
  declarationForms: readonly string[],
): RepositoryImplementationDetector {
  const capability: RepositoryImplementationDetectorCapability = {
    bodyIsolation: 'brace-balanced',
    commentAndLiteralMasking: masking,
    declarationForms,
    failClosed: true,
  };
  const quality: RepositoryImplementationDetectorQuality = {
    level: 'language-aware-lexical-heuristic',
    provesBehavioralCorrectness: false,
    limitations: [
      'Classifies static syntax only; generated code, macros, and framework semantics are not executed.',
      'Returns unknown when a callable boundary cannot be isolated deterministically.',
    ],
  };
  return {
    descriptor: {
      id: `forexplore.implementation.${languageId}.syntax`,
      version: implementationAssessmentDetectorVersion,
      languageId,
      configurationHash: detectorConfigurationHash(languageId, capability, quality),
      capability,
      quality,
    },
    detect(input) {
      return detectBraceLanguage(input, languageId, masking);
    },
  };
}

function createPythonDetector(): RepositoryImplementationDetector {
  const languageId = 'python';
  const capability: RepositoryImplementationDetectorCapability = {
    bodyIsolation: 'indentation-aware',
    commentAndLiteralMasking: 'python-triple-quote-aware',
    declarationForms: [
      'top-level-function',
      'nested-function',
      'instance-method',
      'async-function',
    ],
    failClosed: true,
  };
  const quality: RepositoryImplementationDetectorQuality = {
    level: 'language-aware-lexical-heuristic',
    provesBehavioralCorrectness: false,
    limitations: [
      'Uses lexical indentation and does not execute decorators or metaprogramming.',
      'Returns unknown when a complete indented suite cannot be isolated.',
    ],
  };
  return {
    descriptor: {
      id: 'forexplore.implementation.python.syntax',
      version: implementationAssessmentDetectorVersion,
      languageId,
      configurationHash: detectorConfigurationHash(languageId, capability, quality),
      capability,
      quality,
    },
    detect: detectPython,
  };
}

interface IsolatedCallableBody {
  body: string;
  executable: string;
  maskedExecutable: string;
  comments: string;
  declarationOnly: boolean;
}

function detectBraceLanguage(
  input: RepositoryImplementationDetectionInput,
  languageId: BraceDetectorLanguage,
  masking: ImplementationMaskingProfile,
): RepositoryImplementationDetectionResult {
  const isolated = isolateBraceCallable(input.fileSource, input.symbol.range, masking);
  if (!isolated) return bodyIsolationUnavailable();
  const signature = input.symbol.signature ?? '';
  if (isolated.declarationOnly) {
    const isContractDeclaration =
      input.owner?.kind === 'interface' ||
      /\b(?:abstract|declare|extern|native)\b/.test(signature) ||
      (languageId === 'rust' && /\bfn\b/.test(signature));
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

  const bodyHash = sha256(isolated.body);
  const executable = isolated.maskedExecutable.trim();
  const originalExecutable = isolated.executable.trim();
  if (languageId === 'csharp' && isSoleCsharpNotImplementedThrow(executable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['CSHARP_NOT_IMPLEMENTED_EXCEPTION'],
      bodyHash,
    };
  }
  if (languageId === 'java' && isSoleJavaExplicitStub(originalExecutable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['JAVA_EXPLICIT_NOT_IMPLEMENTED_THROW'],
      bodyHash,
    };
  }
  if (languageId === 'typescript' && isSoleTypescriptExplicitStub(originalExecutable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['TYPESCRIPT_EXPLICIT_NOT_IMPLEMENTED_THROW'],
      bodyHash,
    };
  }
  if (languageId === 'go' && isSoleGoExplicitStub(originalExecutable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['GO_EXPLICIT_NOT_IMPLEMENTED_PANIC'],
      bodyHash,
    };
  }
  if (languageId === 'rust' && isSoleRustExplicitStub(originalExecutable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['RUST_EXPLICIT_NOT_IMPLEMENTED_MACRO'],
      bodyHash,
    };
  }
  if (!executable.replace(/[;\s]/g, '')) {
    return {
      state: 'unknown',
      basis: 'heuristic',
      reasonCodes: ['EMPTY_BODY_AMBIGUOUS'],
      bodyHash,
    };
  }
  if (/\b(?:TODO|FIXME)\b/i.test(isolated.comments)) {
    return {
      state: 'partial',
      basis: 'heuristic',
      reasonCodes: ['TODO_MARKER_PRESENT'],
      bodyHash,
    };
  }
  if (isSolePlaceholderReturn(executable, languageId)) {
    return {
      state: 'partial',
      basis: 'heuristic',
      reasonCodes: ['PLACEHOLDER_RETURN_ONLY'],
      bodyHash,
    };
  }
  return {
    state: 'implemented',
    basis: 'syntactic-body',
    reasonCodes: ['NON_EMPTY_SYNTACTIC_BODY'],
    bodyHash,
  };
}

function detectPython(
  input: RepositoryImplementationDetectionInput,
): RepositoryImplementationDetectionResult {
  const isolated = isolatePythonCallable(input.fileSource, input.symbol.range);
  if (!isolated) return bodyIsolationUnavailable();
  const bodyHash = sha256(isolated.body);
  const executable = normalizePythonExecutable(isolated.maskedExecutable);
  if (/^(?:pass|\.\.\.)$/.test(executable) ||
    /^raise\s+(?:NotImplementedError|NotImplemented)\b(?:\s*\([^)]*\))?$/.test(executable)) {
    return {
      state: 'unimplemented',
      basis: 'explicit-stub',
      reasonCodes: ['PYTHON_EXPLICIT_NOT_IMPLEMENTED_STUB'],
      bodyHash,
    };
  }
  if (!executable) {
    return {
      state: 'unknown',
      basis: 'heuristic',
      reasonCodes: ['EMPTY_BODY_AMBIGUOUS'],
      bodyHash,
    };
  }
  if (/\b(?:TODO|FIXME)\b/i.test(isolated.comments)) {
    return {
      state: 'partial',
      basis: 'heuristic',
      reasonCodes: ['TODO_MARKER_PRESENT'],
      bodyHash,
    };
  }
  if (/^return\s+(?:None|0|False|\.\.\.)$/.test(executable)) {
    return {
      state: 'partial',
      basis: 'heuristic',
      reasonCodes: ['PLACEHOLDER_RETURN_ONLY'],
      bodyHash,
    };
  }
  return {
    state: 'implemented',
    basis: 'syntactic-body',
    reasonCodes: ['NON_EMPTY_SYNTACTIC_BODY'],
    bodyHash,
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

function isSoleTypescriptExplicitStub(value: string): boolean {
  return /^throw\s+new\s+(?:Error|TypeError)\s*\(\s*['"`](?:TODO|not\s+implemented)[^'"`]*['"`]\s*\)\s*;?$/i.test(
    normalizeExecutable(value),
  );
}

function isSoleGoExplicitStub(value: string): boolean {
  return /^panic\s*\(\s*[`'"](?:TODO|not\s+implemented)[^`'"]*[`'"]\s*\)\s*;?$/i.test(
    normalizeExecutable(value),
  );
}

function isSoleRustExplicitStub(value: string): boolean {
  return /^(?:todo|unimplemented)!\s*\([^;]*\)\s*;?$/.test(normalizeExecutable(value));
}

function isSolePlaceholderReturn(value: string, languageId: BraceDetectorLanguage): boolean {
  const extra = languageId === 'typescript'
    ? '|undefined'
    : languageId === 'go'
      ? '|nil'
      : languageId === 'rust'
        ? '|None'
        : '';
  return new RegExp(`^return\\s+(?:null|default(?:\\s*\\([^)]*\\)|\\s*!?)?|0|false${extra})\\s*;?$`).test(
    normalizeExecutable(value),
  );
}

function normalizeExecutable(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizePythonExecutable(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function safelyDetect(
  detector: RepositoryImplementationDetector,
  input: RepositoryImplementationDetectionInput,
): RepositoryImplementationDetectionResult {
  let result: RepositoryImplementationDetectionResult;
  try {
    result = detector.detect(input);
  } catch {
    return {
      state: 'unknown',
      basis: 'unavailable',
      reasonCodes: ['IMPLEMENTATION_DETECTOR_FAILED'],
    };
  }
  const states: readonly ImplementationState[] = [
    'implemented',
    'unimplemented',
    'partial',
    'unknown',
    'not-applicable',
  ];
  const bases: readonly ImplementationAssessmentBasis[] = [
    'explicit-stub',
    'syntactic-body',
    'validation-backed',
    'declaration-only',
    'heuristic',
    'unavailable',
  ];
  const validHash = result.bodyHash === undefined || /^[a-f0-9]{64}$/.test(result.bodyHash);
  const validReasons = Array.isArray(result.reasonCodes) &&
    result.reasonCodes.some((reason) => typeof reason === 'string' && reason.trim());
  if (!states.includes(result.state) || !bases.includes(result.basis) || !validHash || !validReasons) {
    return {
      state: 'unknown',
      basis: 'unavailable',
      reasonCodes: ['IMPLEMENTATION_DETECTOR_RESULT_INVALID'],
    };
  }
  if (
    (result.state === 'implemented' || result.state === 'unimplemented' || result.state === 'partial') &&
    !result.bodyHash
  ) {
    return bodyIsolationUnavailable();
  }
  return result;
}

function bodyIsolationUnavailable(): RepositoryImplementationDetectionResult {
  return {
    state: 'unknown',
    basis: 'unavailable',
    reasonCodes: ['CALLABLE_BODY_ISOLATION_UNAVAILABLE'],
  };
}

function persistedDetectorDescriptor(
  descriptor: RepositoryImplementationDetectorDescriptor,
): ImplementationDetector {
  return {
    id: descriptor.id,
    version: descriptor.version,
    languageId: descriptor.languageId,
    ...(descriptor.configurationHash
      ? { configurationHash: descriptor.configurationHash }
      : {}),
  };
}

function detectorConfigurationHash(
  languageId: string,
  capability: RepositoryImplementationDetectorCapability,
  quality: RepositoryImplementationDetectorQuality,
): string {
  return sha256(JSON.stringify({ languageId, capability, quality }));
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

function isolateBraceCallable(
  source: string,
  range: StaticSourceRange | undefined,
  masking: ImplementationMaskingProfile,
): IsolatedCallableBody | undefined {
  const start = sourceOffset(source, range?.startLine, range?.startColumn);
  if (start === undefined) return undefined;
  const declaredEnd = sourceRangeEnd(source, range);
  const fragment = source.slice(start, declaredEnd ?? source.length);
  const lexical = lexicalView(fragment, masking);
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < lexical.masked.length; index += 1) {
    const current = lexical.masked[index] ?? '';
    const next = lexical.masked[index + 1] ?? '';
    if (current === '(') parentheses += 1;
    else if (current === ')') parentheses = Math.max(0, parentheses - 1);
    else if (current === '[') brackets += 1;
    else if (current === ']') brackets = Math.max(0, brackets - 1);
    if (parentheses !== 0 || brackets !== 0) continue;

    if (current === '=' && next === '>') {
      const end = expressionBodyEnd(lexical.masked, index + 2);
      const body = fragment.slice(index, end);
      const bodyView = lexicalView(body, masking);
      return {
        body,
        executable: body.slice(2).replace(/;\s*$/, '').trim(),
        maskedExecutable: bodyView.masked.slice(2).replace(/;\s*$/, '').trim(),
        comments: bodyView.comments,
        declarationOnly: false,
      };
    }
    if (current === ';') {
      return {
        body: '',
        executable: '',
        maskedExecutable: '',
        comments: lexical.comments,
        declarationOnly: true,
      };
    }
    if (current !== '{') continue;
    const closing = matchingBrace(lexical.masked, index);
    if (closing === undefined) return undefined;
    const after = nextNonWhitespace(lexical.masked, closing + 1);
    // TypeScript permits an object-shaped return type immediately before the
    // implementation block. Do not mistake that type shape for the body.
    if (after !== undefined && lexical.masked[after] === '{') {
      index = closing;
      continue;
    }
    const body = fragment.slice(index, closing + 1);
    const executableBody = body.slice(1, -1);
    const bodyView = lexicalView(executableBody, masking);
    return {
      body,
      executable: executableBody,
      maskedExecutable: bodyView.masked,
      comments: bodyView.comments,
      declarationOnly: false,
    };
  }
  return undefined;
}

function isolatePythonCallable(
  source: string,
  range: StaticSourceRange | undefined,
): IsolatedCallableBody | undefined {
  const start = sourceOffset(source, range?.startLine, range?.startColumn);
  if (start === undefined) return undefined;
  const fragment = source.slice(start);
  const lexical = lexicalView(fragment, 'python-triple-quote-aware');
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let colon: number | undefined;
  for (let index = 0; index < lexical.masked.length; index += 1) {
    const current = lexical.masked[index] ?? '';
    if (current === '(') parentheses += 1;
    else if (current === ')') parentheses = Math.max(0, parentheses - 1);
    else if (current === '[') brackets += 1;
    else if (current === ']') brackets = Math.max(0, brackets - 1);
    else if (current === '{') braces += 1;
    else if (current === '}') braces = Math.max(0, braces - 1);
    else if (current === ':' && parentheses === 0 && brackets === 0 && braces === 0) {
      colon = index;
      break;
    }
    if (current === '\n' && parentheses === 0 && brackets === 0 && braces === 0) {
      return undefined;
    }
  }
  if (colon === undefined) return undefined;

  const headerLineEnd = fragment.indexOf('\n', colon + 1);
  const inlineEnd = headerLineEnd === -1 ? fragment.length : headerLineEnd;
  const inlineMasked = lexical.masked.slice(colon + 1, inlineEnd).trim();
  if (inlineMasked) {
    const body = fragment.slice(colon + 1, inlineEnd);
    const bodyView = lexicalView(body, 'python-triple-quote-aware');
    return {
      body,
      executable: body,
      maskedExecutable: bodyView.masked,
      comments: bodyView.comments,
      declarationOnly: false,
    };
  }
  if (headerLineEnd === -1) return undefined;

  const fullStarts = lineStarts(source);
  const startLineIndex = (range?.startLine ?? 1) - 1;
  const declarationLine = source.slice(
    fullStarts[startLineIndex] ?? start,
    fullStarts[startLineIndex + 1] ?? source.length,
  );
  const baseIndent = indentationWidth(declarationLine);
  const bodyStart = start + headerLineEnd + 1;
  const bodyRelativeStart = headerLineEnd + 1;
  let bodyEnd = source.length;
  let sawSuiteLine = false;
  for (let cursor = bodyRelativeStart; cursor < fragment.length;) {
    const lineEnd = fragment.indexOf('\n', cursor);
    const end = lineEnd === -1 ? fragment.length : lineEnd + 1;
    const maskedLine = lexical.masked.slice(cursor, end);
    const originalLine = fragment.slice(cursor, end);
    if (maskedLine.trim()) {
      if (indentationWidth(originalLine) <= baseIndent) {
        bodyEnd = start + cursor;
        break;
      }
      sawSuiteLine = true;
    } else if (originalLine.trim() && indentationWidth(originalLine) > baseIndent) {
      // A suite containing only a docstring or comment is still a body whose
      // exact bytes can be hashed, even though it is not implementation proof.
      sawSuiteLine = true;
    }
    if (lineEnd === -1) break;
    cursor = end;
  }
  if (!sawSuiteLine || bodyEnd <= bodyStart) return undefined;
  const body = source.slice(bodyStart, bodyEnd);
  const bodyView = lexicalView(body, 'python-triple-quote-aware');
  return {
    body,
    executable: body,
    maskedExecutable: bodyView.masked,
    comments: bodyView.comments,
    declarationOnly: false,
  };
}

function expressionBodyEnd(masked: string, start: number): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = start; index < masked.length; index += 1) {
    const current = masked[index] ?? '';
    if (current === '(') parentheses += 1;
    else if (current === ')') parentheses = Math.max(0, parentheses - 1);
    else if (current === '[') brackets += 1;
    else if (current === ']') brackets = Math.max(0, brackets - 1);
    else if (current === '{') braces += 1;
    else if (current === '}') braces = Math.max(0, braces - 1);
    else if (current === ';' && parentheses === 0 && brackets === 0 && braces === 0) return index + 1;
  }
  return masked.length;
}

function matchingBrace(masked: string, opening: number): number | undefined {
  let depth = 0;
  for (let index = opening; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    else if (masked[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function nextNonWhitespace(value: string, start: number): number | undefined {
  for (let index = start; index < value.length; index += 1) {
    if (!/\s/.test(value[index] ?? '')) return index;
  }
  return undefined;
}

function sourceOffset(
  source: string,
  line: number | undefined,
  column: number | undefined,
): number | undefined {
  if (line === undefined || line < 1) return undefined;
  const starts = lineStarts(source);
  if (line > starts.length) return undefined;
  const offset = (starts[line - 1] ?? 0) + Math.max(0, (column ?? 1) - 1);
  return offset <= source.length ? offset : undefined;
}

function sourceRangeEnd(
  source: string,
  range: StaticSourceRange | undefined,
): number | undefined {
  if (!range?.endLine) return undefined;
  const starts = lineStarts(source);
  if (range.endLine < range.startLine || range.endLine > starts.length) return undefined;
  const lineStart = starts[range.endLine - 1] ?? source.length;
  return range.endColumn === undefined
    ? (starts[range.endLine] ?? source.length)
    : Math.min(source.length, lineStart + range.endColumn);
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function indentationWidth(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === ' ') width += 1;
    else if (character === '\t') width += 8 - (width % 8);
    else break;
  }
  return width;
}

interface LexicalView {
  masked: string;
  comments: string;
}

/** Language-owned lexical masking; offsets and line breaks are preserved. */
function lexicalView(source: string, profile: ImplementationMaskingProfile): LexicalView {
  const output = source.split('');
  const comments: string[] = [];
  let index = 0;
  const mask = (start: number, end: number): void => {
    for (let cursor = start; cursor < end; cursor += 1) {
      if (output[cursor] !== '\n' && output[cursor] !== '\r') output[cursor] = ' ';
    }
  };
  while (index < source.length) {
    const current = source[index] ?? '';
    const next = source[index + 1] ?? '';
    if (profile === 'python-triple-quote-aware' && current === '#') {
      const end = source.indexOf('\n', index + 1);
      const stop = end === -1 ? source.length : end;
      comments.push(source.slice(index, stop));
      mask(index, stop);
      index = stop;
      continue;
    }
    if (profile !== 'python-triple-quote-aware' && current === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      const stop = end === -1 ? source.length : end;
      comments.push(source.slice(index, stop));
      mask(index, stop);
      index = stop;
      continue;
    }
    if (profile !== 'python-triple-quote-aware' && current === '/' && next === '*') {
      const stop = blockCommentEnd(source, index, profile === 'rust-raw-string-aware');
      comments.push(source.slice(index, stop));
      mask(index, stop);
      index = stop;
      continue;
    }
    if (profile === 'csharp-lexical' && current === '@' && next === '"') {
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
    if ((profile === 'typescript-template-aware' || profile === 'go-raw-string-aware') && current === '`') {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (profile === 'typescript-template-aware' && source[cursor] === '\\') cursor += 2;
        else if (source[cursor] === '`') { cursor += 1; break; }
        else cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    if (profile === 'rust-raw-string-aware') {
      const rawEnd = rustRawStringEnd(source, index);
      if (rawEnd !== undefined) {
        mask(index, rawEnd);
        index = rawEnd;
        continue;
      }
    }
    if (
      (profile === 'python-triple-quote-aware' ||
        profile === 'java-lexical' ||
        profile === 'csharp-lexical') &&
      (source.startsWith('"""', index) || source.startsWith("'''", index))
    ) {
      const delimiter = source.slice(index, index + 3);
      const end = source.indexOf(delimiter, index + 3);
      const stop = end === -1 ? source.length : end + 3;
      const maskStart = stringPrefixStart(source, index);
      mask(maskStart, stop);
      index = stop;
      continue;
    }
    if (current === '"' || current === '\'') {
      if (
        profile === 'rust-raw-string-aware' &&
        current === '\'' &&
        !looksLikeRustCharacterLiteral(source, index)
      ) {
        index += 1;
        continue;
      }
      const quote = current;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') cursor += 2;
        else if (source[cursor] === quote) { cursor += 1; break; }
        else cursor += 1;
      }
      mask(stringPrefixStart(source, index), cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }
  return { masked: output.join(''), comments: comments.join('\n') };
}

function blockCommentEnd(source: string, start: number, nested: boolean): number {
  if (!nested) {
    const end = source.indexOf('*/', start + 2);
    return end === -1 ? source.length : end + 2;
  }
  let depth = 1;
  for (let index = start + 2; index < source.length - 1; index += 1) {
    const pair = source.slice(index, index + 2);
    if (pair === '/*') { depth += 1; index += 1; }
    else if (pair === '*/') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function rustRawStringEnd(source: string, start: number): number | undefined {
  const match = /^(?:br|r)(#*)"/.exec(source.slice(start));
  if (!match) return undefined;
  const delimiter = `"${match[1] ?? ''}`;
  const contentStart = start + match[0].length;
  const end = source.indexOf(delimiter, contentStart);
  return end === -1 ? source.length : end + delimiter.length;
}

function stringPrefixStart(source: string, quote: number): number {
  let start = quote;
  while (start > 0 && /[rRuUbBfF$@]/.test(source[start - 1] ?? '') && quote - start < 3) start -= 1;
  if (start > 0 && /[A-Za-z0-9_]/.test(source[start - 1] ?? '')) return quote;
  return start;
}

function looksLikeRustCharacterLiteral(source: string, quote: number): boolean {
  if (source[quote + 1] === '\\') return source[quote + 3] === '\'';
  return source[quote + 2] === '\'';
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
