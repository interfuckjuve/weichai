import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  ModuleSummary,
  ModuleTarget,
  RepositoryStaticAnalysis,
  StaticAnalysisFile,
  StaticSymbol,
  StructuralIndex,
} from '@forexplore/contracts';
import { extractSymbols } from '@forexplore/code-indexer';
import type {
  ModuleExplorerNode,
  ModuleExplorerPresentation,
  ModuleExplorerStats,
  ModuleImplementationStatus,
  ModuleSummaryPresentation,
  ModuleWorkspacePresentation,
} from './ui-types';

const summaryRelativePath = '.forexplore/module-summary.json' as const;
const targetSymbolKinds = new Set(['class', 'interface', 'record', 'struct', 'method', 'constructor', 'function']);
const visibleSymbolKinds = new Set([...targetSymbolKinds, 'enum']);
const ignoredDirectoryNames = new Set([
  '.git', '.forexplore', '.gradle', '.idea', '.next', '.svn', '.vscode',
  'bin', 'build', 'dist', 'node_modules', 'obj', 'out', 'target', '__pycache__',
]);
const languageByExtension = new Map<string, StaticAnalysisFile['language']>([
  ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'], ['.js', 'TypeScript'], ['.jsx', 'TypeScript'],
  ['.py', 'Python'], ['.java', 'Java'], ['.cs', 'C#'], ['.rs', 'Rust'], ['.go', 'Go'],
]);
const moduleSummaryLanguages = new Set(['TypeScript', 'Python', 'Java', 'C#', 'Rust', 'Go', 'Mixed', 'Unknown']);
const configurationFilePattern = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|[^/]+\.(?:csproj|sln))$/i;
const maxExplorerFiles = 4_000;
const maxExplorerFileBytes = 2 * 1024 * 1024;

export interface ModuleExplorerBuildResult {
  presentation: ModuleExplorerPresentation;
  targets: Map<string, ModuleTarget>;
}

export interface BuildModuleExplorerInput {
  workspaceRoot: string;
  workspaceName: string;
  currentTarget: ModuleTarget;
  historyRoots: string[];
  /** Active structural indexes from the shared code-intelligence host. */
  structuralIndexes?: ReadonlyMap<string, StructuralIndex>;
}

/**
 * Builds both 01B and 01A from host-owned files. Failures in a history corpus
 * are represented in the read-only view and never prevent the active run.
 */
export async function buildModuleExplorer(
  input: BuildModuleExplorerInput,
  options: { includeHistory?: boolean } = {},
): Promise<ModuleExplorerBuildResult> {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const target = await analyzeWorkspaceWithPreferredIndex(
    workspaceRoot,
    input.workspaceName,
    'target',
    input.currentTarget,
    workspacePresentationId('target', workspaceRoot),
    input.structuralIndexes?.get(workspaceIdentityKey(workspaceRoot)),
  );
  const workspaceRootKey = workspaceIdentityKey(workspaceRoot);
  const distinctHistoryRoots = distinctResolvedRoots(input.historyRoots)
    .filter((root) => workspaceIdentityKey(root) !== workspaceRootKey);
  const history = options.includeHistory === false
    ? distinctHistoryRoots.map((root) => ({
      presentation: pendingWorkspacePresentation(root),
      targets: new Map<string, ModuleTarget>(),
    }))
    : await Promise.all(
      distinctHistoryRoots.map((root) => analyzeWorkspaceWithPreferredIndex(
        root,
        path.basename(root),
        'history',
        undefined,
        workspacePresentationId('history', root),
        input.structuralIndexes?.get(workspaceIdentityKey(root)),
      )),
    );
  return {
    presentation: {
      generatedAt: new Date().toISOString(),
      target: target.presentation,
      history: history.map((item) => item.presentation),
    },
    targets: target.targets,
  };
}

async function analyzeWorkspaceWithPreferredIndex(
  root: string,
  name: string,
  mode: 'target' | 'history',
  currentTarget: ModuleTarget | undefined,
  presentationId: string,
  structuralIndex: StructuralIndex | undefined,
): Promise<{ presentation: ModuleWorkspacePresentation; targets: Map<string, ModuleTarget> }> {
  if (!structuralIndex) return analyzeWorkspace(root, name, mode, currentTarget, presentationId);
  try {
    const summaryResult = await readModuleSummarySafely(root);
    const transformed = workspacePresentationFromStructuralIndex({
      index: structuralIndex,
      currentTarget,
      mode,
      name,
      rootLabel: path.basename(root),
      presentationId,
      summary: summaryResult.summary,
    });
    if (summaryResult.error) transformed.presentation.summary.error = summaryResult.error;
    return transformed;
  } catch (error) {
    return {
      presentation: emptyWorkspacePresentation({
        id: presentationId,
        mode,
        name,
        rootLabel: path.basename(root),
        error: error instanceof Error ? error.message : String(error),
      }),
      targets: new Map(),
    };
  }
}

async function analyzeWorkspace(
  root: string,
  name: string,
  mode: 'target' | 'history',
  currentTarget?: ModuleTarget,
  presentationId?: string,
): Promise<{ presentation: ModuleWorkspacePresentation; targets: Map<string, ModuleTarget> }> {
  try {
    const [{ analysis, contents }, summaryResult] = await Promise.all([
      analyzeRepositoryForExplorer(root),
      readModuleSummarySafely(root),
    ]);
    const transformed = workspacePresentationFromAnalysis({
      analysis,
      contents,
      currentTarget,
      mode,
      name,
      rootLabel: path.basename(root),
      presentationId,
      summary: summaryResult.summary,
    });
    if (summaryResult.error) transformed.presentation.summary.error = summaryResult.error;
    return transformed;
  } catch (error) {
    return {
      presentation: emptyWorkspacePresentation({
        id: presentationId ?? `${mode}:${path.basename(root)}`,
        mode,
        name,
        rootLabel: path.basename(root),
        error: error instanceof Error ? error.message : String(error),
      }),
      targets: new Map(),
    };
  }
}

/**
 * The full module-migration analyzer is intentionally not used for panel
 * navigation: its dependency-resolution pass is planning-grade and can take
 * minutes on a corpus. This bounded host-side scan opens 01B promptly while
 * retaining real files/symbols and import evidence for the UI.
 */
async function analyzeRepositoryForExplorer(
  rootInput: string,
): Promise<{ analysis: RepositoryStaticAnalysis; contents: Map<string, string> }> {
  const root = path.resolve(rootInput);
  const stat = await lstat(root);
  if (!stat.isDirectory()) throw new Error(`模块浏览根路径不是目录：${root}`);
  const discovered: Array<{
    path: string;
    content: string;
    language?: StaticAnalysisFile['language'];
    role: StaticAnalysisFile['role'];
    sha256: string;
  }> = [];

  async function visit(directory: string): Promise<void> {
    if (discovered.length >= maxExplorerFiles) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (discovered.length >= maxExplorerFiles) break;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name.toLowerCase())) await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, absolutePath).replaceAll('\\', '/');
      const extension = path.extname(entry.name).toLowerCase();
      const language = languageByExtension.get(extension);
      const configuration = configurationFilePattern.test(relativePath);
      if (!language && !configuration) continue;
      const bytes = await readFile(absolutePath);
      if (bytes.byteLength > maxExplorerFileBytes) continue;
      discovered.push({
        path: relativePath,
        content: Buffer.from(bytes).toString('utf8'),
        language,
        role: configuration ? 'configuration' : sourceRole(relativePath),
        sha256: digest(bytes),
      });
    }
  }

  await visit(root);
  const configurationPaths = discovered
    .filter((file) => file.role === 'configuration')
    .map((file) => file.path);
  const files: StaticAnalysisFile[] = discovered.map((file) => ({
    path: file.path,
    sha256: file.sha256,
    role: file.role,
    ...(file.language ? { language: file.language } : {}),
    ...(projectFor(file.path, configurationPaths) ? { project: projectFor(file.path, configurationPaths) } : {}),
  }));
  const symbols: StaticSymbol[] = discovered.flatMap((file) => {
    if (!file.language) return [];
    return extractSymbols(file.content, file.language).map((symbol, index) => ({
      id: `explorer:${digest(`${file.path}:${symbol.kind}:${symbol.line}:${symbol.name}:${index}`).slice(0, 24)}`,
      name: symbol.name,
      qualifiedName: symbol.name,
      kind: symbol.kind,
      language: file.language as NonNullable<StaticAnalysisFile['language']>,
      path: file.path,
      range: { path: file.path, startLine: symbol.line },
      signature: symbol.signature,
      ...(projectFor(file.path, configurationPaths) ? { project: projectFor(file.path, configurationPaths) } : {}),
      testOnly: sourceRole(file.path) === 'test',
    }));
  });
  const contentHash = digest(files.map((file) => `${file.path}:${file.sha256}`).sort().join('\n'));
  const snapshotId = `explorer-${contentHash.slice(0, 20)}`;
  const dependencies = discovered.flatMap((file) => importEvidence(file.content).map((reference, index) => ({
    id: `explorer-edge:${digest(`${file.path}:${index}:${reference}`).slice(0, 24)}`,
    sourcePath: file.path,
    kind: 'import' as const,
    internal: false,
    resolution: 'unresolved' as const,
    evidence: 'syntactic' as const,
    evidenceRanges: [],
    snapshotId,
    targetReference: reference,
  })));

  return {
    analysis: {
      schemaVersion: '1.0',
      snapshotId,
      contentHash,
      analyzerVersion: 'vscode-module-explorer/v1',
      createdAt: new Date().toISOString(),
      repository: {},
      files,
      symbols,
      dependencies,
      diagnostics: discovered.length >= maxExplorerFiles ? [{
        id: 'explorer-file-limit',
        severity: 'warn',
        message: `模块浏览已达到 ${maxExplorerFiles} 个文件的显示上限。`,
        code: 'EXPLORER_FILE_LIMIT',
      }] : [],
    },
    contents: new Map(discovered.map((file) => [file.path, file.content])),
  };
}

function sourceRole(relativePath: string): StaticAnalysisFile['role'] {
  const normalized = relativePath.toLowerCase();
  const parts = normalized.split('/');
  const name = parts.at(-1) ?? normalized;
  if (parts.some((part) => part === 'test' || part === 'tests') || /(?:test|tests|spec)\.[^.]+$/.test(name)) {
    return 'test';
  }
  if (parts.some((part) => ['generated', 'generated-sources', 'autogen'].includes(part))) {
    return 'generated';
  }
  return 'source';
}

function projectFor(filePath: string, configurationPaths: string[]): string | undefined {
  const containing = configurationPaths.filter((configurationPath) => {
    const directory = configurationPath.includes('/')
      ? configurationPath.slice(0, configurationPath.lastIndexOf('/'))
      : '';
    return !directory || filePath.startsWith(`${directory}/`);
  });
  containing.sort((left, right) => right.length - left.length);
  return containing[0];
}

function importEvidence(content: string): string[] {
  const matches = content.matchAll(/^\s*(?:import|using|use|from)\s+([^;\n{]+)/gm);
  return [...matches].map((match) => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

interface WorkspaceTransformInput {
  analysis: RepositoryStaticAnalysis;
  contents?: ReadonlyMap<string, string>;
  currentTarget?: ModuleTarget;
  mode: 'target' | 'history';
  name: string;
  presentationId?: string;
  rootLabel: string;
  summary?: ModuleSummary;
}

export interface StructuralWorkspaceTransformInput {
  index: StructuralIndex;
  currentTarget?: ModuleTarget;
  mode: 'target' | 'history';
  name: string;
  presentationId?: string;
  rootLabel: string;
  summary?: ModuleSummary;
}

/**
 * Converts only the path-free structural index records needed by the existing
 * tree renderer. The renderer no longer has to rescan the repository when an
 * active shared index is available; the legacy adapter is retained only for
 * hosts that have not indexed the root yet.
 */
export function workspacePresentationFromStructuralIndex(
  input: StructuralWorkspaceTransformInput,
): { presentation: ModuleWorkspacePresentation; targets: Map<string, ModuleTarget> } {
  return workspacePresentationFromAnalysis({
    analysis: staticAnalysisFromStructuralIndex(input.index),
    currentTarget: input.currentTarget,
    mode: input.mode,
    name: input.name,
    presentationId: input.presentationId,
    rootLabel: input.rootLabel,
    summary: input.summary,
  });
}

function staticAnalysisFromStructuralIndex(index: StructuralIndex): RepositoryStaticAnalysis {
  const projects = new Map(index.projects.map((project) => [project.projectId, project]));
  const files: StaticAnalysisFile[] = index.files.map((file) => {
    const language = file.languageId === undefined ? undefined : legacyLanguage(file.languageId);
    const project = file.projectId === undefined ? undefined : projects.get(file.projectId);
    return {
      path: file.relativePath,
      sha256: file.sha256,
      role: file.role,
      ...(language === undefined ? {} : { language }),
      ...(project ? { project: project.relativePath || project.displayName || project.projectId } : {}),
    };
  });
  const symbols: StaticSymbol[] = index.symbols.flatMap((symbol) => {
    const language = legacyLanguage(symbol.languageId);
    if (!language) return [];
    const project = symbol.projectId === undefined ? undefined : projects.get(symbol.projectId);
    return [{
      id: symbol.symbolKey,
      name: symbol.name,
      qualifiedName: symbol.qualifiedName,
      kind: legacySymbolKind(symbol.kind),
      language,
      path: symbol.relativePath,
      range: {
        path: symbol.relativePath,
        startLine: symbol.sourceRange.startLine,
        startColumn: symbol.sourceRange.startColumn,
        endLine: symbol.sourceRange.endLine,
        endColumn: symbol.sourceRange.endColumn,
      },
      ...(symbol.signature === undefined ? {} : { signature: symbol.signature }),
      ...(project ? { project: project.relativePath || project.displayName || project.projectId } : {}),
    }];
  });
  return {
    schemaVersion: '1.0',
    snapshotId: index.analysisRevision,
    contentHash: index.analysisHash,
    analyzerVersion: 'forexplore-structural-index/v1',
    createdAt: new Date().toISOString(),
    repository: { revision: index.analysisRevision },
    files,
    symbols,
    dependencies: index.dependencyEdges.map((edge) => ({
      id: edge.dependencyEdgeId,
      ...(edge.sourceSymbolKey ? { sourceSymbolId: edge.sourceSymbolKey } : {}),
      ...(edge.targetSymbolKey ? { targetSymbolId: edge.targetSymbolKey } : {}),
      sourcePath: edge.sourceRelativePath,
      ...(edge.targetRelativePath ? { targetPath: edge.targetRelativePath } : {}),
      kind: legacyDependencyKind(edge.kind),
      internal: edge.internal,
      resolution: edge.resolution,
      evidence: legacyEvidence(edge.evidenceLevel),
      evidenceRanges: edge.evidenceRanges.map((range) => ({
        path: edge.sourceRelativePath,
        startLine: range.startLine,
        startColumn: range.startColumn,
        endLine: range.endLine,
        endColumn: range.endColumn,
      })),
      snapshotId: index.analysisRevision,
      ...(edge.targetReference ? { targetReference: edge.targetReference } : {}),
    })),
    diagnostics: index.diagnostics.map((diagnostic) => ({
      id: diagnostic.diagnosticId,
      severity: diagnostic.severity === 'warning' ? 'warn' : diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.relativePath === null ? {} : { path: diagnostic.relativePath }),
      ...(diagnostic.sourceRange === null || diagnostic.relativePath === null ? {} : {
        range: {
          path: diagnostic.relativePath,
          startLine: diagnostic.sourceRange.startLine,
          startColumn: diagnostic.sourceRange.startColumn,
          endLine: diagnostic.sourceRange.endLine,
          endColumn: diagnostic.sourceRange.endColumn,
        },
      }),
      ...(diagnostic.code ? { code: diagnostic.code } : {}),
    })),
  };
}

function legacyLanguage(languageId: string): StaticAnalysisFile['language'] | undefined {
  const languages: Record<string, NonNullable<StaticAnalysisFile['language']>> = {
    typescript: 'TypeScript',
    javascript: 'TypeScript',
    python: 'Python',
    java: 'Java',
    csharp: 'C#',
    go: 'Go',
    rust: 'Rust',
  };
  return languages[languageId];
}

function legacySymbolKind(kind: string): StaticSymbol['kind'] {
  const kinds = new Set<StaticSymbol['kind']>([
    'project', 'package', 'namespace', 'class', 'interface', 'record', 'struct',
    'enum', 'method', 'constructor', 'function', 'field', 'property', 'unknown',
  ]);
  return kinds.has(kind as StaticSymbol['kind']) ? kind as StaticSymbol['kind'] : 'unknown';
}

function legacyDependencyKind(kind: string): NonNullable<RepositoryStaticAnalysis['dependencies'][number]['kind']> {
  const kinds = new Set<NonNullable<RepositoryStaticAnalysis['dependencies'][number]['kind']>>([
    'import', 'project-reference', 'inheritance', 'implementation', 'type-reference',
    'invocation', 'member-access', 'test-reference', 'unknown',
  ]);
  return kinds.has(kind as NonNullable<RepositoryStaticAnalysis['dependencies'][number]['kind']>)
    ? kind as NonNullable<RepositoryStaticAnalysis['dependencies'][number]['kind']>
    : 'unknown';
}

function legacyEvidence(level: string): NonNullable<RepositoryStaticAnalysis['dependencies'][number]['evidence']> {
  if (level === 'semantic') return 'semantic';
  if (level === 'ambiguous') return 'ambiguous';
  if (level === 'unresolved') return 'unresolved';
  return 'syntactic';
}

/** Pure transform kept exported for deterministic tree/status tests. */
export function workspacePresentationFromAnalysis(
  input: WorkspaceTransformInput,
): { presentation: ModuleWorkspacePresentation; targets: Map<string, ModuleTarget> } {
  const targets = new Map<string, ModuleTarget>();
  const symbolsByPath = groupSymbolsByPath(input.analysis.symbols);
  const fileNodes = new Map<string, ModuleExplorerNode>();

  for (const file of input.analysis.files) {
    fileNodes.set(file.path, buildFileNode(
      file,
      symbolsByPath.get(file.path) ?? [],
      input.contents?.get(file.path),
      input.currentTarget,
      input.mode === 'target' ? targets : undefined,
    ));
  }

  const moduleDefinitions = moduleDefinitionsFor(input.analysis.files, input.summary);
  const tree = moduleDefinitions.map((definition) => ({
    id: `module:${definition.id}`,
    name: definition.name,
    kind: 'module' as const,
    description: definition.description,
    purpose: definition.purpose,
    coreApis: definition.coreApis,
    language: definition.language,
    domain: definition.domain,
    children: folderTree(
      definition.files
        .map((filePath) => fileNodes.get(filePath))
        .filter((node): node is ModuleExplorerNode => node !== undefined),
    ),
  }));

  if (input.mode === 'target' && input.currentTarget && !targets.has(input.currentTarget.id)) {
    targets.set(input.currentTarget.id, input.currentTarget);
    attachCurrentTarget(tree, input.currentTarget);
  }

  const statuses = collectStatuses(tree);
  const stats: ModuleExplorerStats = {
    modules: tree.length,
    files: input.analysis.files.length,
    types: input.analysis.symbols.filter((symbol) =>
      ['class', 'interface', 'record', 'struct', 'enum'].includes(symbol.kind),
    ).length,
    methods: input.analysis.symbols.filter((symbol) =>
      ['method', 'constructor', 'function'].includes(symbol.kind),
    ).length,
    implemented: statuses.filter((status) => status === 'implemented').length,
    unimplemented: statuses.filter((status) => status === 'unimplemented').length,
    unknown: statuses.filter((status) => status === 'unknown').length,
    dependencies: input.analysis.dependencies.length,
  };

  return {
    presentation: {
      id: input.presentationId ?? `${input.mode}:${input.analysis.snapshotId}`,
      mode: input.mode,
      name: input.name,
      rootLabel: input.rootLabel,
      snapshotId: input.analysis.snapshotId,
      ...(input.analysis.repository.revision ? { revision: input.analysis.repository.revision } : {}),
      stats,
      summary: summaryPresentation(input.summary),
      tree,
    },
    targets,
  };
}

function buildFileNode(
  file: StaticAnalysisFile,
  symbols: StaticSymbol[],
  content: string | undefined,
  currentTarget: ModuleTarget | undefined,
  targets: Map<string, ModuleTarget> | undefined,
): ModuleExplorerNode {
  const visible = symbols.filter((symbol) => visibleSymbolKinds.has(symbol.kind));
  const typeSymbols = visible.filter((symbol) =>
    ['class', 'interface', 'record', 'struct', 'enum'].includes(symbol.kind),
  );
  const memberSymbols = visible.filter((symbol) =>
    ['method', 'constructor', 'function'].includes(symbol.kind),
  );
  const typeNodes = typeSymbols.map((symbol) => symbolNode(symbol, content, currentTarget, targets));
  const claimedMembers = new Set<string>();
  for (let index = 0; index < typeSymbols.length; index += 1) {
    const type = typeSymbols[index];
    const node = typeNodes[index];
    if (!type || !node) continue;
    const owned = memberSymbols.filter((member) => member.qualifiedName.startsWith(`${type.qualifiedName}.`));
    node.children = owned.map((member) => {
      claimedMembers.add(member.id);
      return symbolNode(member, content, currentTarget, targets);
    });
  }
  typeNodes.push(...memberSymbols
    .filter((symbol) => !claimedMembers.has(symbol.id))
    .map((symbol) => symbolNode(symbol, content, currentTarget, targets)));
  return {
    id: `file:${file.path}`,
    name: file.path.split('/').at(-1) ?? file.path,
    kind: 'file',
    path: file.path,
    language: file.language,
    children: typeNodes,
  };
}

function symbolNode(
  symbol: StaticSymbol,
  content: string | undefined,
  currentTarget: ModuleTarget | undefined,
  targets: Map<string, ModuleTarget> | undefined,
): ModuleExplorerNode {
  const line = symbol.range?.startLine;
  const targetId = line === undefined ? undefined : `workspace://${symbol.path}#L${line}`;
  const eligible = targetId !== undefined && targetSymbolKinds.has(symbol.kind);
  const implementationStatus = eligible
    ? targetStatus(symbol, content, currentTarget)
    : undefined;
  if (eligible && targets) {
    targets.set(targetId, {
      id: targetId,
      name: symbol.name,
      kind: ['class', 'interface', 'record', 'struct'].includes(symbol.kind) ? 'class' : 'function',
      path: symbol.path,
      language: symbol.language,
      signature: symbol.signature ?? symbol.qualifiedName,
      ...(line === undefined ? {} : { line }),
      ...(implementationStatus === undefined || implementationStatus === 'unknown'
        ? {}
        : { implementationStatus }),
    });
  }
  return {
    id: `symbol:${symbol.id}`,
    name: symbol.name,
    kind: normalizeSymbolKind(symbol.kind),
    path: symbol.path,
    language: symbol.language,
    signature: symbol.signature,
    line,
    implementationStatus,
    ...(eligible ? { targetId } : {}),
    children: [],
  };
}

function targetStatus(
  symbol: StaticSymbol,
  content: string | undefined,
  currentTarget: ModuleTarget | undefined,
): ModuleImplementationStatus {
  const targetLine = symbol.range?.startLine;
  if (
    currentTarget &&
    currentTarget.path === symbol.path &&
    currentTarget.name === symbol.name &&
    (currentTarget.line === undefined || targetLine === undefined || currentTarget.line === targetLine)
  ) {
    return currentTarget.implementationStatus ?? 'unknown';
  }
  if (!content || !symbol.range) return 'unknown';
  const start = Math.max(0, symbol.range.startLine - 1);
  const end = Math.min(content.split(/\r?\n/).length, symbol.range.endLine ?? start + 40);
  const excerpt = content.split(/\r?\n/).slice(start, end).join('\n');
  if (/\b(?:NotImplementedException|UnsupportedOperationException)\b|\bTODO\b\s*[:：]?\s*(?:implement|待实现)/i.test(excerpt)) {
    return 'unimplemented';
  }
  return 'implemented';
}

function normalizeSymbolKind(kind: StaticSymbol['kind']): ModuleExplorerNode['kind'] {
  if (kind === 'class' || kind === 'interface' || kind === 'record' || kind === 'struct' ||
      kind === 'enum' || kind === 'method' || kind === 'constructor' || kind === 'function') {
    return kind;
  }
  return 'function';
}

function groupSymbolsByPath(symbols: StaticSymbol[]): Map<string, StaticSymbol[]> {
  const grouped = new Map<string, StaticSymbol[]>();
  for (const symbol of symbols) {
    const current = grouped.get(symbol.path) ?? [];
    current.push(symbol);
    grouped.set(symbol.path, current);
  }
  for (const current of grouped.values()) {
    current.sort((left, right) =>
      (left.range?.startLine ?? Number.MAX_SAFE_INTEGER) -
      (right.range?.startLine ?? Number.MAX_SAFE_INTEGER),
    );
  }
  return grouped;
}

interface ModuleDefinition {
  id: string;
  name: string;
  description?: string;
  purpose?: string;
  coreApis?: string[];
  language?: string;
  domain?: string;
  files: string[];
}

function moduleDefinitionsFor(
  files: StaticAnalysisFile[],
  summary: ModuleSummary | undefined,
): ModuleDefinition[] {
  if (summary?.generated.modules.length) {
    const knownFiles = new Set(files.map((file) => file.path));
    const assigned = new Set<string>();
    const definitions: ModuleDefinition[] = summary.generated.modules.map((module) => {
      const moduleFiles = [
        ...module.sourceFiles,
        ...(module.testFiles ?? []),
        ...(module.generatedFiles ?? []),
      ].filter((file) => knownFiles.has(file));
      moduleFiles.forEach((file) => assigned.add(file));
      return {
        id: module.id,
        name: module.name,
        description: module.description,
        purpose: module.purpose,
        coreApis: module.coreApis,
        language: module.language,
        domain: module.domain,
        files: moduleFiles,
      };
    });
    const unassigned = files.map((file) => file.path).filter((file) => !assigned.has(file));
    if (unassigned.length) {
      definitions.push({ id: 'unassigned', name: '未划分文件', files: unassigned });
    }
    return definitions;
  }

  const byProject = new Map<string, string[]>();
  for (const file of files) {
    const project = file.project ?? inferModule(file.path);
    const entries = byProject.get(project) ?? [];
    entries.push(file.path);
    byProject.set(project, entries);
  }
  return [...byProject.entries()].map(([project, projectFiles]) => ({
    id: project,
    name: projectLabel(project),
    files: projectFiles,
  }));
}

function inferModule(filePath: string): string {
  const parts = filePath.split('/');
  const sourceIndex = parts.findIndex((part) => ['src', 'source', 'sources'].includes(part.toLowerCase()));
  const candidate = sourceIndex >= 0 ? parts[sourceIndex + 1] : parts[0];
  return candidate && candidate.includes('.') === false ? candidate : 'workspace';
}

function projectLabel(project: string): string {
  const name = project.split('/').at(-1) ?? project;
  return name.replace(/\.(?:csproj|sln|xml|gradle(?:\.kts)?)$/i, '') || '工作区模块';
}

function folderTree(fileNodes: ModuleExplorerNode[]): ModuleExplorerNode[] {
  const root: ModuleExplorerNode[] = [];
  for (const fileNode of fileNodes.sort((left, right) => (left.path ?? '').localeCompare(right.path ?? ''))) {
    const pathParts = (fileNode.path ?? fileNode.name).split('/');
    const folders = pathParts.slice(0, -1);
    let level = root;
    let accumulated = '';
    for (const folder of folders) {
      accumulated = accumulated ? `${accumulated}/${folder}` : folder;
      let node = level.find((item) => item.kind === 'folder' && item.name === folder);
      if (!node) {
        node = { id: `folder:${accumulated}`, name: folder, kind: 'folder', path: accumulated, children: [] };
        level.push(node);
      }
      level = node.children;
    }
    level.push(fileNode);
  }
  sortTree(root);
  return root;
}

function sortTree(nodes: ModuleExplorerNode[]): void {
  const order: Record<ModuleExplorerNode['kind'], number> = {
    module: 0,
    folder: 1,
    file: 2,
    class: 3,
    interface: 3,
    record: 3,
    struct: 3,
    enum: 3,
    method: 4,
    constructor: 4,
    function: 4,
  };
  nodes.sort((left, right) => order[left.kind] - order[right.kind] || left.name.localeCompare(right.name));
  nodes.forEach((node) => sortTree(node.children));
}

function attachCurrentTarget(tree: ModuleExplorerNode[], target: ModuleTarget): void {
  const file = findNode(tree, (node) => node.kind === 'file' && node.path === target.path);
  if (!file) return;
  file.children.push({
    id: `current:${target.id}`,
    name: target.name,
    kind: target.kind === 'class' ? 'class' : 'method',
    path: target.path,
    language: target.language,
    signature: target.signature,
    line: target.line,
    implementationStatus: target.implementationStatus ?? 'unknown',
    targetId: target.id,
    children: [],
  });
}

function findNode(
  nodes: ModuleExplorerNode[],
  predicate: (node: ModuleExplorerNode) => boolean,
): ModuleExplorerNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const child = findNode(node.children, predicate);
    if (child) return child;
  }
  return undefined;
}

function collectStatuses(nodes: ModuleExplorerNode[]): ModuleImplementationStatus[] {
  return nodes.flatMap((node) => [
    ...(node.implementationStatus ? [node.implementationStatus] : []),
    ...collectStatuses(node.children),
  ]);
}

function summaryPresentation(summary: ModuleSummary | undefined): ModuleSummaryPresentation {
  if (!summary) return { exists: false, path: summaryRelativePath };
  return {
    exists: true,
    path: summaryRelativePath,
    planId: summary.generated.planId,
    status: summary.generated.status,
    approvalsCurrent: summary.human.approvalsCurrent,
    moduleCount: summary.generated.modules.length,
    waveCount: summary.generated.executionWaves.length,
  };
}

async function readModuleSummary(root: string): Promise<ModuleSummary | undefined> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, ...summaryRelativePath.split('/')), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  if (!isModuleSummary(value)) throw new Error(`${summaryRelativePath} 结构无效`);
  return value;
}

async function readModuleSummarySafely(
  root: string,
): Promise<{ summary?: ModuleSummary; error?: string }> {
  try {
    const summary = await readModuleSummary(root);
    return summary ? { summary } : {};
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isModuleSummary(value: unknown): value is ModuleSummary {
  if (!isRecord(value) || !isRecord(value.generated) || !isRecord(value.human)) return false;
  return (
    typeof value.generated.snapshotId === 'string' &&
    typeof value.generated.planId === 'string' &&
    typeof value.generated.status === 'string' &&
    Array.isArray(value.generated.modules) &&
    value.generated.modules.every((module) =>
      isRecord(module) &&
      typeof module.id === 'string' &&
      typeof module.name === 'string' &&
      typeof module.description === 'string' &&
      isOptionalString(module.purpose) &&
      isOptionalString(module.domain) &&
      isOptionalModuleSummaryLanguage(module.language) &&
      (
        module.coreApis === undefined ||
        (Array.isArray(module.coreApis) && module.coreApis.every((item) => typeof item === 'string'))
      ) &&
      Array.isArray(module.sourceFiles) &&
      module.sourceFiles.every((file) => typeof file === 'string'),
    ) &&
    Array.isArray(value.generated.executionWaves) &&
    typeof value.human.approvalsCurrent === 'boolean'
  );
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalModuleSummaryLanguage(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && moduleSummaryLanguages.has(value));
}

function emptyWorkspacePresentation(
  input: Pick<ModuleWorkspacePresentation, 'id' | 'mode' | 'name' | 'rootLabel'> &
    Pick<ModuleWorkspacePresentation, 'error' | 'loading'>,
): ModuleWorkspacePresentation {
  return {
    ...input,
    stats: {
      modules: 0,
      files: 0,
      types: 0,
      methods: 0,
      implemented: 0,
      unimplemented: 0,
      unknown: 0,
      dependencies: 0,
    },
    summary: { exists: false, path: summaryRelativePath },
    tree: [],
  };
}

function pendingWorkspacePresentation(root: string): ModuleWorkspacePresentation {
  return emptyWorkspacePresentation({
    id: workspacePresentationId('history', root),
    mode: 'history',
    name: path.basename(root),
    rootLabel: path.basename(root),
    loading: true,
  });
}

function workspacePresentationId(mode: 'target' | 'history', root: string): string {
  return `${mode}:${digest(workspaceIdentityKey(root)).slice(0, 16)}`;
}

function distinctResolvedRoots(roots: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const root of roots) {
    const resolved = path.resolve(root);
    const key = workspaceIdentityKey(resolved);
    if (!byKey.has(key)) byKey.set(key, resolved);
  }
  return [...byKey.values()];
}

function workspaceIdentityKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
