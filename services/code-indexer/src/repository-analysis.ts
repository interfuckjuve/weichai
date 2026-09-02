import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  moduleMigrationSchemaVersion,
  type AnalysisCapability,
  type DependencyEdge,
  type DependencyEvidenceLevel,
  type DependencyKind,
  type DependencyResolutionStatus,
  type Language,
  type LanguageId,
  type RepositoryStaticAnalysis,
  type RepositoryStaticAnalysisAdapterDescriptor,
  type StaticAnalysisDiagnostic,
  type StaticAnalysisFile,
  type StaticSourceRange,
  type StaticSymbol,
  type StaticSymbolKind,
  type StaticSymbolParameter,
  type StaticSymbolVisibility,
} from '@forexplore/contracts';
import { extractSymbols } from './extractor.js';
import { probeSystemCompilerSemantics } from './semantic-compiler-probe.js';

const execFileAsync = promisify(execFile);
const safeRepositoryId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const safeAnalysisAdapterId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Syntax is always collected deterministically. When explicitly enabled, a
 * JDK Compiler API or Roslyn/MSBuildWorkspace helper may confirm individual
 * existing edges; unavailable tooling never upgrades syntactic evidence.
 */
export const repositoryAnalysisVersion = 'forexplore-code-indexer/1.3.0-api-surface';
export const repositoryAnalysisArtifactDirectory = '.forexplore/analysis';

export type CompilerProbeStatus = 'available' | 'unavailable' | 'failed';

/** A compiler-confirmed binding may only enrich an already resolved syntax edge. */
export interface SemanticDependencyBinding {
  sourcePath: string;
  targetPath: string;
  kind: DependencyKind;
  evidenceRange: StaticSourceRange;
  sourceSymbolId?: string;
  targetSymbolId?: string;
}

export interface CompilerProbeDiagnostic {
  severity: StaticAnalysisDiagnostic['severity'];
  code: string;
  message: string;
  path?: string;
  range?: StaticSourceRange;
}

export interface CompilerProbeRequest {
  root: string;
  language: 'Java' | 'C#';
  files: ReadonlyArray<{
    path: string;
    role: StaticAnalysisFile['role'];
    project?: string;
  }>;
  /** Candidate edges supplied to a trusted compiler-specific binding adapter. */
  candidates: ReadonlyArray<SemanticDependencyBinding>;
}

export interface CompilerProbeResult {
  status: CompilerProbeStatus;
  compiler?: string;
  diagnostics?: CompilerProbeDiagnostic[];
  /** Compiler-derived bindings; untrusted or unmatched values are rejected. */
  bindings?: SemanticDependencyBinding[];
}

/**
 * A host-owned adapter for compiler semantic data. It cannot create edges: a
 * reported binding must exactly match an existing resolved syntactic edge.
 */
export interface CompilerProbe {
  probe(request: CompilerProbeRequest): Promise<CompilerProbeResult>;
}

export interface AnalyzeRepositoryRequest {
  /** Absolute or relative repository root. */
  root: string;
  /** Optional stable logical identity supplied by a trusted repository registry. */
  repositoryId?: string;
  /** Include test files and their source associations. Defaults to true. */
  includeTests?: boolean;
  /**
   * A dirty tracked Git worktree is rejected by default so a snapshot can be
   * safely used as an execution baseline. Planning-only hosts may explicitly
   * opt in; execution hosts must never set this escape hatch.
   */
  allowDirtyWorktreeForPlanning?: boolean;
  /** Allows a caller with a durable clock to make the artifact timestamp explicit. */
  createdAt?: string;
  /** Override only for a deliberately versioned analyser build. */
  analyzerVersion?: string;
  /** Opt in to compiler probing. Off by default to preserve current snapshots. */
  semanticEnrichment?: boolean;
  /** Inject a trusted compiler binding adapter; supplying one enables probing. */
  compilerProbe?: CompilerProbe;
  /** Runtime language routing. Defaults to the built-in six-language registry. */
  languageRegistry?: RepositoryLanguageRegistry;
}

export interface RepositoryAnalysisSourceFile {
  absolutePath: string;
  content: string;
  /** Open-ended adapter identity used by discovery, routing, and project ownership. */
  languageId?: LanguageId;
  masked: string;
  path: string;
  project?: string;
  projectLanguageId?: LanguageId;
  role: StaticAnalysisFile['role'];
  sha256: string;
}

type RepositoryParserDialect = CompilerProbeRequest['language'];
type RepositoryFile = RepositoryAnalysisSourceFile & {
  /** Private parser implementation detail; never serialized into artifacts. */
  dialect?: RepositoryParserDialect;
};

export interface ImportReference {
  range: StaticSourceRange;
  targetReference: string;
}

interface TypeReference {
  kind: DependencyKind;
  namespaceOrPackage?: string;
  range: StaticSourceRange;
  sourceSymbolId?: string;
  targetReference: string;
}

export interface RepositoryLanguageReference {
  kind: DependencyKind;
  namespaceOrPackage?: string;
  range: StaticSourceRange;
  sourceSymbolId?: string;
  targetReference: string;
}

export interface RepositoryLanguageAnalysis {
  file: RepositoryAnalysisSourceFile;
  imports: ImportReference[];
  namespaceOrPackage?: string;
  references: RepositoryLanguageReference[];
  symbols: StaticSymbol[];
}

export type RepositoryAnalysisDiagnosticReporter = (
  input: Omit<StaticAnalysisDiagnostic, 'id'>,
) => void;

export interface RepositoryLanguageAdapter {
  /** Stable implementation identity. Changing parser behaviour requires a new version. */
  id: string;
  version: string;
  /** Stable, open-ended registry key (for example `java` or `kotlin`). */
  languageId: LanguageId;
  /** Capability declaration; completion is still evaluated for each analysed segment. */
  capabilities: readonly AnalysisCapability[];
  /** Hash of non-versioned adapter configuration which can affect deterministic output. */
  configurationHash: string;
  fileExtensions: readonly string[];
  configurationFileNames?: readonly string[];
  configurationFileExtensions?: readonly string[];
  analysisLevel: 'deep' | 'generic';
  compilerProbeLanguage?: CompilerProbeRequest['language'];
  analyze(
    file: RepositoryAnalysisSourceFile,
    reportDiagnostic: RepositoryAnalysisDiagnosticReporter,
  ): RepositoryLanguageAnalysis;
}

export interface RepositoryLanguageAdapterDescriptor {
  id: string;
  version: string;
  languageId: LanguageId;
  capabilities: AnalysisCapability[];
  configurationHash: string;
  analysisLevel: RepositoryLanguageAdapter['analysisLevel'];
  fileExtensions: string[];
  configurationFileNames: string[];
  configurationFileExtensions: string[];
  compilerProbeLanguage?: CompilerProbeRequest['language'];
}

/** Runtime registry keeps language discovery and parsing out of the core pipeline. */
export class RepositoryLanguageRegistry {
  readonly #byAdapterId = new Map<string, RepositoryLanguageAdapter>();
  readonly #byLanguageId = new Map<LanguageId, RepositoryLanguageAdapter>();
  readonly #byExtension = new Map<string, RepositoryLanguageAdapter>();
  readonly #configurationByName = new Map<string, RepositoryLanguageAdapter>();
  readonly #configurationByExtension = new Map<string, RepositoryLanguageAdapter>();

  constructor(adapters: readonly RepositoryLanguageAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: RepositoryLanguageAdapter): this {
    if (!safeAnalysisAdapterId.test(adapter.id)) {
      throw new Error('Repository language adapter must declare a safe stable id.');
    }
    if (!adapter.version.trim()) {
      throw new Error(`Repository language adapter must declare a version: ${adapter.id}`);
    }
    if (!adapter.configurationHash.trim()) {
      throw new Error(`Repository language adapter must declare a configuration hash: ${adapter.id}`);
    }
    if (!adapter.languageId.trim()) {
      throw new Error('Repository language adapter must declare a non-empty languageId.');
    }
    if (this.#byAdapterId.has(adapter.id)) {
      throw new Error(`Repository language adapter ID is already registered: ${adapter.id}`);
    }
    if (this.#byLanguageId.has(adapter.languageId)) {
      throw new Error(`Repository language adapter is already registered: ${adapter.languageId}`);
    }
    if (adapter.fileExtensions.length === 0) {
      throw new Error(`Repository language adapter must declare a source extension: ${adapter.languageId}`);
    }
    this.#byAdapterId.set(adapter.id, adapter);
    this.#byLanguageId.set(adapter.languageId, adapter);
    for (const extension of adapter.fileExtensions) {
      this.#registerRoute(this.#byExtension, extension, adapter, 'source extension');
    }
    for (const name of adapter.configurationFileNames ?? []) {
      this.#registerRoute(this.#configurationByName, name, adapter, 'configuration file');
    }
    for (const extension of adapter.configurationFileExtensions ?? []) {
      this.#registerRoute(this.#configurationByExtension, extension, adapter, 'configuration extension');
    }
    return this;
  }

  adapterForLanguageId(languageId: LanguageId): RepositoryLanguageAdapter | undefined {
    return this.#byLanguageId.get(languageId);
  }

  adapterForSourcePath(filePath: string): RepositoryLanguageAdapter | undefined {
    return this.#byExtension.get(path.extname(filePath).toLowerCase());
  }

  adapterForConfigurationPath(filePath: string): RepositoryLanguageAdapter | undefined {
    const normalized = filePath.replaceAll('\\', '/').toLowerCase();
    const name = normalized.split('/').at(-1) ?? normalized;
    return this.#configurationByName.get(name) ?? this.#configurationByExtension.get(path.extname(name));
  }

  adapters(): RepositoryLanguageAdapter[] {
    return [...this.#byLanguageId.values()].sort((left, right) => compareText(left.id, right.id));
  }

  /** Canonical descriptors are safe to persist in immutable analysis evidence. */
  descriptors(): RepositoryLanguageAdapterDescriptor[] {
    return this.adapters().map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
      languageId: adapter.languageId,
      capabilities: sortedUnique(adapter.capabilities),
      configurationHash: adapter.configurationHash,
      analysisLevel: adapter.analysisLevel,
      fileExtensions: normalizedRoutes(adapter.fileExtensions),
      configurationFileNames: normalizedRoutes(adapter.configurationFileNames ?? []),
      configurationFileExtensions: normalizedRoutes(adapter.configurationFileExtensions ?? []),
      ...(adapter.compilerProbeLanguage
        ? { compilerProbeLanguage: adapter.compilerProbeLanguage }
        : {}),
    }));
  }

  /** Stable identity of the complete registered adapter set and routing configuration. */
  fingerprint(): string {
    return sha256(canonicalJson(this.descriptors()));
  }

  #registerRoute(
    routes: Map<string, RepositoryLanguageAdapter>,
    rawKey: string,
    adapter: RepositoryLanguageAdapter,
    kind: string,
  ): void {
    const key = rawKey.toLowerCase();
    if (!key.trim()) throw new Error(`Repository language ${kind} must not be empty.`);
    const existing = routes.get(key);
    if (existing) {
      throw new Error(`Repository language ${kind} ${rawKey} is already owned by ${existing.languageId}.`);
    }
    routes.set(key, adapter);
  }
}

interface ParsedType {
  endOffset: number;
  file: RepositoryFile;
  headerEnd: number;
  headerStart: number;
  imports: ImportReference[];
  namespaceOrPackage?: string;
  symbol: StaticSymbol;
  typeReferences: TypeReference[];
}

interface ParsedFile {
  file: RepositoryFile;
  imports: ImportReference[];
  namespaceOrPackage?: string;
  types: ParsedType[];
}

interface Resolution {
  candidates: StaticSymbol[];
  internal: boolean;
  status: DependencyResolutionStatus;
}

interface EdgeDraft {
  kind: DependencyKind;
  sourcePath: string;
  sourceSymbolId?: string;
  targetReference: string;
  targetPath?: string;
  targetSymbolId?: string;
  internal: boolean;
  resolution: DependencyResolutionStatus;
  evidence: DependencyEvidenceLevel;
  evidenceRanges: StaticSourceRange[];
}

const ignoredDirectoryNames = new Set([
  '.git',
  '.forexplore',
  '.gradle',
  '.idea',
  '.next',
  '.svn',
  '.vscode',
  'bin',
  'build',
  'dist',
  'node_modules',
  'obj',
  'out',
  'target',
]);

const javaPrimitives = new Set([
  'boolean',
  'byte',
  'char',
  'double',
  'float',
  'int',
  'long',
  'short',
  'void',
]);

const csharpKeywords = new Set([
  'bool',
  'byte',
  'char',
  'decimal',
  'double',
  'dynamic',
  'float',
  'int',
  'long',
  'nint',
  'nuint',
  'object',
  'sbyte',
  'short',
  'string',
  'uint',
  'ulong',
  'ushort',
  'void',
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort(compareText);
}

function normalizedRoutes(values: Iterable<string>): string[] {
  return sortedUnique([...values].map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function defaultLanguageAdapterId(languageId: LanguageId): string {
  const slug = languageId
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+/g, '-')
    .slice(0, 160) || 'language';
  return `forexplore.repository-language:${slug}-${sha256(languageId).slice(0, 12)}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Repository file must stay inside ${root}: ${absolutePath}`);
  }
  return relative.replaceAll('\\', '/');
}

function isTestFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const name = normalized.split('/').at(-1) ?? normalized;
  const stem = name.replace(/\.[^.]+$/, '');
  return (
    normalized.split('/').some((part) => part === 'test' || part === 'tests') ||
    name.startsWith('test_') ||
    stem.endsWith('_test') ||
    stem.endsWith('test') ||
    stem.endsWith('tests') ||
    stem.endsWith('.test') ||
    stem.endsWith('.tests') ||
    stem.endsWith('.spec')
  );
}

function isGeneratedFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const name = normalized.split('/').at(-1) ?? normalized;
  return (
    normalized.split('/').some((part) =>
      ['generated', 'generated-sources', 'autogen'].includes(part),
    ) ||
    name.endsWith('.g.cs') ||
    name.endsWith('.generated.cs') ||
    name.endsWith('.designer.cs') ||
    name.endsWith('.assemblyinfo.cs')
  );
}

function roleForPath(
  relativePath: string,
  languageId: LanguageId | undefined,
  configurationLanguageId: LanguageId | undefined,
): StaticAnalysisFile['role'] {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  const name = normalized.split('/').at(-1) ?? normalized;
  const extension = path.posix.extname(name);
  if (
    configurationLanguageId ||
    [
      '.editorconfig', '.gitattributes', '.gitignore', '.npmrc',
      'dockerfile', 'makefile', 'compose.yaml', 'compose.yml',
    ].includes(name) ||
    ['.json', '.toml', '.yaml', '.yml'].includes(extension)
  ) return 'configuration';
  if (
    /^(readme|changelog|contributing|license|notice)(\.|$)/.test(name) ||
    ['.md', '.mdx', '.rst', '.adoc'].includes(extension)
  ) return 'documentation';
  if (
    ['.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp', '.woff', '.woff2']
      .includes(extension)
  ) return 'asset';
  if (!languageId) return 'other';
  if (isTestFile(relativePath)) return 'test';
  if (isGeneratedFile(relativePath)) return 'generated';
  return 'source';
}

function diagnostic(
  diagnostics: StaticAnalysisDiagnostic[],
  input: Omit<StaticAnalysisDiagnostic, 'id'>,
): void {
  const id = `diagnostic:${sha256(JSON.stringify({
    code: input.code,
    message: input.message,
    path: input.path,
    range: input.range,
    severity: input.severity,
  })).slice(0, 20)}`;
  diagnostics.push({ ...input, id });
}

async function discoverFiles(
  root: string,
  includeTests: boolean,
  diagnostics: StaticAnalysisDiagnostic[],
  languageRegistry: RepositoryLanguageRegistry,
): Promise<RepositoryFile[]> {
  const files: RepositoryFile[] = [];

  async function visit(directory: string): Promise<void> {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = await readdir(directory, { encoding: 'utf8', withFileTypes: true });
    } catch (error) {
      diagnostic(diagnostics, {
        severity: 'warn',
        code: 'DIRECTORY_UNREADABLE',
        message: `Unable to read directory: ${error instanceof Error ? error.message : String(error)}`,
        ...(directory === root ? {} : { path: canonicalPath(root, directory) }),
      });
      return;
    }

    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = canonicalPath(root, absolutePath);
      const sourceAdapter = languageRegistry.adapterForSourcePath(relativePath);
      const configurationAdapter = languageRegistry.adapterForConfigurationPath(relativePath);
      const languageId = sourceAdapter?.languageId;
      const projectLanguageId = configurationAdapter?.languageId;
      const role = roleForPath(relativePath, languageId, projectLanguageId);
      if (role === 'test' && !includeTests) continue;

      try {
        const bytes = await readFile(absolutePath);
        // Non-source files participate in inventory/content identity without
        // being decoded or offered to a language parser/model as source text.
        const content = languageId || projectLanguageId ? bytes.toString('utf8') : '';
        files.push({
          absolutePath,
          content,
          languageId,
          masked: languageId ? maskCommentsAndLiterals(content) : content,
          path: relativePath,
          projectLanguageId,
          role,
          sha256: sha256(bytes),
        });
      } catch (error) {
        diagnostic(diagnostics, {
          severity: 'warn',
          code: 'FILE_UNREADABLE',
          message: `Unable to read file: ${error instanceof Error ? error.message : String(error)}`,
          path: relativePath,
        });
      }
    }
  }

  await visit(root);
  const unclassifiedCount = files.filter((file) => file.languageId === undefined).length;
  if (unclassifiedCount > 0) {
    diagnostic(diagnostics, {
      severity: 'info',
      code: 'UNCLASSIFIED_REPOSITORY_FILES',
      message: `${unclassifiedCount} repository file(s) were preserved in the inventory without a registered language analyser; no symbol or dependency semantics were inferred for them.`,
    });
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}

/** Masks comments and literals while preserving offsets and line breaks. */
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
    const third = source[index + 2] ?? '';
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
    if (current === '"' && next === '"' && third === '"') {
      const end = source.indexOf('"""', index + 3);
      const stop = end === -1 ? source.length : end + 3;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (current === '@' && next === '"') {
      let cursor = index + 2;
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === '"') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    if (current === '"' || current === '\'') {
      const quote = current;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }
  return output.join('');
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function lineAndColumn(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = starts[middle] ?? 0;
    if (value <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const index = Math.max(0, high);
  return { line: index + 1, column: offset - (starts[index] ?? 0) + 1 };
}

function rangeForOffsets(file: RepositoryFile, starts: number[], start: number, end?: number): StaticSourceRange {
  const beginning = lineAndColumn(starts, start);
  const ending = end === undefined ? undefined : lineAndColumn(starts, Math.max(start, end - 1));
  return {
    path: file.path,
    startLine: beginning.line,
    startColumn: beginning.column,
    ...(ending ? { endLine: ending.line, endColumn: ending.column } : {}),
  };
}

function declarationEnd(masked: string, start: number): number {
  for (let cursor = start; cursor < Math.min(masked.length, start + 4000); cursor += 1) {
    const current = masked[cursor];
    if (current === '{' || current === ';') return cursor;
  }
  return Math.min(masked.length, start + 4000);
}

function matchingBrace(masked: string, opening: number): number | undefined {
  if (masked[opening] !== '{') return undefined;
  let depth = 0;
  for (let cursor = opening; cursor < masked.length; cursor += 1) {
    if (masked[cursor] === '{') depth += 1;
    else if (masked[cursor] === '}') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return undefined;
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function declarationLinePrefix(file: RepositoryFile, offset: number): string {
  const lineStart = Math.max(0, file.masked.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
  return file.masked.slice(lineStart, offset);
}

function explicitVisibility(value: string): StaticSymbolVisibility | undefined {
  const tokens = new Set(value.match(/[A-Za-z_-]+/g)?.map((token) => token.toLowerCase()) ?? []);
  // Preserve the narrowest fact for combined C# access modifiers.
  if (tokens.has('private')) return 'private';
  if (tokens.has('public')) return 'public';
  if (tokens.has('protected')) return 'protected';
  if (tokens.has('internal')) return 'internal';
  return undefined;
}

function deepDeclarationVisibility(
  file: RepositoryFile,
  offset: number,
  category: 'type' | 'member',
  nested: boolean,
  interfaceMember = false,
): StaticSymbolVisibility {
  const declared = explicitVisibility(declarationLinePrefix(file, offset));
  if (declared) return declared;
  if (interfaceMember) return 'public';
  if (file.dialect === 'Java') return 'package';
  if (file.dialect === 'C#') {
    if (category === 'type') return nested ? 'private' : 'internal';
    return 'private';
  }
  return 'unknown';
}

function splitTopLevelParameters(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ('<([{'.includes(character ?? '')) depth += 1;
    else if ('>)]}'.includes(character ?? '')) depth = Math.max(0, depth - 1);
    else if (character === ',' && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result.map((entry) => entry.trim()).filter(Boolean);
}

function closingParenthesis(value: string, opening: number): number | undefined {
  let depth = 0;
  for (let index = opening; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1;
    else if (value[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function parameterShape(
  rawValue: string,
  languageId: LanguageId,
): StaticSymbolParameter | undefined {
  const withoutAnnotations = rawValue
    .replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, '')
    .trim();
  const equals = withoutAnnotations.indexOf('=');
  const declaration = (equals === -1 ? withoutAnnotations : withoutAnnotations.slice(0, equals)).trim();
  const required = equals === -1;
  const variadic = /\.\.\.|\bparams\b/.test(declaration);
  const language = languageId.toLowerCase();

  if (language === 'typescript' || language === 'python' || language === 'rust') {
    const separator = declaration.indexOf(':');
    if (separator !== -1) {
      const rawName = declaration.slice(0, separator).trim().replace(/^(?:mut|ref|out|in)\s+/, '');
      const name = rawName.replace(/^\.\.\./, '').replace(/\?$/, '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
      const type = declaration.slice(separator + 1).trim();
      return {
        name,
        ...(type ? { type } : {}),
        required: required && !/\?$/.test(rawName),
        ...(variadic ? { variadic: true } : {}),
      };
    }
    const name = declaration.replace(/^\.\.\./, '').replace(/\?$/, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      return { name, required, ...(variadic ? { variadic: true } : {}) };
    }
  }

  if (language === 'go') {
    const goMatch = /^(?:\.\.\.)?([A-Za-z_]\w*)\s*(.*)$/.exec(declaration);
    if (goMatch?.[1]) {
      const type = goMatch[2]?.trim();
      return {
        name: goMatch[1],
        ...(type ? { type } : {}),
        required: true,
        ...(variadic ? { variadic: true } : {}),
      };
    }
  }

  const normalized = declaration
    .replace(/\b(?:final|this|ref|out|in|params)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = /(?:^|\s)([A-Za-z_$][\w$]*)$/.exec(normalized);
  if (!match?.[1]) return undefined;
  const type = normalized.slice(0, normalized.length - match[1].length).trim().replace(/\.\.\.$/, '');
  return {
    name: match[1],
    ...(type ? { type } : {}),
    required,
    ...(variadic ? { variadic: true } : {}),
  };
}

function callableShape(
  signature: string,
  languageId: LanguageId,
  name: string,
): { parameters?: StaticSymbolParameter[]; returnShape?: string } {
  const nameExpression = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(`);
  const nameMatch = nameExpression.exec(signature);
  const opening = nameMatch ? signature.indexOf('(', nameMatch.index) : signature.indexOf('(');
  if (opening === -1) return {};
  const closing = closingParenthesis(signature, opening);
  if (closing === undefined) return {};
  const parameters = splitTopLevelParameters(signature.slice(opening + 1, closing))
    .map((entry) => parameterShape(entry, languageId))
    .filter((entry): entry is StaticSymbolParameter => entry !== undefined);
  const language = languageId.toLowerCase();
  const suffix = signature.slice(closing + 1).trim();
  let returnShape: string | undefined;
  if (language === 'python' || language === 'rust') {
    returnShape = /->\s*([^:{]+(?:<[^>]+>)?)/.exec(suffix)?.[1]?.trim();
    if (language === 'rust' && !returnShape) returnShape = '()';
  } else if (language === 'typescript') {
    returnShape = /^:\s*([^={;]+)/.exec(suffix)?.[1]?.trim();
  } else if (language === 'go') {
    returnShape = suffix.replace(/\{[\s\S]*$/, '').trim() || 'void';
  } else {
    const prefix = signature.slice(0, nameMatch?.index ?? opening)
      .replace(/@[A-Za-z_$][\w$]*(?:\([^)]*\))?\s*/g, '')
      .replace(/\b(?:public|protected|private|internal|static|final|abstract|virtual|override|async|synchronized|sealed|new|extern|unsafe|partial|default|native|strictfp)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    returnShape = prefix.split(' ').at(-1) || undefined;
  }
  return {
    ...(parameters.length > 0 || signature.slice(opening + 1, closing).trim() === ''
      ? { parameters }
      : {}),
    ...(returnShape ? { returnShape } : {}),
  };
}

function symbolId(
  file: RepositoryFile,
  kind: StaticSymbolKind,
  qualifiedName: string,
  start: number,
): string {
  return `symbol:${file.path}:${start}:${kind}:${qualifiedName}`;
}

function typeKind(keyword: string): StaticSymbolKind {
  if (keyword === 'class') return 'class';
  if (keyword === 'interface' || keyword === '@interface') return 'interface';
  if (keyword === 'record') return 'record';
  if (keyword === 'struct') return 'struct';
  if (keyword === 'enum') return 'enum';
  return 'unknown';
}

function findNamespaceDeclarations(file: RepositoryFile): Array<{ end?: number; name: string; start: number }> {
  const declarations: Array<{ end?: number; name: string; start: number }> = [];
  const expression = /\bnamespace\s+([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*)\s*([;{])/g;
  for (const match of file.masked.matchAll(expression)) {
    const name = (match[1] ?? '').replace(/\s+/g, '');
    const delimiter = match[2] ?? '';
    const start = match.index ?? 0;
    const opening = start + match[0].lastIndexOf(delimiter);
    declarations.push({
      name,
      start,
      ...(delimiter === '{' ? { end: matchingBrace(file.masked, opening) } : {}),
    });
  }
  return declarations;
}

function namespaceAt(
  declarations: Array<{ end?: number; name: string; start: number }>,
  offset: number,
): string | undefined {
  const matches = declarations.filter(
    (declaration) => declaration.start <= offset && (declaration.end === undefined || offset <= declaration.end),
  );
  matches.sort((left, right) => right.start - left.start);
  return matches[0]?.name;
}

function packageName(file: RepositoryFile): { name: string; offset: number } | undefined {
  const match = /\bpackage\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;/m.exec(file.masked);
  if (!match?.[1] || match.index === undefined) return undefined;
  return {
    name: match[1].replace(/\s+/g, ''),
    offset: match.index + match[0].indexOf(match[1]),
  };
}

function parseJavaImports(file: RepositoryFile, starts: number[]): ImportReference[] {
  const imports: ImportReference[] = [];
  const expression = /\bimport\s+(?:static\s+)?([A-Za-z_$][\w$]*(?:\s*\.\s*(?:[A-Za-z_$][\w$]*|\*))*)\s*;/g;
  for (const match of file.masked.matchAll(expression)) {
    if (!match[1] || match.index === undefined) continue;
    const tokenOffset = match.index + match[0].indexOf(match[1]);
    imports.push({
      range: rangeForOffsets(file, starts, tokenOffset, tokenOffset + match[1].length),
      targetReference: match[1].replace(/\s+/g, ''),
    });
  }
  return imports;
}

function parseCsharpImports(file: RepositoryFile, starts: number[]): ImportReference[] {
  const imports: ImportReference[] = [];
  const expression = /^\s*(?:global\s+)?using\s+(?:static\s+)?(?:(?:[A-Za-z_][\w]*\s*=\s*)?)([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)*)\s*;/gm;
  for (const match of file.masked.matchAll(expression)) {
    if (!match[1] || match.index === undefined) continue;
    const tokenOffset = match.index + match[0].lastIndexOf(match[1]);
    imports.push({
      range: rangeForOffsets(file, starts, tokenOffset, tokenOffset + match[1].length),
      targetReference: match[1].replace(/\s+/g, ''),
    });
  }
  return imports;
}

function qualifiedName(namespaceOrPackage: string | undefined, name: string): string {
  return namespaceOrPackage ? `${namespaceOrPackage}.${name}` : name;
}

function referenceTokens(value: string): Array<{ offset: number; value: string }> {
  const tokens: Array<{ offset: number; value: string }> = [];
  const expression = /(?:global::)?[A-Za-z_$][\w$]*(?:(?:\s*\.|::\s*)[A-Za-z_$][\w$]*)*/g;
  for (const match of value.matchAll(expression)) {
    if (!match[0] || match.index === undefined) continue;
    const token = match[0].replace(/\s+/g, '');
    if (
      ['extends', 'implements', 'where', 'new', 'class', 'interface', 'record', 'struct', 'enum'].includes(token) ||
      javaPrimitives.has(token) ||
      csharpKeywords.has(token)
    ) {
      continue;
    }
    tokens.push({ offset: match.index, value: token });
  }
  return tokens;
}

function typeReferencesFromHeader(
  file: RepositoryFile,
  starts: number[],
  symbol: StaticSymbol,
  kind: StaticSymbolKind,
  header: string,
  headerStart: number,
): TypeReference[] {
  const references: TypeReference[] = [];
  const add = (referenceKind: DependencyKind, text: string, offset: number): void => {
    for (const token of referenceTokens(text)) {
      references.push({
        kind: referenceKind,
        namespaceOrPackage: symbol.qualifiedName.slice(0, Math.max(0, symbol.qualifiedName.length - symbol.name.length - 1)) || undefined,
        sourceSymbolId: symbol.id,
        targetReference: token.value,
        range: rangeForOffsets(file, starts, offset + token.offset, offset + token.offset + token.value.length),
      });
    }
  };

  if (file.dialect === 'Java') {
    const extendsMatch = /\bextends\s+([\s\S]*?)(?=\bimplements\b|$)/.exec(header);
    if (extendsMatch?.[1] && extendsMatch.index !== undefined) {
      const start = headerStart + extendsMatch.index + extendsMatch[0].indexOf(extendsMatch[1]);
      add('inheritance', extendsMatch[1], start);
    }
    const implementsMatch = /\bimplements\s+([\s\S]*)$/.exec(header);
    if (implementsMatch?.[1] && implementsMatch.index !== undefined) {
      const start = headerStart + implementsMatch.index + implementsMatch[0].indexOf(implementsMatch[1]);
      add('implementation', implementsMatch[1], start);
    }
    return references;
  }

  const colon = header.indexOf(':');
  if (colon === -1) return references;
  const baseTypes = header.slice(colon + 1).replace(/\bwhere\b[\s\S]*$/, '');
  const referenceKind: DependencyKind = kind === 'interface' ? 'inheritance' : 'implementation';
  add(referenceKind, baseTypes, headerStart + colon + 1);
  return references;
}

function parseTypes(
  file: RepositoryFile,
  reportDiagnostic: RepositoryAnalysisDiagnosticReporter,
): ParsedFile {
  if (!file.languageId || !file.dialect) {
    throw new Error('Deep repository analysis requires languageId and an internal parser dialect.');
  }
  const starts = lineStarts(file.content);
  const imports = file.dialect === 'Java'
    ? parseJavaImports(file, starts)
    : parseCsharpImports(file, starts);
  const javaPackage = file.dialect === 'Java' ? packageName(file) : undefined;
  const namespaces = file.dialect === 'C#' ? findNamespaceDeclarations(file) : [];
  const namespaceOrPackage = javaPackage?.name ?? namespaces[0]?.name;
  const types: ParsedType[] = [];

  if (javaPackage) {
    const range = rangeForOffsets(file, starts, javaPackage.offset, javaPackage.offset + javaPackage.name.length);
    types.push({
      endOffset: javaPackage.offset + javaPackage.name.length,
      file,
      headerEnd: javaPackage.offset + javaPackage.name.length,
      headerStart: javaPackage.offset,
      imports: [],
      namespaceOrPackage: javaPackage.name,
      symbol: {
        id: symbolId(file, 'package', javaPackage.name, javaPackage.offset),
        kind: 'package',
        language: file.languageId,
        name: javaPackage.name.split('.').at(-1) ?? javaPackage.name,
        qualifiedName: javaPackage.name,
        path: file.path,
        project: file.project,
        range,
        signature: `package ${javaPackage.name}`,
        testOnly: file.role === 'test',
      },
      typeReferences: [],
    });
  }

  for (const declaration of namespaces) {
    const range = rangeForOffsets(file, starts, declaration.start, declaration.start + declaration.name.length);
    types.push({
      endOffset: declaration.end ?? file.content.length,
      file,
      headerEnd: declaration.start + declaration.name.length,
      headerStart: declaration.start,
      imports: [],
      namespaceOrPackage: declaration.name,
      symbol: {
        id: symbolId(file, 'namespace', declaration.name, declaration.start),
        kind: 'namespace',
        language: file.languageId,
        name: declaration.name.split('.').at(-1) ?? declaration.name,
        qualifiedName: declaration.name,
        path: file.path,
        project: file.project,
        range,
        signature: `namespace ${declaration.name}`,
        testOnly: file.role === 'test',
      },
      typeReferences: [],
    });
  }

  const expression = file.dialect === 'Java'
    ? /(?:\b(class|interface|enum|record)\s+|@interface\s+)([A-Za-z_$][\w$]*)\b/g
    : /\b(class|interface|struct|enum|record)\s+(?:(?:class|struct)\s+)?([A-Za-z_][\w]*)\b/g;
  for (const match of file.masked.matchAll(expression)) {
    const name = match[2];
    if (!name || match.index === undefined) continue;
    const keyword = match[1] ?? (file.dialect === 'Java' ? '@interface' : 'unknown');
    const start = match.index;
    const headerEnd = declarationEnd(file.masked, start);
    const opening = file.masked[headerEnd] === '{' ? headerEnd : undefined;
    const endOffset = opening === undefined
      ? headerEnd
      : (matchingBrace(file.masked, opening) ?? headerEnd) + 1;
    const namespace = file.dialect === 'Java'
      ? namespaceOrPackage
      : namespaceAt(namespaces, start);
    const kind = typeKind(keyword);
    const owner = types
      .filter((candidate) =>
        !['package', 'namespace'].includes(candidate.symbol.kind) &&
        candidate.headerStart < start &&
        start < candidate.endOffset,
      )
      .sort((left, right) =>
        (left.endOffset - left.headerStart) - (right.endOffset - right.headerStart),
      )[0];
    const qualified = owner
      ? `${owner.symbol.qualifiedName}.${name}`
      : qualifiedName(namespace, name);
    const symbol: StaticSymbol = {
      id: symbolId(file, kind, qualified, start),
      kind,
      language: file.languageId,
      name,
      qualifiedName: qualified,
      path: file.path,
      project: file.project,
      range: rangeForOffsets(file, starts, start, endOffset),
      signature: normalizeSignature(file.content.slice(start, headerEnd)),
      visibility: deepDeclarationVisibility(file, start, 'type', owner !== undefined),
      ...(owner ? { containerSymbolId: owner.symbol.id } : {}),
      testOnly: file.role === 'test',
    };
    const header = file.masked.slice(start, headerEnd);
    types.push({
      endOffset,
      file,
      headerEnd,
      headerStart: start,
      imports: [],
      namespaceOrPackage: namespace,
      symbol,
      typeReferences: typeReferencesFromHeader(file, starts, symbol, kind, header, start),
    });
  }

  if (unmatchedBraces(file.masked)) {
    reportDiagnostic({
      severity: 'warn',
      code: 'UNBALANCED_BRACES',
      message: 'Source has unbalanced braces; dependency results are syntactic and may be incomplete.',
      path: file.path,
    });
  }

  return { file, imports, namespaceOrPackage, types };
}

function unmatchedBraces(masked: string): boolean {
  let depth = 0;
  for (const character of masked) {
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

function parseMethodsAndSignatureReferences(parsed: ParsedFile): { references: TypeReference[]; symbols: StaticSymbol[] } {
  const { file, types } = parsed;
  if (!file.languageId || !file.dialect) return { references: [], symbols: [] };
  const starts = lineStarts(file.content);
  const typeDeclarations = types.filter((type) => type.symbol.kind !== 'package' && type.symbol.kind !== 'namespace');
  const methods: StaticSymbol[] = [];
  const methodRanges: Array<{ endOffset: number; nameOffset: number; startOffset: number; symbol: StaticSymbol }> = [];
  const references: TypeReference[] = [];

  const enclosingType = (offset: number): ParsedType | undefined => {
    const matching = typeDeclarations.filter(
      (type) => type.headerStart <= offset && offset <= type.endOffset,
    );
    matching.sort((left, right) => (left.endOffset - left.headerStart) - (right.endOffset - right.headerStart));
    return matching[0];
  };

  // The declaration form is intentionally narrow: an upper-case type token followed by an
  // identifier and a declaration delimiter. This records useful syntactic type evidence
  // without treating arbitrary same-named variables or calls as type references.
  const typeUse = /\b((?:[A-Za-z_$][\w$]*(?:\s*\.\s*)?)*[A-Z][\w$]*(?:\s*<[^;\n(){}]*>)?(?:\s*\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?=(?:[=;,){]|\())/g;
  for (const match of file.masked.matchAll(typeUse)) {
    if (!match[1] || match.index === undefined) continue;
    const targetReference = match[1].replace(/\s+/g, '');
    const owner = enclosingType(match.index);
    references.push({
      kind: 'type-reference',
      namespaceOrPackage: owner?.namespaceOrPackage,
      sourceSymbolId: owner?.symbol.id,
      targetReference,
      range: rangeForOffsets(file, starts, match.index, match.index + match[1].length),
    });
  }

  const addCallable = (input: {
    startOffset: number;
    name: string;
    nameOffset: number;
    signatureEndOffset: number;
    endOffset: number;
    kind?: 'method' | 'constructor';
  }): void => {
    const owner = enclosingType(input.startOffset);
    if (!owner || methodNameOffsets.has(input.nameOffset)) return;
    if (input.kind === 'constructor' && input.name !== owner.symbol.name) return;
    if (['if', 'for', 'while', 'switch', 'catch', 'foreach', 'using'].includes(input.name)) return;
    methodNameOffsets.add(input.nameOffset);
    // Java and C# do not allow a regular method to have the declaring type's
    // name. The broad legacy method matcher can therefore be normalized here
    // instead of minting a duplicate method identity for constructors.
    const kind = input.kind ?? (input.name === owner.symbol.name ? 'constructor' : 'method');
    const qualified = `${owner.symbol.qualifiedName}.${input.name}`;
    const signature = normalizeSignature(
      file.content.slice(input.startOffset, input.signatureEndOffset),
    );
    const method: StaticSymbol = {
      id: symbolId(file, kind, qualified, input.startOffset),
      kind,
      language: file.languageId!,
      name: input.name,
      qualifiedName: qualified,
      path: file.path,
      project: file.project,
      range: rangeForOffsets(file, starts, input.startOffset, input.endOffset),
      signature,
      visibility: deepDeclarationVisibility(
        file,
        input.nameOffset,
        'member',
        true,
        owner.symbol.kind === 'interface',
      ),
      containerSymbolId: owner.symbol.id,
      ...(kind === 'method' ? callableShape(signature, file.languageId!, input.name) : {}),
      testOnly: file.role === 'test',
    };
    methods.push(method);
    methodRanges.push({
      endOffset: input.endOffset,
      nameOffset: input.nameOffset,
      startOffset: input.startOffset,
      symbol: method,
    });
  };

  const methodPatterns = [
    /^[ \t]*(?:(?:public|protected|private|internal|static|final|abstract|virtual|override|async|synchronized|sealed|new|extern|unsafe|partial|default|native|strictfp)\s+)*(?:<[^>\n]+>\s+)?[A-Za-z_$][\w$<>.?\[\],]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}()]*\)\s*(?:throws\s+[^{};]+)?\{/gm,
    /\b(?:public|protected|private|internal|static|final|abstract|virtual|override|async|synchronized|sealed|new|extern|unsafe|partial|default|native|strictfp|\s)+(?:[A-Za-z_$][\w$<>.?\[\],\s]*\s+)([A-Za-z_$][\w$]*)\s*\([^;{}()]*\)\s*(?:throws\s+[^{};]+)?\{/g,
  ];
  const methodNameOffsets = new Set<number>();
  for (const methodPattern of methodPatterns) {
    for (const match of file.masked.matchAll(methodPattern)) {
      if (!match[1] || match.index === undefined) continue;
      const name = match[1];
      const nameOffset = match.index + match[0].lastIndexOf(name);
      const opening = match.index + match[0].lastIndexOf('{');
      const endOffset = (matchingBrace(file.masked, opening) ?? opening) + 1;
      addCallable({
        startOffset: match.index,
        name,
        nameOffset,
        signatureEndOffset: opening,
        endOffset,
      });
    }
  }

  // Constructors, expression-bodied C# methods, and declaration-only
  // interface/abstract methods are part of the target workspace inventory too.
  // Keeping them in the same StaticSymbol/IR path means 01B does not invent a
  // second parser or a second symbol identity scheme.
  const constructorPattern = /^[ \t]*(?:(?:public|protected|private|internal|static|extern|unsafe)\s+)*([A-Za-z_$][\w$]*)\s*\([^;{}()]*\)\s*(?:throws\s+[^{};]+)?\{/gm;
  for (const match of file.masked.matchAll(constructorPattern)) {
    if (!match[1] || match.index === undefined) continue;
    const name = match[1];
    const nameOffset = match.index + match[0].lastIndexOf(name);
    const opening = match.index + match[0].lastIndexOf('{');
    const endOffset = (matchingBrace(file.masked, opening) ?? opening) + 1;
    addCallable({
      startOffset: match.index,
      name,
      nameOffset,
      signatureEndOffset: opening,
      endOffset,
      kind: 'constructor',
    });
  }

  if (file.dialect === 'C#') {
    const expressionBodyPattern = /^[ \t]*(?:(?:public|protected|private|internal|static|virtual|override|async|sealed|new|unsafe|partial)\s+)*(?:<[^>\n]+>\s+)?[A-Za-z_$][\w$<>.?\[\],]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}()]*\)\s*=>[^;]*;/gm;
    for (const match of file.masked.matchAll(expressionBodyPattern)) {
      if (!match[1] || match.index === undefined) continue;
      const name = match[1];
      const nameOffset = match.index + match[0].lastIndexOf(name);
      const arrow = match.index + match[0].indexOf('=>');
      addCallable({
        startOffset: match.index,
        name,
        nameOffset,
        signatureEndOffset: arrow,
        endOffset: match.index + match[0].length,
      });
    }
  }

  const declarationOnlyPattern = /^[ \t]*(?:(?:public|protected|private|internal|static|final|abstract|virtual|override|async|synchronized|sealed|new|extern|unsafe|partial|default|native|strictfp)\s+)*(?:<[^>\n]+>\s+)?[A-Za-z_$][\w$<>.?\[\],]*\s+([A-Za-z_$][\w$]*)\s*\([^;{}()]*\)\s*(?:throws\s+[^{};]+)?;/gm;
  for (const match of file.masked.matchAll(declarationOnlyPattern)) {
    if (!match[1] || match.index === undefined) continue;
    const name = match[1];
    const nameOffset = match.index + match[0].lastIndexOf(name);
    const semicolon = match.index + match[0].lastIndexOf(';');
    addCallable({
      startOffset: match.index,
      name,
      nameOffset,
      signatureEndOffset: semicolon,
      endOffset: semicolon + 1,
    });
  }

  const enclosingMethod = (offset: number): StaticSymbol | undefined => {
    const matching = methodRanges.filter((method) => method.startOffset <= offset && offset <= method.endOffset);
    matching.sort((left, right) =>
      (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset),
    );
    return matching[0]?.symbol;
  };

  // Collect declared fields and C# auto-properties so member-access edges can
  // point at a concrete symbol when a unique declaration is available.  The
  // declaration patterns intentionally remain conservative: local variables
  // inside a method are ignored by the enclosing-method check below.
  const memberSymbols: StaticSymbol[] = [];
  const memberDeclarations = file.dialect === 'Java'
    ? /^[ \t]*(?:(?:public|protected|private|static|final|volatile|transient|synchronized|native|abstract|strictfp)\s+)*([A-Za-z_$][\w$]*(?:\s*<[^;\n{}()]*>)?(?:\s*\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?==|;|,)/gm
    : /^[ \t]*(?:(?:public|protected|private|internal|static|readonly|const|volatile|new|unsafe|required|abstract|virtual|override|sealed|extern|partial)\s+)*([A-Za-z_][\w]*(?:\s*<[^;\n{}()]*>)?(?:\s*\[\])?)\s+([A-Za-z_][\w]*)\s*(?==|;|,)/gm;
  for (const match of file.masked.matchAll(memberDeclarations)) {
    if (!match[1] || !match[2] || match.index === undefined) continue;
    const offset = match.index;
    if (enclosingMethod(offset)) continue;
    const owner = enclosingType(offset);
    if (!owner || offset < owner.headerEnd) continue;
    const name = match[2];
    const nameOffset = match.index + match[0].lastIndexOf(name);
    const qualified = `${owner.symbol.qualifiedName}.${name}`;
    const member: StaticSymbol = {
      id: symbolId(file, 'field', qualified, nameOffset),
      kind: 'field',
      language: file.languageId,
      name,
      qualifiedName: qualified,
      path: file.path,
      project: file.project,
      range: rangeForOffsets(file, starts, match.index, nameOffset + name.length),
      signature: normalizeSignature(file.content.slice(match.index, nameOffset + name.length)),
      returnShape: normalizeSignature(match[1]),
      visibility: deepDeclarationVisibility(
        file,
        nameOffset,
        'member',
        true,
        owner.symbol.kind === 'interface',
      ),
      containerSymbolId: owner.symbol.id,
      testOnly: file.role === 'test',
    };
    memberSymbols.push(member);
  }

  if (file.dialect === 'C#') {
    const propertyPattern = /^[ \t]*(?:(?:public|protected|private|internal|static|readonly|new|abstract|virtual|override|sealed|partial|required)\s+)*([A-Za-z_][\w]*(?:\s*<[^;\\n{}()]*>)?(?:\s*\[\])?)\s+([A-Za-z_][\w]*)\s*\{(?=[^{}]*(?:\bget\b|\bset\b|\binit\b))/gm;
    for (const match of file.masked.matchAll(propertyPattern)) {
      if (!match[1] || !match[2] || match.index === undefined) continue;
      const offset = match.index;
      if (enclosingMethod(offset)) continue;
      const owner = enclosingType(offset);
      if (!owner || offset < owner.headerEnd) continue;
      const name = match[2];
      const nameOffset = match.index + match[0].lastIndexOf(name);
      const qualified = `${owner.symbol.qualifiedName}.${name}`;
      const property: StaticSymbol = {
        id: symbolId(file, 'property', qualified, nameOffset),
        kind: 'property',
        language: file.languageId,
        name,
        qualifiedName: qualified,
        path: file.path,
        project: file.project,
        range: rangeForOffsets(file, starts, match.index, nameOffset + name.length),
        signature: normalizeSignature(file.content.slice(match.index, nameOffset + name.length)),
        returnShape: normalizeSignature(match[1]),
        visibility: deepDeclarationVisibility(
          file,
          nameOffset,
          'member',
          true,
          owner.symbol.kind === 'interface',
        ),
        containerSymbolId: owner.symbol.id,
        testOnly: file.role === 'test',
      };
      memberSymbols.push(property);
    }
  }

  // Calls are retained as syntactic references.  We deliberately keep the
  // complete receiver expression (for example `helper.execute`) as evidence;
  // resolution can then use either the qualified name or a uniquely matching
  // method declaration without guessing a receiver type.
  const invocationPattern = /\b([A-Za-z_$][\w$]*(?:(?:\s*\.\s*|::\s*)[A-Za-z_$][\w$]*)*)\s*(?:<[^;{}()]*>\s*)?\(/g;
  const skippedInvocations = new Set(['if', 'for', 'while', 'switch', 'catch', 'foreach', 'using', 'lock', 'nameof', 'typeof', 'sizeof']);
  for (const match of file.masked.matchAll(invocationPattern)) {
    if (!match[1] || match.index === undefined) continue;
    const targetReference = match[1].replace(/\s+/g, '');
    const name = simpleName(targetReference);
    if (skippedInvocations.has(name)) continue;
    const nameOffset = match.index + match[0].lastIndexOf(name);
    if (methodRanges.some((method) => method.nameOffset === nameOffset)) continue;
    const ownerType = enclosingType(match.index);
    if (!ownerType) continue;
    const ownerMethod = enclosingMethod(match.index);
    references.push({
      kind: 'invocation',
      namespaceOrPackage: ownerType.namespaceOrPackage,
      sourceSymbolId: ownerMethod?.id ?? ownerType.symbol.id,
      targetReference,
      range: rangeForOffsets(file, starts, match.index, nameOffset + name.length),
    });
  }

  // A member access is a dotted expression which is not itself a call.  Import
  // and type-header tokens are intentionally excluded so they remain represented
  // by their dedicated import/inheritance/type-reference edges.
  const memberAccessPattern = /\b([A-Za-z_$][\w$]*(?:(?:\s*\.\s*|::\s*)[A-Za-z_$][\w$]*)+)\b/g;
  for (const match of file.masked.matchAll(memberAccessPattern)) {
    if (!match[1] || match.index === undefined) continue;
    const targetReference = match[1].replace(/\s+/g, '');
    const name = simpleName(targetReference);
    const nameOffset = match.index + match[0].lastIndexOf(name);
    const after = file.masked.slice(match.index + match[0].length).match(/^\s*/)?.[0].length ?? 0;
    if (file.masked[match.index + match[0].length + after] === '(') continue;
    if (parsed.imports.some((entry) => entry.range.startLine === lineAndColumn(starts, match.index).line)) continue;
    const ownerType = enclosingType(match.index);
    if (!ownerType || match.index < ownerType.headerEnd) continue;
    const ownerMethod = enclosingMethod(match.index);
    references.push({
      kind: 'member-access',
      namespaceOrPackage: ownerType.namespaceOrPackage,
      sourceSymbolId: ownerMethod?.id ?? ownerType.symbol.id,
      targetReference,
      range: rangeForOffsets(file, starts, match.index, nameOffset + name.length),
    });
  }

  return { references, symbols: [...methods, ...memberSymbols] };
}

function deepRepositoryLanguageAnalysis(
  file: RepositoryFile,
  reportDiagnostic: RepositoryAnalysisDiagnosticReporter,
): RepositoryLanguageAnalysis {
  const parsed = parseTypes(file, reportDiagnostic);
  const methodAnalysis = parseMethodsAndSignatureReferences(parsed);
  const { dialect: _dialect, ...sourceFile } = file;
  return {
    file: sourceFile,
    imports: parsed.imports,
    ...(parsed.namespaceOrPackage ? { namespaceOrPackage: parsed.namespaceOrPackage } : {}),
    references: [
      ...parsed.types.flatMap((type) => type.typeReferences),
      ...methodAnalysis.references,
    ],
    symbols: [
      ...parsed.types.map((type) => type.symbol),
      ...methodAnalysis.symbols,
    ],
  };
}

function createDeepRepositoryLanguageAdapter(input: {
  id?: string;
  version?: string;
  languageId: LanguageId;
  dialect: RepositoryParserDialect;
  fileExtensions: readonly string[];
  configurationFileNames?: readonly string[];
  configurationFileExtensions?: readonly string[];
  capabilities?: readonly AnalysisCapability[];
  configurationHash?: string;
}): RepositoryLanguageAdapter {
  const capabilities = input.capabilities ?? [
    'file-inventory',
    'symbol-index',
    'api-surface',
    'dependency-graph',
    'semantic-binding',
    'test-association',
    ...(input.configurationFileNames || input.configurationFileExtensions
      ? ['project-model' as const]
      : []),
  ];
  const configurationHash = input.configurationHash ?? sha256(canonicalJson({
    dialect: input.dialect,
    fileExtensions: normalizedRoutes(input.fileExtensions),
    configurationFileNames: normalizedRoutes(input.configurationFileNames ?? []),
    configurationFileExtensions: normalizedRoutes(input.configurationFileExtensions ?? []),
  }));
  return {
    id: input.id ?? defaultLanguageAdapterId(input.languageId),
    version: input.version ?? '1.0.0-deep',
    languageId: input.languageId,
    capabilities: sortedUnique(capabilities),
    configurationHash,
    fileExtensions: input.fileExtensions,
    ...(input.configurationFileNames
      ? { configurationFileNames: input.configurationFileNames }
      : {}),
    ...(input.configurationFileExtensions
      ? { configurationFileExtensions: input.configurationFileExtensions }
      : {}),
    analysisLevel: 'deep',
    compilerProbeLanguage: input.dialect,
    analyze(file, reportDiagnostic) {
      return deepRepositoryLanguageAnalysis(
        { ...file, dialect: input.dialect },
        reportDiagnostic,
      );
    },
  };
}

function genericQualifiedName(file: RepositoryAnalysisSourceFile, name: string): string {
  const moduleName = file.path
    .replace(/\.[^/.]+$/, '')
    .replaceAll('/', '.');
  return moduleName ? `${moduleName}.${name}` : name;
}

interface GenericSymbolMatch {
  kind: 'class' | 'function';
  line: number;
  name: string;
  signature: string;
}

const builtInExtractorDialects: Readonly<Record<string, Language>> = {
  typescript: 'TypeScript',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
};

function genericSymbolMatches(source: string, languageId: LanguageId): GenericSymbolMatch[] {
  const dialect = builtInExtractorDialects[languageId.toLowerCase()];
  if (dialect) return extractSymbols(source, dialect);

  const matches: GenericSymbolMatch[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const declarations: Array<{ kind: GenericSymbolMatch['kind']; pattern: RegExp }> = [
    {
      kind: 'class',
      pattern: /\b(?:class|interface|record|struct|enum|trait|type)\s+([A-Za-z_$][\w$]*)/,
    },
    {
      kind: 'function',
      pattern: /\b(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/,
    },
  ];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const declaration of declarations) {
      const match = declaration.pattern.exec(line);
      if (!match?.[1]) continue;
      matches.push({
        kind: declaration.kind,
        line: index + 1,
        name: match[1],
        signature: line.trim().replace(/\s+/g, ' ').slice(0, 1000),
      });
      break;
    }
  }
  return matches;
}

function genericSymbolFacts(
  languageId: LanguageId,
  match: GenericSymbolMatch,
): Pick<StaticSymbol, 'visibility' | 'exported' | 'parameters' | 'returnShape'> {
  const language = languageId.toLowerCase();
  const signature = match.signature.trim();
  let visibility: StaticSymbolVisibility | undefined;
  let exported: boolean | undefined;

  if (language === 'typescript') {
    const declared = explicitVisibility(signature);
    const isMember = match.kind === 'function' && !/\bfunction\b/.test(signature);
    visibility = declared ?? (isMember ? 'public' : undefined);
    if (!isMember) exported = /^export\b/.test(signature);
  } else if (language === 'rust') {
    if (/^pub\s+/.test(signature)) exported = true;
    else if (/^pub\s*\([^)]*\)/.test(signature)) visibility = 'internal';
    else exported = false;
  } else if (language === 'go') {
    exported = /^[A-Z]/.test(match.name);
  } else if (language === 'python') {
    // Python has no declaration-level export keyword. This is a convention fact,
    // and the bridge deliberately reports its surface as partial rather than exact.
    exported = !match.name.startsWith('_');
  } else {
    visibility = 'unknown';
  }

  const shape = match.kind === 'function'
    ? callableShape(match.signature, languageId, match.name)
    : {};
  return {
    ...(visibility ? { visibility } : {}),
    ...(exported !== undefined ? { exported } : {}),
    ...shape,
  };
}

/**
 * Build a deterministic lightweight adapter. Known built-ins reuse the retrieval
 * extractor; unknown language IDs still receive language-neutral declarations
 * and an explicit capability-boundary diagnostic instead of being dropped.
 */
export function createGenericRepositoryLanguageAdapter(input: {
  id?: string;
  version?: string;
  languageId: LanguageId;
  fileExtensions: readonly string[];
  configurationFileNames?: readonly string[];
  configurationFileExtensions?: readonly string[];
  capabilities?: readonly AnalysisCapability[];
  configurationHash?: string;
}): RepositoryLanguageAdapter {
  const hasBuiltInSurfaceRules = builtInExtractorDialects[input.languageId.toLowerCase()] !== undefined;
  const capabilities = input.capabilities ?? [
    'file-inventory',
    'symbol-index',
    ...(hasBuiltInSurfaceRules ? ['api-surface' as const] : []),
    'test-association',
    ...(input.configurationFileNames || input.configurationFileExtensions
      ? ['project-model' as const]
      : []),
  ];
  const configurationHash = input.configurationHash ?? sha256(canonicalJson({
    extractorDialect: builtInExtractorDialects[input.languageId.toLowerCase()] ?? 'generic-line-slice',
    fileExtensions: normalizedRoutes(input.fileExtensions),
    configurationFileNames: normalizedRoutes(input.configurationFileNames ?? []),
    configurationFileExtensions: normalizedRoutes(input.configurationFileExtensions ?? []),
  }));
  return {
    id: input.id ?? defaultLanguageAdapterId(input.languageId),
    version: input.version ?? '1.0.0-generic',
    languageId: input.languageId,
    capabilities: sortedUnique(capabilities),
    configurationHash,
    fileExtensions: input.fileExtensions,
    ...(input.configurationFileNames
      ? { configurationFileNames: input.configurationFileNames }
      : {}),
    ...(input.configurationFileExtensions
      ? { configurationFileExtensions: input.configurationFileExtensions }
      : {}),
    analysisLevel: 'generic',
    analyze(file, reportDiagnostic) {
      const symbols = genericSymbolMatches(file.content, input.languageId).map((match) => {
        const qualifiedName = genericQualifiedName(file, match.name);
        const kind: StaticSymbolKind = match.kind;
        return {
          id: symbolId(file, kind, qualifiedName, match.line),
          kind,
          language: input.languageId,
          name: match.name,
          qualifiedName,
          path: file.path,
          project: file.project,
          range: {
            path: file.path,
            startLine: match.line,
            startColumn: 1,
          },
          signature: match.signature,
          ...genericSymbolFacts(input.languageId, match),
          testOnly: file.role === 'test',
        } satisfies StaticSymbol;
      });
      reportDiagnostic({
        severity: 'info',
        code: 'GENERIC_LANGUAGE_STATIC_SLICE',
        message: `${input.languageId} file was analysed with generic declaration slicing; dependency and compiler-semantic evidence is not available for this adapter.`,
        path: file.path,
      });
      return { file, imports: [], references: [], symbols };
    },
  };
}

/** Built-ins are replaceable as a whole by passing a registry to analyzeRepository. */
export function createDefaultRepositoryLanguageRegistry(): RepositoryLanguageRegistry {
  return new RepositoryLanguageRegistry([
    createDeepRepositoryLanguageAdapter({
      languageId: 'java',
      dialect: 'Java',
      fileExtensions: ['.java'],
      configurationFileNames: [
        'pom.xml',
        'build.gradle',
        'build.gradle.kts',
        'settings.gradle',
        'settings.gradle.kts',
      ],
    }),
    createDeepRepositoryLanguageAdapter({
      languageId: 'csharp',
      dialect: 'C#',
      fileExtensions: ['.cs'],
      configurationFileExtensions: ['.csproj', '.sln'],
    }),
    createGenericRepositoryLanguageAdapter({
      languageId: 'typescript',
      fileExtensions: ['.ts'],
      configurationFileNames: ['package.json'],
    }),
    createGenericRepositoryLanguageAdapter({
      languageId: 'python',
      fileExtensions: ['.py'],
      configurationFileNames: ['pyproject.toml'],
    }),
    createGenericRepositoryLanguageAdapter({
      languageId: 'rust',
      fileExtensions: ['.rs'],
      configurationFileNames: ['cargo.toml'],
    }),
    createGenericRepositoryLanguageAdapter({
      languageId: 'go',
      fileExtensions: ['.go'],
      configurationFileNames: ['go.mod'],
    }),
  ]);
}

function projectLanguageId(file: RepositoryFile): LanguageId | undefined {
  return file.projectLanguageId;
}

function projectRoot(file: RepositoryFile): string {
  const slash = file.path.lastIndexOf('/');
  return slash === -1 ? '' : file.path.slice(0, slash);
}

function withinProject(filePath: string, projectDirectory: string): boolean {
  return projectDirectory === '' || filePath === projectDirectory || filePath.startsWith(`${projectDirectory}/`);
}

function assignProjects(files: RepositoryFile[]): StaticSymbol[] {
  const projectFiles = files.filter(
    (file) => file.role === 'configuration' && projectLanguageId(file),
  );
  const projectSymbols: StaticSymbol[] = [];
  for (const config of projectFiles) {
    const languageId = projectLanguageId(config);
    if (!languageId) continue;
    const name = config.path.split('/').at(-1) ?? config.path;
    projectSymbols.push({
      id: symbolId(config, 'project', config.path, 0),
      kind: 'project',
      language: languageId,
      name,
      qualifiedName: config.path,
      path: config.path,
      range: { path: config.path, startLine: 1, startColumn: 1 },
      signature: name,
    });
  }

  for (const file of files) {
    if (!file.languageId) continue;
    const candidates = projectFiles.filter(
      (project) =>
        projectLanguageId(project) === file.languageId &&
        withinProject(file.path, projectRoot(project)),
    );
    candidates.sort((left, right) => {
      const lengthDifference = projectRoot(right).length - projectRoot(left).length;
      return lengthDifference || compareText(left.path, right.path);
    });
    file.project = candidates[0]?.path;
  }
  return projectSymbols;
}

function simpleName(qualified: string): string {
  const normalized = qualified.replace(/^global::/, '').replaceAll('::', '.');
  return normalized.split('.').at(-1) ?? normalized;
}

function typeSymbols(symbols: StaticSymbol[]): StaticSymbol[] {
  return symbols.filter((symbol) =>
    ['class', 'interface', 'record', 'struct', 'enum'].includes(symbol.kind),
  );
}

function uniqueSymbols(symbols: StaticSymbol[]): StaticSymbol[] {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  return [...byId.values()].sort((left, right) => compareText(left.id, right.id));
}

function packagePrefixExists(symbols: StaticSymbol[], reference: string): boolean {
  const normalized = reference.replace(/^global::/, '').replaceAll('::', '.');
  const segments = normalized.split('.');
  segments.pop();
  const prefix = segments.join('.');
  return Boolean(prefix) && symbols.some((symbol) => symbol.qualifiedName.startsWith(`${prefix}.`));
}

function normalizedTypeReference(reference: string): string {
  return reference
    .replace(/^global::/, '')
    .replaceAll('::', '.')
    .replace(/<.*$/, '')
    .replace(/\[\]$/g, '')
    .replace(/\?$/g, '');
}

function ownerTypeCandidates(
  source: RepositoryLanguageAnalysis,
  typeReference: string,
  symbolIndex: StaticSymbol[],
): StaticSymbol[] {
  const normalized = normalizedTypeReference(typeReference);
  if (!normalized) return [];
  const typeIndex = typeSymbols(symbolIndex).filter(
    (symbol) => symbol.language === source.file.languageId,
  );
  const simple = simpleName(normalized);
  const candidates: StaticSymbol[] = [];
  const byQualified = (qualified: string): StaticSymbol[] =>
    typeIndex.filter((symbol) => symbol.qualifiedName === qualified);
  if (normalized.includes('.')) candidates.push(...byQualified(normalized));
  if (!normalized.includes('.') && source.namespaceOrPackage) {
    candidates.push(...byQualified(`${source.namespaceOrPackage}.${simple}`));
  }
  for (const imported of source.imports) {
    const importTarget = normalizedTypeReference(imported.targetReference);
    if (importTarget.endsWith('.*')) {
      candidates.push(...byQualified(`${importTarget.slice(0, -2)}.${simple}`));
    } else {
      candidates.push(...byQualified(`${importTarget}.${simple}`));
      if (simpleName(importTarget) === simple) candidates.push(...byQualified(importTarget));
    }
  }
  if (candidates.length === 0) {
    candidates.push(...typeIndex.filter((symbol) => symbol.name === simple));
  }
  return uniqueSymbols(candidates);
}

function declaredReceiverTypes(source: RepositoryLanguageAnalysis, receiver: string): string[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(receiver)) return [];
  const escaped = receiver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `var` and dynamically typed declarations are intentionally excluded:
  // their receiver type is not syntactically proven.
  const expression = new RegExp(
    `\\b([A-Z][\\w$]*(?:(?:\\s*\\.|::\\s*)[A-Za-z_$][\\w$]*)*(?:\\s*<[^;=,(){}\\n]*>)?(?:\\s*\\[\\])?)\\s+${escaped}\\b`,
    'g',
  );
  const types = new Set<string>();
  for (const match of source.file.masked.matchAll(expression)) {
    if (match[1]) types.add(normalizedTypeReference(match[1].replace(/\s+/g, '')));
  }
  return [...types].sort(compareText);
}

function callableOwnerTypes(
  source: RepositoryLanguageAnalysis,
  reference: RepositoryLanguageReference | ImportReference,
  normalized: string,
  symbolIndex: StaticSymbol[],
): StaticSymbol[] {
  const pieces = normalized.split('.');
  if (pieces.length < 2) return [];
  const ownerReference = pieces.slice(0, -1).join('.');
  const sourceSymbol = 'sourceSymbolId' in reference && reference.sourceSymbolId
    ? symbolIndex.find((symbol) => symbol.id === reference.sourceSymbolId)
    : undefined;
  const sourceOwner = sourceSymbol?.qualifiedName.slice(0, sourceSymbol.qualifiedName.lastIndexOf('.'));
  const possibleTypes = new Set<string>();

  if (ownerReference === 'this' && sourceOwner) possibleTypes.add(sourceOwner);
  // A type-like receiver has direct namespace/import evidence. A lower-case
  // receiver is only admitted when a concrete declaration proves its type.
  if (/^[A-Z]/.test(ownerReference) || ownerReference.includes('.')) {
    possibleTypes.add(ownerReference);
  } else {
    for (const type of declaredReceiverTypes(source, ownerReference)) possibleTypes.add(type);
  }

  return uniqueSymbols([...possibleTypes].flatMap((type) =>
    ownerTypeCandidates(source, type, symbolIndex),
  ));
}

function resolveReference(
  source: RepositoryLanguageAnalysis,
  reference: RepositoryLanguageReference | ImportReference,
  symbolIndex: StaticSymbol[],
  allowNamespaceTarget: boolean,
): Resolution {
  const normalized = normalizedTypeReference(reference.targetReference);
  const referenceKind = 'kind' in reference ? reference.kind : undefined;
  const callableReference = referenceKind === 'invocation' || referenceKind === 'member-access';
  const memberReference = referenceKind === 'member-access';
  const sameLanguage = symbolIndex.filter((symbol) =>
    symbol.language === source.file.languageId && (
      ['class', 'interface', 'record', 'struct', 'enum'].includes(symbol.kind) ||
      (allowNamespaceTarget && (symbol.kind === 'package' || symbol.kind === 'namespace')) ||
      (callableReference && (
        memberReference
          ? ['field', 'property'].includes(symbol.kind)
          : ['method', 'constructor', 'function'].includes(symbol.kind)
      ))
    ),
  );
  const byQualified = (qualified: string): StaticSymbol[] =>
    sameLanguage.filter((symbol) => symbol.qualifiedName === qualified);
  const byQualifiedSuffix = (qualified: string): StaticSymbol[] =>
    sameLanguage.filter((symbol) => symbol.qualifiedName.endsWith(`.${qualified}`));
  const bySimple = (name: string): StaticSymbol[] =>
    sameLanguage.filter((symbol) => symbol.name === name);
  const simple = simpleName(normalized);
  const namespaceOrPackage = 'namespaceOrPackage' in reference
    ? reference.namespaceOrPackage ?? source.namespaceOrPackage
    : source.namespaceOrPackage;
  const candidates: StaticSymbol[] = [];
  let provenCallableOwners: StaticSymbol[] = [];

  if (callableReference) {
    const sourceSymbol = 'sourceSymbolId' in reference && reference.sourceSymbolId
      ? symbolIndex.find((symbol) => symbol.id === reference.sourceSymbolId)
      : undefined;
    const ownerQualifiedName = sourceSymbol?.qualifiedName?.slice(0, sourceSymbol.qualifiedName.lastIndexOf('.'));
    if (!normalized.includes('.') && ownerQualifiedName) {
      candidates.push(...byQualified(`${ownerQualifiedName}.${simple}`));
    } else if (normalized.includes('.')) {
      provenCallableOwners = callableOwnerTypes(source, reference, normalized, symbolIndex);
      for (const owner of provenCallableOwners) {
        candidates.push(...byQualified(`${owner.qualifiedName}.${simple}`));
      }
      // Fully-qualified type receivers are independently meaningful syntax;
      // variable receivers are not allowed to resolve by a suffix guess.
      if (/^[A-Z]/.test(normalized) || normalized.split('.').slice(0, -1).some((part) => /^[A-Z]/.test(part))) {
        candidates.push(...byQualifiedSuffix(normalized));
      }
    }
  }

  if (normalized.includes('.')) candidates.push(...byQualified(normalized));
  if (!callableReference) {
    if (!normalized.includes('.') && namespaceOrPackage) {
      candidates.push(...byQualified(`${namespaceOrPackage}.${simple}`));
    }
    for (const imported of source.imports) {
      const importTarget = imported.targetReference;
      if (importTarget.endsWith('.*')) {
        candidates.push(...byQualified(`${importTarget.slice(0, -2)}.${simple}`));
      } else {
        candidates.push(...byQualified(`${importTarget}.${simple}`));
      }
      if (simpleName(importTarget) === simple) candidates.push(...byQualified(importTarget));
    }
  }
  const qualifiedCallable = callableReference && normalized.includes('.');
  if (!qualifiedCallable && (!normalized.includes('.') || candidates.length === 0)) {
    candidates.push(...bySimple(simple));
  }
  const unique = uniqueSymbols(candidates);
  if (unique.length === 1) return { candidates: unique, internal: true, status: 'resolved' };
  if (unique.length > 1) return { candidates: unique, internal: true, status: 'ambiguous' };

  const possibleInternal =
    packagePrefixExists(sameLanguage, normalized) ||
    (namespaceOrPackage !== undefined && namespaceOrPackage === normalized.split('.').slice(0, -1).join('.')) ||
    source.imports.some((entry) => packagePrefixExists(sameLanguage, entry.targetReference)) ||
    provenCallableOwners.length > 0 ||
    (callableReference && sameLanguage.some((symbol) => symbol.name === simple));
  return { candidates: [], internal: possibleInternal, status: 'unresolved' };
}

function edgeDraft(
  parsed: RepositoryLanguageAnalysis,
  reference: RepositoryLanguageReference | ImportReference,
  kind: DependencyKind,
  symbolIndex: StaticSymbol[],
): EdgeDraft {
  const resolution = resolveReference(parsed, reference, symbolIndex, kind === 'import');
  const target = resolution.status === 'resolved' ? resolution.candidates[0] : undefined;
  const effectiveKind: DependencyKind = parsed.file.role === 'test' && kind !== 'project-reference'
    ? 'test-reference'
    : kind;
  return {
    kind: effectiveKind,
    sourcePath: parsed.file.path,
    ...(('sourceSymbolId' in reference && reference.sourceSymbolId
      ? { sourceSymbolId: reference.sourceSymbolId }
      : {})),
    ...(target ? { targetPath: target.path, targetSymbolId: target.id } : {}),
    targetReference: reference.targetReference,
    internal: resolution.internal,
    resolution: resolution.status,
    evidence: resolution.status === 'resolved'
      ? 'syntactic'
      : resolution.status === 'ambiguous'
        ? 'ambiguous'
        : 'unresolved',
    evidenceRanges: [reference.range],
  };
}

/**
 * The fields that describe an edge independently from its snapshot-local ID.
 * Keeping this projection separate lets the snapshot identity bind every
 * dependency without making `snapshotId -> edge.id -> snapshotId` circular.
 */
interface DependencyEdgeIdentityInput {
  kind: DependencyKind;
  sourcePath: string;
  sourceSymbolId?: string;
  targetPath?: string;
  targetSymbolId?: string;
  targetReference?: string;
  internal: boolean;
  resolution: DependencyResolutionStatus;
  evidence: DependencyEvidenceLevel;
  evidenceRanges: StaticSourceRange[];
}

function dependencyEdgeEvidence(edge: DependencyEdgeIdentityInput): Record<string, unknown> {
  return {
    sourcePath: edge.sourcePath,
    ...(edge.sourceSymbolId ? { sourceSymbolId: edge.sourceSymbolId } : {}),
    ...(edge.targetPath ? { targetPath: edge.targetPath } : {}),
    ...(edge.targetSymbolId ? { targetSymbolId: edge.targetSymbolId } : {}),
    kind: edge.kind,
    internal: edge.internal,
    resolution: edge.resolution,
    evidence: edge.evidence,
    evidenceRanges: edge.evidenceRanges,
    ...(edge.targetReference !== undefined ? { targetReference: edge.targetReference } : {}),
  };
}

/**
 * Preserve every serialized edge field in the snapshot content hash except
 * the two derived fields that would create a circular identity calculation.
 */
function dependencyEdgeSnapshotEvidence(edge: DependencyEdge): Record<string, unknown> {
  const { id: _id, snapshotId: _snapshotId, ...evidence } = edge;
  return evidence;
}

function edgeId(edge: DependencyEdgeIdentityInput, snapshotId: string): string {
  return `edge:${sha256(canonicalJson({
    snapshotId,
    ...dependencyEdgeEvidence(edge),
  })).slice(0, 24)}`;
}

function finalizeEdges(drafts: EdgeDraft[], snapshotId: string): DependencyEdge[] {
  const unique = new Map<string, EdgeDraft>();
  for (const draft of drafts) {
    const id = edgeId(draft, snapshotId);
    if (!unique.has(id)) unique.set(id, draft);
  }
  return [...unique.entries()]
    .map(([id, draft]) => ({
      id,
      sourcePath: draft.sourcePath,
      ...(draft.sourceSymbolId ? { sourceSymbolId: draft.sourceSymbolId } : {}),
      ...(draft.targetPath ? { targetPath: draft.targetPath } : {}),
      ...(draft.targetSymbolId ? { targetSymbolId: draft.targetSymbolId } : {}),
      kind: draft.kind,
      internal: draft.internal,
      resolution: draft.resolution,
      evidence: draft.evidence,
      evidenceRanges: draft.evidenceRanges,
      snapshotId,
      ...(draft.targetReference !== undefined ? { targetReference: draft.targetReference } : {}),
    }))
    .sort((left, right) => compareText(left.id, right.id));
}

function sameRange(left: StaticSourceRange, right: StaticSourceRange): boolean {
  return (
    left.path === right.path &&
    left.startLine === right.startLine &&
    left.startColumn === right.startColumn &&
    left.endLine === right.endLine &&
    left.endColumn === right.endColumn
  );
}

function isStaticSourceRange(value: unknown): value is StaticSourceRange {
  if (typeof value !== 'object' || value === null) return false;
  const range = value as Partial<StaticSourceRange>;
  return (
    typeof range.path === 'string' &&
    typeof range.startLine === 'number' &&
    (range.startColumn === undefined || typeof range.startColumn === 'number') &&
    (range.endLine === undefined || typeof range.endLine === 'number') &&
    (range.endColumn === undefined || typeof range.endColumn === 'number')
  );
}

function isSemanticDependencyBinding(value: unknown): value is SemanticDependencyBinding {
  if (typeof value !== 'object' || value === null) return false;
  const binding = value as Partial<SemanticDependencyBinding>;
  return (
    typeof binding.sourcePath === 'string' &&
    typeof binding.targetPath === 'string' &&
    typeof binding.kind === 'string' &&
    isStaticSourceRange(binding.evidenceRange) &&
    (binding.sourceSymbolId === undefined || typeof binding.sourceSymbolId === 'string') &&
    (binding.targetSymbolId === undefined || typeof binding.targetSymbolId === 'string')
  );
}

function semanticBindingKey(binding: SemanticDependencyBinding): string {
  return canonicalJson(binding);
}

function semanticCandidates(
  drafts: EdgeDraft[],
  filesByPath: ReadonlyMap<string, RepositoryFile>,
  languageId: LanguageId,
): SemanticDependencyBinding[] {
  const candidates = new Map<string, SemanticDependencyBinding>();
  for (const draft of drafts) {
    const source = filesByPath.get(draft.sourcePath);
    const target = draft.targetPath ? filesByPath.get(draft.targetPath) : undefined;
    const sourceLanguageId = source?.languageId ?? (source ? projectLanguageId(source) : undefined);
    const targetLanguageId = target?.languageId ?? (target ? projectLanguageId(target) : undefined);
    const range = draft.evidenceRanges[0];
    if (
      sourceLanguageId !== languageId ||
      targetLanguageId !== languageId ||
      !draft.internal ||
      draft.resolution !== 'resolved' ||
      draft.evidence !== 'syntactic' ||
      !draft.targetPath ||
      !range
    ) {
      continue;
    }
    const binding: SemanticDependencyBinding = {
      sourcePath: draft.sourcePath,
      targetPath: draft.targetPath,
      kind: draft.kind,
      evidenceRange: range,
      ...(draft.sourceSymbolId ? { sourceSymbolId: draft.sourceSymbolId } : {}),
      ...(draft.targetSymbolId ? { targetSymbolId: draft.targetSymbolId } : {}),
    };
    candidates.set(semanticBindingKey(binding), binding);
  }
  return [...candidates.values()].sort((left, right) => compareText(
    semanticBindingKey(left),
    semanticBindingKey(right),
  ));
}

function validProbeStatus(value: unknown): value is CompilerProbeStatus {
  return value === 'available' || value === 'unavailable' || value === 'failed';
}

async function systemCompilerProbe(request: CompilerProbeRequest): Promise<CompilerProbeResult> {
  return probeSystemCompilerSemantics(request);
}

function appendProbeDiagnostics(
  diagnostics: StaticAnalysisDiagnostic[],
  language: 'Java' | 'C#',
  result: CompilerProbeResult,
  appliedBindingCount = 0,
): void {
  const supplied: unknown[] = Array.isArray(result.diagnostics) ? result.diagnostics : [];
  if (result.diagnostics !== undefined && !Array.isArray(result.diagnostics)) {
    diagnostic(diagnostics, {
      severity: 'warn',
      code: 'INVALID_COMPILER_PROBE_DIAGNOSTICS',
      message: `${language} compiler probe returned invalid diagnostics; preserving syntactic evidence.`,
    });
  }
  if (supplied.length > 0) {
    for (const item of supplied) {
      const candidate = item as Partial<CompilerProbeDiagnostic>;
      if (
        typeof item !== 'object' ||
        item === null ||
        !['info', 'warn', 'error'].includes(candidate.severity ?? '') ||
        typeof candidate.code !== 'string' ||
        !candidate.code.trim() ||
        typeof candidate.message !== 'string' ||
        !candidate.message.trim()
      ) {
        diagnostic(diagnostics, {
          severity: 'warn',
          code: 'INVALID_COMPILER_PROBE_DIAGNOSTIC',
          message: `${language} compiler probe returned an invalid diagnostic; preserving syntactic evidence.`,
        });
        continue;
      }
      diagnostic(diagnostics, {
        severity: candidate.severity as StaticAnalysisDiagnostic['severity'],
        code: candidate.code,
        message: candidate.message,
        ...(candidate.path ? { path: candidate.path } : {}),
        ...(candidate.range ? { range: candidate.range } : {}),
      });
    }
    return;
  }
  const prefix = language === 'Java' ? 'JAVA' : 'CSHARP';
  diagnostic(diagnostics, {
    severity: result.status === 'available' ? 'info' : result.status === 'unavailable' ? 'info' : 'warn',
    code: `${prefix}_COMPILER_${result.status === 'available'
      ? appliedBindingCount > 0 ? 'SEMANTIC_APPLIED' : 'PROBED'
      : result.status === 'unavailable' ? 'UNAVAILABLE' : 'PROBE_FAILED'}`,
    message: result.status === 'available'
      ? appliedBindingCount > 0
        ? `${language} compiler probe completed with ${appliedBindingCount} verified semantic binding${appliedBindingCount === 1 ? '' : 's'}.`
        : `${language} compiler probe completed without verified bindings; preserving syntactic evidence.`
      : `${language} compiler probe ${result.status}; preserving syntactic evidence.`,
  });
}

function applySemanticBindings(
  drafts: EdgeDraft[],
  bindings: readonly unknown[],
  diagnostics: StaticAnalysisDiagnostic[],
  language: 'Java' | 'C#',
): string[] {
  const applied: string[] = [];
  const seen = new Set<string>();
  for (const value of bindings) {
    if (!isSemanticDependencyBinding(value)) {
      diagnostic(diagnostics, {
        severity: 'warn',
        code: 'INVALID_SEMANTIC_BINDING',
        message: `${language} compiler probe returned an invalid semantic binding; preserving syntactic evidence.`,
      });
      continue;
    }
    const binding = value;
    const key = semanticBindingKey(binding);
    if (seen.has(key)) continue;
    seen.add(key);
    const matching = drafts.filter((draft) =>
      draft.internal &&
      draft.resolution === 'resolved' &&
      draft.evidence === 'syntactic' &&
      draft.sourcePath === binding.sourcePath &&
      draft.targetPath === binding.targetPath &&
      draft.kind === binding.kind &&
      binding.sourceSymbolId === draft.sourceSymbolId &&
      binding.targetSymbolId === draft.targetSymbolId &&
      draft.evidenceRanges.length === 1 &&
      sameRange(draft.evidenceRanges[0] as StaticSourceRange, binding.evidenceRange),
    );
    if (matching.length !== 1) {
      diagnostic(diagnostics, {
        severity: 'warn',
        code: 'SEMANTIC_BINDING_REJECTED',
        message: `${language} compiler probe binding did not exactly match one resolved syntactic edge; preserving syntactic evidence.`,
        path: binding.sourcePath,
        range: binding.evidenceRange,
      });
      continue;
    }
    const draft = matching[0];
    if (!draft) continue;
    draft.evidence = 'semantic';
    applied.push(key);
  }
  if (applied.length > 0) {
    diagnostic(diagnostics, {
      severity: 'info',
      code: 'SEMANTIC_BINDINGS_APPLIED',
      message: `${language} compiler probe verified ${applied.length} dependency binding${applied.length === 1 ? '' : 's'}.`,
    });
  }
  return applied.sort(compareText);
}

interface SemanticEnrichmentOutcome {
  appliedBindings: string[];
  compiler?: string;
  language: 'Java' | 'C#';
  status: CompilerProbeStatus;
}

async function enrichWithCompiler(
  request: AnalyzeRepositoryRequest,
  root: string,
  files: RepositoryFile[],
  drafts: EdgeDraft[],
  diagnostics: StaticAnalysisDiagnostic[],
  languageRegistry: RepositoryLanguageRegistry,
): Promise<SemanticEnrichmentOutcome[]> {
  const enabled = request.semanticEnrichment === true || request.compilerProbe !== undefined;
  if (!enabled) return [];
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const probe = request.compilerProbe ?? { probe: systemCompilerProbe };
  const outcomes: SemanticEnrichmentOutcome[] = [];
  for (const adapter of languageRegistry.adapters()) {
    const language = adapter.compilerProbeLanguage;
    if (!language) continue;
    const languageFiles = files.filter((file) =>
      file.languageId === adapter.languageId ||
      (!file.languageId && projectLanguageId(file) === adapter.languageId),
    );
    if (languageFiles.length === 0) continue;
    const candidates = semanticCandidates(drafts, filesByPath, adapter.languageId);
    let result: CompilerProbeResult;
    try {
      const probeResult: unknown = await probe.probe({
        root,
        language,
        files: languageFiles.map((file) => ({
          path: file.path,
          role: file.role,
          ...(file.project ? { project: file.project } : {}),
        })),
        candidates,
      });
      if (
        typeof probeResult !== 'object' ||
        probeResult === null ||
        !validProbeStatus((probeResult as Partial<CompilerProbeResult>).status)
      ) {
        result = {
          status: 'failed',
          diagnostics: [{
            severity: 'warn',
            code: 'INVALID_COMPILER_PROBE_RESULT',
            message: `${language} compiler probe returned an invalid status; preserving syntactic dependency evidence.`,
          }],
        };
      } else {
        result = probeResult as CompilerProbeResult;
      }
    } catch (error) {
      const prefix = language === 'Java' ? 'JAVA' : 'CSHARP';
      result = {
        status: 'failed',
        diagnostics: [{
          severity: 'warn',
          code: `${prefix}_COMPILER_PROBE_FAILED`,
          message: `${language} compiler probe threw an error; preserving syntactic dependency evidence: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
    const bindings: unknown[] = Array.isArray(result.bindings) ? result.bindings : [];
    if (result.bindings !== undefined && !Array.isArray(result.bindings)) {
      diagnostic(diagnostics, {
        severity: 'warn',
        code: 'INVALID_COMPILER_PROBE_BINDINGS',
        message: `${language} compiler probe returned invalid bindings; preserving syntactic evidence.`,
      });
    }
    const applied = result.status === 'available'
      ? applySemanticBindings(drafts, bindings, diagnostics, language)
      : [];
    appendProbeDiagnostics(diagnostics, language, result, applied.length);
    outcomes.push({
      language,
      status: result.status,
      ...(result.compiler ? { compiler: result.compiler } : {}),
      appliedBindings: applied,
    });
  }
  return outcomes;
}

function conventionalTestReferences(
  parsed: RepositoryLanguageAnalysis,
  typeIndex: StaticSymbol[],
): RepositoryLanguageReference[] {
  if (parsed.file.role !== 'test') return [];
  const base = (parsed.file.path.split('/').at(-1) ?? '')
    .replace(/\.[^.]+$/i, '')
    .replace(/(?:\.spec|\.tests?|tests?)$/i, '');
  if (!base || base === parsed.file.path) return [];
  const starts = lineStarts(parsed.file.content);
  const target = typeIndex.filter(
    (symbol) => symbol.language === parsed.file.languageId && symbol.name === base,
  );
  if (target.length !== 1) return [];
  return [{
    kind: 'test-reference',
    targetReference: base,
    range: rangeForOffsets(parsed.file, starts, 0, 0),
  }];
}

function projectReferenceDrafts(
  root: string,
  files: RepositoryFile[],
  diagnostics: StaticAnalysisDiagnostic[],
): EdgeDraft[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const drafts: EdgeDraft[] = [];
  for (const file of files) {
    if (!file.path.toLowerCase().endsWith('.csproj')) continue;
    const starts = lineStarts(file.content);
    const expression = /<ProjectReference\s+[^>]*\bInclude\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi;
    for (const match of file.content.matchAll(expression)) {
      if (!match[1] || match.index === undefined) continue;
      const include = match[1];
      const absoluteTarget = path.resolve(path.dirname(file.absolutePath), include);
      let targetPath: string | undefined;
      let internal = false;
      try {
        targetPath = canonicalPath(root, absoluteTarget);
        internal = true;
      } catch {
        // An out-of-repository ProjectReference is external evidence, not a path escape.
      }
      const targetExists = targetPath ? byPath.get(targetPath) : undefined;
      const offset = match.index + match[0].indexOf(include);
      const range = rangeForOffsets(file, starts, offset, offset + include.length);
      drafts.push({
        kind: 'project-reference',
        sourcePath: file.path,
        targetReference: include.replaceAll('\\', '/'),
        ...(targetExists ? { targetPath: targetExists.path } : {}),
        internal,
        resolution: targetExists ? 'resolved' : 'unresolved',
        evidence: targetExists ? 'syntactic' : 'unresolved',
        evidenceRanges: [range],
      });
      if (internal && !targetExists) {
        diagnostic(diagnostics, {
          severity: 'warn',
          code: 'UNRESOLVED_PROJECT_REFERENCE',
          message: `Project reference does not resolve to an analysed project: ${include}`,
          path: file.path,
          range,
        });
      }
    }
  }
  return drafts;
}

function staticFiles(files: RepositoryFile[]): StaticAnalysisFile[] {
  return files
    .map((file) => ({
      path: file.path,
      sha256: file.sha256,
      role: file.role,
      ...(file.languageId ?? file.projectLanguageId
        ? { language: file.languageId ?? file.projectLanguageId }
        : {}),
      ...(file.project ? { project: file.project } : {}),
    }))
    .sort((left, right) => compareText(left.path, right.path));
}

function canonicalEntries<T>(
  entries: readonly T[],
  project: (entry: T) => unknown,
): unknown[] {
  return entries
    .map(project)
    .sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
}

/**
 * Return the complete deterministic evidence that a static-analysis snapshot
 * promises to represent. `createdAt` is deliberately absent: it records when
 * collection happened, rather than what was collected. Dependency IDs and
 * their `snapshotId` are also absent because both are derived from this
 * evidence after the snapshot ID has been calculated.
 */
function repositoryAnalysisEvidence(
  analysis: Pick<
    RepositoryStaticAnalysis,
    'schemaVersion' | 'analyzerVersion' | 'repository' | 'analysisAdapters' | 'files' | 'symbols' | 'dependencies' | 'diagnostics'
  >,
): Record<string, unknown> {
  return {
    schemaVersion: analysis.schemaVersion,
    analyzerVersion: analysis.analyzerVersion,
    // The checkout root is expressly informational and differs between two
    // clones of the same revision. It must not change the content address of
    // the static evidence snapshot.
    repository: {
      ...(analysis.repository.id ? { id: analysis.repository.id } : {}),
      ...(analysis.repository.remote ? { remote: analysis.repository.remote } : {}),
      ...(analysis.repository.revision ? { revision: analysis.repository.revision } : {}),
    },
    ...(analysis.analysisAdapters
      ? {
          analysisAdapters: canonicalEntries(
            analysis.analysisAdapters,
            (adapter) => ({ ...adapter, capabilities: sortedUnique(adapter.capabilities) }),
          ),
        }
      : {}),
    files: canonicalEntries(analysis.files, (file) => ({ ...file })),
    symbols: canonicalEntries(analysis.symbols, (symbol) => ({ ...symbol })),
    dependencies: canonicalEntries(
      analysis.dependencies,
      (edge) => dependencyEdgeSnapshotEvidence(edge),
    ),
    diagnostics: canonicalEntries(analysis.diagnostics, (entry) => ({ ...entry })),
  };
}

/**
 * SHA-256 over all canonical static evidence, not only source file hashes.
 * This is exported so every trusted consumer can reject a partially tampered
 * sidecar artifact before exposing it to an architecture-planning model.
 */
export function repositoryAnalysisContentHash(
  analysis: Pick<
    RepositoryStaticAnalysis,
    'schemaVersion' | 'analyzerVersion' | 'repository' | 'analysisAdapters' | 'files' | 'symbols' | 'dependencies' | 'diagnostics'
  >,
): string {
  return sha256(canonicalJson(repositoryAnalysisEvidence(analysis)));
}

function snapshotIdForEvidence(
  analysis: Pick<RepositoryStaticAnalysis, 'schemaVersion' | 'analyzerVersion' | 'repository'>,
  contentHash: string,
): string {
  return `snapshot-${sha256(canonicalJson({
    schemaVersion: analysis.schemaVersion,
    analyzerVersion: analysis.analyzerVersion,
    repository: {
      ...(analysis.repository.id ? { id: analysis.repository.id } : {}),
      ...(analysis.repository.remote ? { remote: analysis.repository.remote } : {}),
      ...(analysis.repository.revision ? { revision: analysis.repository.revision } : {}),
    },
    contentHash,
  })).slice(0, 32)}`;
}

/** Compute the content-addressed immutable snapshot ID from complete evidence. */
export function repositoryAnalysisSnapshotId(
  analysis: Pick<
    RepositoryStaticAnalysis,
    'schemaVersion' | 'analyzerVersion' | 'repository' | 'analysisAdapters' | 'files' | 'symbols' | 'dependencies' | 'diagnostics'
  >,
): string {
  return snapshotIdForEvidence(analysis, repositoryAnalysisContentHash(analysis));
}

async function gitRevision(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      windowsHide: true,
    });
    const revision = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

async function gitRemote(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'config', '--get', 'remote.origin.url'],
      { windowsHide: true },
    );
    const remote = stdout.trim();
    return remote ? sanitizeGitRemote(remote) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeGitRemote(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed.replaceAll('\\', '/').replace(/\.git\/?$/i, '').replace(/\/$/, '');
  }
  try {
    const remote = new URL(trimmed);
    remote.username = '';
    remote.password = '';
    remote.search = '';
    remote.hash = '';
    remote.hostname = remote.hostname.toLowerCase();
    remote.pathname = remote.pathname.replace(/\.git\/?$/i, '').replace(/\/$/, '');
    return remote.toString().replace(/\/$/, '');
  } catch {
    const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
    if (scpLike?.[1] && scpLike[2]) {
      return `${scpLike[1].toLowerCase()}:${scpLike[2]
        .replaceAll('\\', '/')
        .replace(/\.git\/?$/i, '')
        .replace(/\/$/, '')}`;
    }
    return trimmed.replaceAll('\\', '/').replace(/\.git\/?$/i, '').replace(/\/$/, '');
  }
}

/** Returns tracked Git changes only; untracked analysis sidecars are irrelevant. */
async function trackedGitWorktreeChanges(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
      windowsHide: true,
    });
    if (stdout.trim() !== 'true') return undefined;
  } catch {
    // A non-Git repository may still be analysed for planning, but never executed automatically.
    return undefined;
  }
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', root,
      'status',
      '--porcelain=v1',
      '--untracked-files=no',
      '--',
      '.',
    ], { windowsHide: true });
    return stdout.split(/\r?\n/).filter((line) => line.trim());
  } catch (error) {
    throw new Error(
      `Unable to inspect tracked Git worktree changes before static analysis: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function artifactFileName(snapshotId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(snapshotId)) {
    throw new Error('Static analysis snapshot IDs must be safe artifact identifiers.');
  }
  return `${snapshotId}.json`;
}

/** Resolve the repository-owned immutable analysis artifact without accepting path input. */
export function repositoryAnalysisArtifactPath(root: string, snapshotId: string): string {
  const resolvedRoot = path.resolve(root);
  const artifactRoot = path.resolve(resolvedRoot, repositoryAnalysisArtifactDirectory);
  const artifactPath = path.resolve(artifactRoot, artifactFileName(snapshotId));
  const relative = path.relative(artifactRoot, artifactPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Static analysis artifact path escapes the repository.');
  }
  return artifactPath;
}

/**
 * Persist a completed snapshot atomically. Existing snapshots are immutable:
 * a collision with different bytes indicates a broken snapshot identity.
 */
export async function writeRepositoryAnalysisArtifact(
  root: string,
  analysis: RepositoryStaticAnalysis,
): Promise<string> {
  const verifiedAnalysis = verifyRepositoryStaticAnalysis(analysis);
  const artifactPath = repositoryAnalysisArtifactPath(root, verifiedAnalysis.snapshotId);
  const artifactRoot = path.dirname(artifactPath);
  const serialized = `${JSON.stringify(verifiedAnalysis, null, 2)}\n`;
  await mkdir(artifactRoot, { recursive: true });
  try {
    const existing = await readFile(artifactPath, 'utf8');
    if (!sameImmutableAnalysis(existing, serialized)) {
      throw new Error(`Static analysis snapshot already exists with different content: ${verifiedAnalysis.snapshotId}`);
    }
    return artifactPath;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${artifactPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    // `link` is create-only, unlike rename which may replace an existing
    // artifact. This preserves the snapshot's immutable identity under races.
    await link(temporaryPath, artifactPath);
  } catch (error) {
    // A simultaneous writer can win the create race. In that case, verify it
    // wrote the same immutable content instead of silently replacing it.
    try {
      const existing = await readFile(artifactPath, 'utf8');
      if (sameImmutableAnalysis(existing, serialized)) return artifactPath;
    } catch (raceError) {
      if ((raceError as NodeJS.ErrnoException).code !== 'ENOENT') throw raceError;
    }
    throw error;
  } finally {
    // The name contains our UUID and is under the configured artifact root;
    // remove only this writer's orphan if the atomic rename did not consume it.
    await rm(temporaryPath, { force: true });
  }
  return artifactPath;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRepositoryStaticAnalysisShape(value: unknown): value is RepositoryStaticAnalysis {
  if (!isRecord(value)) return false;
  const analysis = value as Partial<RepositoryStaticAnalysis>;
  return (
    analysis.schemaVersion === moduleMigrationSchemaVersion &&
    typeof analysis.snapshotId === 'string' &&
    typeof analysis.contentHash === 'string' &&
    typeof analysis.analyzerVersion === 'string' &&
    typeof analysis.createdAt === 'string' &&
    isRecord(analysis.repository) &&
    (analysis.repository.id === undefined || typeof analysis.repository.id === 'string') &&
    (analysis.repository.root === undefined || typeof analysis.repository.root === 'string') &&
    (analysis.repository.remote === undefined || typeof analysis.repository.remote === 'string') &&
    (analysis.repository.revision === undefined || typeof analysis.repository.revision === 'string') &&
    (analysis.analysisAdapters === undefined || (
      Array.isArray(analysis.analysisAdapters) &&
      analysis.analysisAdapters.every((adapter) =>
        isRecord(adapter) &&
        typeof adapter.id === 'string' &&
        typeof adapter.version === 'string' &&
        typeof adapter.languageId === 'string' &&
        Array.isArray(adapter.capabilities) &&
        adapter.capabilities.every((capability) => typeof capability === 'string') &&
        (adapter.configurationHash === undefined || typeof adapter.configurationHash === 'string') &&
        (adapter.analysisLevel === 'deep' || adapter.analysisLevel === 'generic'),
      )
    )) &&
    Array.isArray(analysis.files) &&
    analysis.files.every((file) =>
      isRecord(file) &&
      typeof file.path === 'string' &&
      typeof file.sha256 === 'string' &&
      typeof file.role === 'string',
    ) &&
    Array.isArray(analysis.symbols) &&
    analysis.symbols.every((symbol) =>
      isRecord(symbol) &&
      typeof symbol.id === 'string' &&
      typeof symbol.name === 'string' &&
      typeof symbol.qualifiedName === 'string' &&
      typeof symbol.kind === 'string' &&
      typeof symbol.language === 'string' &&
      typeof symbol.path === 'string' &&
      (symbol.visibility === undefined || typeof symbol.visibility === 'string') &&
      (symbol.exported === undefined || typeof symbol.exported === 'boolean') &&
      (symbol.containerSymbolId === undefined || typeof symbol.containerSymbolId === 'string') &&
      (symbol.returnShape === undefined || typeof symbol.returnShape === 'string') &&
      (symbol.parameters === undefined || (
        Array.isArray(symbol.parameters) &&
        symbol.parameters.every((parameter) =>
          isRecord(parameter) &&
          typeof parameter.name === 'string' &&
          (parameter.type === undefined || typeof parameter.type === 'string') &&
          (parameter.required === undefined || typeof parameter.required === 'boolean') &&
          (parameter.variadic === undefined || typeof parameter.variadic === 'boolean'),
        )
      )),
    ) &&
    Array.isArray(analysis.dependencies) &&
    analysis.dependencies.every((edge) =>
      isRecord(edge) &&
      typeof edge.id === 'string' &&
      typeof edge.sourcePath === 'string' &&
      typeof edge.kind === 'string' &&
      typeof edge.internal === 'boolean' &&
      typeof edge.resolution === 'string' &&
      typeof edge.evidence === 'string' &&
      Array.isArray(edge.evidenceRanges) &&
      typeof edge.snapshotId === 'string',
    ) &&
    Array.isArray(analysis.diagnostics) &&
    analysis.diagnostics.every((entry) =>
      isRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.severity === 'string' &&
      typeof entry.message === 'string',
    )
  );
}

/**
 * Verify an analysis sidecar's content address and all snapshot-local edge
 * IDs.  The function intentionally ignores `createdAt`: collection time is
 * audit metadata and is not part of the immutable evidence identity.
 */
export function verifyRepositoryStaticAnalysis(value: unknown): RepositoryStaticAnalysis {
  if (!isRepositoryStaticAnalysisShape(value)) {
    throw new Error('Repository static analysis has an invalid shape.');
  }
  const analysis = value;
  if (analysis.repository.id !== undefined && !safeRepositoryId.test(analysis.repository.id)) {
    throw new Error('Repository static analysis has an invalid logical repository ID.');
  }
  const expectedContentHash = repositoryAnalysisContentHash(analysis);
  if (analysis.contentHash !== expectedContentHash) {
    throw new Error('Repository static analysis content hash does not match its canonical evidence.');
  }
  const expectedSnapshotId = snapshotIdForEvidence(analysis, expectedContentHash);
  if (analysis.snapshotId !== expectedSnapshotId) {
    throw new Error('Repository static analysis snapshot ID does not match its canonical evidence.');
  }
  const edgeIds = new Set<string>();
  for (const edge of analysis.dependencies) {
    if (edge.snapshotId !== analysis.snapshotId) {
      throw new Error(`Repository static analysis dependency edge ${edge.id} belongs to another snapshot.`);
    }
    const expectedEdgeId = edgeId(edge, analysis.snapshotId);
    if (edge.id !== expectedEdgeId) {
      throw new Error(`Repository static analysis dependency edge ${edge.id} has an invalid identity.`);
    }
    if (edgeIds.has(edge.id)) {
      throw new Error(`Repository static analysis contains duplicate dependency edge ID: ${edge.id}`);
    }
    edgeIds.add(edge.id);
  }
  return analysis;
}

/** `createdAt` describes collection time, not the content-addressed snapshot. */
function sameImmutableAnalysis(left: string, right: string): boolean {
  const leftValue = verifyRepositoryStaticAnalysis(JSON.parse(left) as unknown);
  const rightValue = verifyRepositoryStaticAnalysis(JSON.parse(right) as unknown);
  const { createdAt: _leftCreatedAt, ...leftIdentity } = leftValue;
  const { createdAt: _rightCreatedAt, ...rightIdentity } = rightValue;
  return canonicalJson(leftIdentity) === canonicalJson(rightIdentity);
}

/** Read only a conventional server-owned analysis artifact addressed by ID. */
export async function readRepositoryAnalysisArtifact(
  root: string,
  snapshotId: string,
): Promise<RepositoryStaticAnalysis | null> {
  const artifactPath = repositoryAnalysisArtifactPath(root, snapshotId);
  let raw: string;
  try {
    raw = await readFile(artifactPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Static analysis artifact is invalid JSON: ${snapshotId}`);
  }
  const analysis = verifyRepositoryStaticAnalysis(parsed);
  if (analysis.snapshotId !== snapshotId) {
    throw new Error(`Static analysis artifact has an invalid identity: ${snapshotId}`);
  }
  return analysis;
}

function addResolutionDiagnostics(
  diagnostics: StaticAnalysisDiagnostic[],
  edges: DependencyEdge[],
): void {
  for (const edge of edges) {
    if (!edge.internal || edge.resolution === 'resolved') continue;
    const range = edge.evidenceRanges[0];
    diagnostic(diagnostics, {
      severity: 'warn',
      code: edge.resolution === 'ambiguous' ? 'AMBIGUOUS_INTERNAL_REFERENCE' : 'UNRESOLVED_INTERNAL_REFERENCE',
      message: edge.resolution === 'ambiguous'
        ? `Internal reference is ambiguous: ${edge.targetReference ?? 'unknown'}`
        : `Internal reference could not be resolved: ${edge.targetReference ?? 'unknown'}`,
      path: edge.sourcePath,
      ...(range ? { range } : {}),
    });
  }
}

/**
 * Analyse registered source languages from a real repository without affecting
 * the fixture-oriented `extractCorpus` retrieval path. The result is immutable:
 * all paths are root-relative and every edge carries the snapshot ID.
 */
export async function analyzeRepository(
  request: AnalyzeRepositoryRequest,
): Promise<RepositoryStaticAnalysis> {
  if (request.repositoryId !== undefined && !safeRepositoryId.test(request.repositoryId.trim())) {
    throw new Error('Repository ID must be a safe, non-empty logical identifier.');
  }
  const root = path.resolve(request.root);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`Repository root must be a directory: ${root}`);

  const diagnostics: StaticAnalysisDiagnostic[] = [];
  const languageRegistry = request.languageRegistry ?? createDefaultRepositoryLanguageRegistry();
  const reportDiagnostic: RepositoryAnalysisDiagnosticReporter = (input) => {
    diagnostic(diagnostics, input);
  };
  const trackedChanges = await trackedGitWorktreeChanges(root);
  if (trackedChanges && trackedChanges.length > 0) {
    if (request.allowDirtyWorktreeForPlanning !== true) {
      throw new Error(
        'Refusing to create a static analysis snapshot from a tracked-dirty Git worktree. '
        + 'Use allowDirtyWorktreeForPlanning only for a planning-only caller; execution requires a clean baseline.',
      );
    }
    diagnostic(diagnostics, {
      severity: 'warn',
      code: 'DIRTY_GIT_WORKTREE_PLANNING_ONLY',
      message: `Static analysis is using ${trackedChanges.length} tracked Git worktree change${trackedChanges.length === 1 ? '' : 's'} under an explicit planning-only opt-out.`,
    });
  }
  const files = await discoverFiles(
    root,
    request.includeTests !== false,
    diagnostics,
    languageRegistry,
  );
  const projectSymbols = assignProjects(files);
  const fileRecords = staticFiles(files);
  const [revision, remote] = await Promise.all([gitRevision(root), gitRemote(root)]);
  const baseAnalyzerVersion = request.analyzerVersion ?? repositoryAnalysisVersion;
  const adapterFingerprint = languageRegistry.fingerprint();
  const analysisAdapters: RepositoryStaticAnalysisAdapterDescriptor[] = languageRegistry
    .descriptors()
    .map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
      languageId: adapter.languageId,
      capabilities: adapter.capabilities,
      configurationHash: adapter.configurationHash,
      analysisLevel: adapter.analysisLevel,
    }));

  const languageAnalyses = files
    .filter((file): file is RepositoryFile & { languageId: LanguageId } => file.languageId !== undefined)
    .map((file) => {
      const adapter = languageRegistry.adapterForLanguageId(file.languageId);
      if (!adapter) {
        throw new Error(`No repository language adapter is registered for ${file.languageId}.`);
      }
      return adapter.analyze(file, reportDiagnostic);
    });
  const allSymbols = [
    ...projectSymbols,
    ...languageAnalyses.flatMap((entry) => entry.symbols),
  ];
  const symbols = allSymbols.sort((left, right) => compareText(left.id, right.id));
  const typeIndex = typeSymbols(symbols);
  const drafts: EdgeDraft[] = projectReferenceDrafts(root, files, diagnostics);

  for (const entry of languageAnalyses) {
    for (const imported of entry.imports) drafts.push(edgeDraft(entry, imported, 'import', symbols));
    for (const reference of entry.references) {
      drafts.push(edgeDraft(entry, reference, reference.kind, symbols));
    }
    for (const reference of conventionalTestReferences(entry, typeIndex)) {
      drafts.push(edgeDraft(entry, reference, 'test-reference', symbols));
    }
  }

  const semanticEnabled = request.semanticEnrichment === true || request.compilerProbe !== undefined;
  const semanticOutcomes = await enrichWithCompiler(
    request,
    root,
    files,
    drafts,
    diagnostics,
    languageRegistry,
  );
  for (const outcome of semanticOutcomes) {
    if (!outcome.compiler) continue;
    diagnostic(diagnostics, {
      severity: 'info',
      code: `${outcome.language === 'Java' ? 'JAVA' : 'CSHARP'}_SEMANTIC_TOOLCHAIN`,
      message: `${outcome.language} semantic analysis used ${outcome.compiler}.`,
    });
  }
  const analyzerIdentity = `${baseAnalyzerVersion}+adapters-${adapterFingerprint.slice(0, 16)}`;
  const analyzerVersion = semanticEnabled
    ? `${analyzerIdentity}+compiler-probe`
    : analyzerIdentity;
  // Edge IDs include the snapshot ID, so establish diagnostics against a
  // temporary edge set and hash the edge evidence without those derived IDs.
  const dependenciesForEvidence = finalizeEdges(drafts, 'snapshot-pending');
  addResolutionDiagnostics(diagnostics, dependenciesForEvidence);
  const compilerLanguages = languageRegistry.adapters()
    .filter((adapter) =>
      adapter.compilerProbeLanguage && files.some((file) => file.languageId === adapter.languageId),
    )
    .map((adapter) => adapter.languageId);
  if (compilerLanguages.length > 0) {
    const hasSemanticEdges = dependenciesForEvidence.some((edge) => edge.evidence === 'semantic');
    const languageLabel = compilerLanguages.join(' and ');
    diagnostic(diagnostics, {
      severity: 'info',
      code: hasSemanticEdges ? 'COMPILER_SEMANTIC_ENRICHMENT_APPLIED' : 'SYNTACTIC_ANALYSIS_ONLY',
      message: hasSemanticEdges
        ? `${languageLabel} dependencies include compiler-verified bindings; all remaining edges retain their original syntactic or unresolved evidence.`
        : semanticEnabled
          ? `${languageLabel} dependencies were collected with deterministic syntactic analysis; compiler probing did not provide verified bindings.`
          : `${languageLabel} dependencies were collected with deterministic syntactic analysis; no semantic compiler binding was available.`,
    });
  }

  const evidence = {
    schemaVersion: moduleMigrationSchemaVersion,
    analyzerVersion,
    repository: {
      root,
      ...(request.repositoryId?.trim() ? { id: request.repositoryId.trim() } : {}),
      ...(remote ? { remote } : {}),
      ...(revision ? { revision } : {}),
    },
    analysisAdapters,
    files: fileRecords,
    symbols,
    dependencies: dependenciesForEvidence,
    diagnostics: diagnostics.sort((left, right) => compareText(left.id, right.id)),
  };
  const contentHash = repositoryAnalysisContentHash(evidence);
  const snapshotId = snapshotIdForEvidence(evidence, contentHash);
  const analysis: RepositoryStaticAnalysis = {
    ...evidence,
    snapshotId,
    contentHash,
    createdAt: request.createdAt ?? new Date().toISOString(),
    dependencies: finalizeEdges(drafts, snapshotId),
  };
  return verifyRepositoryStaticAnalysis(analysis);
}
