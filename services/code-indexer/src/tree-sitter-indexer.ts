import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import type { SourceRange } from '@forexplore/contracts';
import type {
  TreeSitterLanguageId,
  TreeSitterLanguageRegistration,
} from './language-registry.js';

export type StructuralSourceRange = SourceRange;

export type StructuralSymbolKind =
  | 'class'
  | 'constructor'
  | 'enum'
  | 'field'
  | 'function'
  | 'implementation'
  | 'interface'
  | 'method'
  | 'namespace'
  | 'package'
  | 'property'
  | 'record'
  | 'struct'
  | 'type';

export interface TreeSitterDeclaration {
  astDeclarationId: string;
  containerSymbolKey?: string;
  declarationNodeType: string;
  isExported: boolean;
  kind: StructuralSymbolKind;
  name: string;
  qualifiedName: string;
  relativePath: string;
  signature: string;
  sourceRange: StructuralSourceRange;
  /**
   * Stable structural identity: qualified declaration, normalized signature,
   * grammar node type, and language. Position is deliberately not part of it.
   */
  symbolKey: string;
}

export interface TreeSitterImport {
  importKind: 'import' | 're-export';
  languageId: TreeSitterLanguageId;
  relativePath: string;
  sourceRange: StructuralSourceRange;
  targetReference: string;
}

export interface TreeSitterExport {
  exportKind: 'declaration' | 'named' | 're-export';
  languageId: TreeSitterLanguageId;
  relativePath: string;
  sourceRange: StructuralSourceRange;
  targetReference?: string;
}

export interface TreeSitterDiagnostic {
  code: 'TREE_SITTER_PARSE_ERROR';
  message: string;
  relativePath: string;
  severity: 'warning';
  sourceRange?: StructuralSourceRange;
}

export interface TreeSitterFileIndex {
  declarations: TreeSitterDeclaration[];
  diagnostics: TreeSitterDiagnostic[];
  exports: TreeSitterExport[];
  imports: TreeSitterImport[];
  languageId: TreeSitterLanguageId;
  relativePath: string;
}

export interface TreeSitterIndexRequest {
  content: string;
  language: TreeSitterLanguageRegistration;
  relativePath: string;
}

const declarationKinds: Readonly<Record<string, StructuralSymbolKind>> = {
  class_specifier: 'class',
  struct_specifier: 'struct',
  enum_specifier: 'enum',
  namespace_definition: 'namespace',
  object_declaration: 'class',
  package_header: 'package',
  annotation_type_declaration: 'interface',
  class_declaration: 'class',
  class_definition: 'class',
  constructor_declaration: 'constructor',
  delegate_declaration: 'type',
  enum_declaration: 'enum',
  enum_item: 'enum',
  field_declaration: 'field',
  function_declaration: 'function',
  function_definition: 'function',
  function_item: 'function',
  impl_item: 'implementation',
  interface_declaration: 'interface',
  method_declaration: 'method',
  method_definition: 'method',
  method_signature: 'method',
  file_scoped_namespace_declaration: 'namespace',
  namespace_declaration: 'namespace',
  package_clause: 'package',
  package_declaration: 'package',
  property_declaration: 'property',
  record_declaration: 'record',
  struct_declaration: 'struct',
  struct_item: 'struct',
  trait_item: 'interface',
  type_spec: 'type',
  // ECMAScript and TypeScript bind names through a lexical/variable
  // declaration wrapper rather than a class-style field node.  Treat those
  // bindings as structural fields so exported constants and functions stored
  // in variables are discoverable without claiming semantic call edges.
  lexical_declaration: 'field',
  variable_declaration: 'field',
};

const containerKinds = new Set<StructuralSymbolKind>([
  'class',
  'constructor',
  'enum',
  'function',
  'implementation',
  'interface',
  'method',
  'namespace',
  'package',
  'record',
  'struct',
  'type',
]);

const identifierNodeTypes = new Set([
  'dotted_name',
  'field_identifier',
  'identifier',
  'package_identifier',
  'property_identifier',
  'qualified_name',
  'qualified_identifier',
  'simple_identifier',
  'scoped_identifier',
  'type_identifier',
]);

function normalizedText(value: string, maximum = 1_000): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function sourceFor(node: Parser.SyntaxNode, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function rangeForNode(node: Parser.SyntaxNode): StructuralSourceRange {
  const startLine = node.startPosition.row + 1;
  const startColumn = node.startPosition.column + 1;
  const endLine = node.endPosition.row + 1;
  const rawEndColumn = node.endPosition.column + 1;
  return {
    startLine,
    startColumn,
    endLine,
    // Missing/error nodes may have zero width. The shared contract requires a
    // non-empty, end-exclusive range, so retain the insertion point as one
    // column wide.
    endColumn: endLine === startLine && rawEndColumn <= startColumn
      ? startColumn + 1
      : rawEndColumn,
  };
}

/** Build a one-based source range for non-AST project manifest tokens. */
export function sourceRangeForOffsets(
  source: string,
  startOffset: number,
  endOffset: number,
): StructuralSourceRange {
  const boundedStart = Math.max(0, Math.min(source.length, startOffset));
  const boundedEnd = Math.max(boundedStart, Math.min(source.length, endOffset));
  const position = (offset: number): { column: number; line: number } => {
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < offset; index += 1) {
      if (source[index] === '\n') {
        line += 1;
        lineStart = index + 1;
      }
    }
    return { line, column: offset - lineStart + 1 };
  };
  const start = position(boundedStart);
  const end = position(boundedEnd);
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.line === start.line && end.column <= start.column
      ? start.column + 1
      : end.column,
  };
}

function isDeclaration(node: Parser.SyntaxNode): node is Parser.SyntaxNode {
  return declarationKinds[node.type] !== undefined;
}

function declarationKind(node: Parser.SyntaxNode): StructuralSymbolKind | undefined {
  return declarationKinds[node.type];
}

function nameNodeFor(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  // Native function names can be nested under pointer/qualified declarators;
  // inspecting the return type first would name `int sum()` as `int`.
  let declarator = node.childForFieldName('declarator');
  while (declarator) {
    const nested = declarator.childForFieldName('declarator');
    if (!nested) return declarator;
    declarator = nested;
  }
  for (const field of ['name', 'type', 'module_name']) {
    const candidate = node.childForFieldName(field);
    if (candidate) return candidate;
  }
  return node.namedChildren.find((candidate) => identifierNodeTypes.has(candidate.type));
}

function declarationName(node: Parser.SyntaxNode, source: string): string | undefined {
  const candidate = nameNodeFor(node);
  const name = candidate ? normalizedText(sourceFor(candidate, source), 512) : '';
  return name || undefined;
}

function signatureFor(node: Parser.SyntaxNode, source: string): string {
  const body = node.childForFieldName('body')
    ?? node.namedChildren.find((child) =>
      ['function_body', 'enum_class_body', 'block', 'class_body', 'declaration_list', 'interface_body', 'statement_block'].includes(child.type),
    );
  const end = body?.startIndex ?? node.endIndex;
  return normalizedText(source.slice(node.startIndex, end));
}

function parentExported(node: Parser.SyntaxNode): boolean {
  return node.parent?.type === 'export_statement';
}

function declarationExported(
  node: Parser.SyntaxNode,
  languageId: TreeSitterLanguageId,
  name: string,
  source: string,
): boolean {
  if (parentExported(node)) return true;
  const text = sourceFor(node, source).trimStart();
  if (languageId === 'kotlin') return !/\b(private|internal)\b/.test(signatureFor(node, source));
  if (languageId === 'rust') return /^pub(?:\s*\([^)]*\))?\b/.test(text);
  if (languageId === 'java' || languageId === 'csharp') return /^public\b/.test(text);
  if (languageId === 'go') return /^[A-Z]/.test(name);
  return false;
}

function bindingDeclarationNames(node: Parser.SyntaxNode, source: string): string[] {
  if (!['field_declaration', 'lexical_declaration', 'variable_declaration'].includes(node.type)) return [];
  const names = node.descendantsOfType(['variable_declarator']);
  return names
    .map((entry) => entry.childForFieldName('name') ?? entry.namedChildren.find((child) => identifierNodeTypes.has(child.type)))
    .flatMap((entry) => entry ? [normalizedText(sourceFor(entry, source), 512)] : [])
    .filter(Boolean);
}

function declarationNames(node: Parser.SyntaxNode, source: string): string[] {
  const bindingNames = bindingDeclarationNames(node, source);
  if (bindingNames.length > 0) return bindingNames;
  return [declarationName(node, source)].filter((name): name is string => Boolean(name));
}

function fileScopeName(
  root: Parser.SyntaxNode,
  languageId: TreeSitterLanguageId,
  source: string,
): string | undefined {
  const fileScopeTypes = languageId === 'kotlin' ? new Set(['package_header']) : languageId === 'java'
    ? new Set(['package_declaration'])
    : languageId === 'csharp'
      ? new Set(['file_scoped_namespace_declaration'])
      : languageId === 'go'
        ? new Set(['package_clause'])
        : new Set<string>();
  const declaration = root.namedChildren.find((child) => fileScopeTypes.has(child.type));
  return declaration ? declarationName(declaration, source) : undefined;
}

function symbolKey(
  languageId: TreeSitterLanguageId,
  qualifiedName: string,
  kind: StructuralSymbolKind,
  signature: string,
  astDeclarationId: string,
): string {
  return `symbol:${hash(JSON.stringify({
    languageId,
    qualifiedName,
    kind,
    signature,
    astDeclarationId,
  }))}`;
}

function astDeclarationId(node: Parser.SyntaxNode, signature: string, relativePath: string): string {
  // Tree-sitter's runtime node.id is allocation-local. A normalized syntax
  // identity survives reparsing and does not rely on a line or byte offset.
  return `ast:${hash(JSON.stringify({ relativePath, nodeType: node.type, signature }))}`;
}

interface ContainerContext {
  qualifiedName: string;
  symbolKey: string;
}

function qualifiedNameFor(name: string, contexts: readonly ContainerContext[], fileScope?: string): string {
  const parent = contexts.at(-1)?.qualifiedName ?? fileScope;
  return parent ? `${parent}.${name}` : name;
}

function collectDeclarations(
  root: Parser.SyntaxNode,
  request: TreeSitterIndexRequest,
): TreeSitterDeclaration[] {
  const declarations: TreeSitterDeclaration[] = [];
  const fileScope = fileScopeName(root, request.language.languageId, request.content);

  const visit = (node: Parser.SyntaxNode, contexts: readonly ContainerContext[]): void => {
    const kind = declarationKind(node);
    let nextContexts = contexts;
    if (kind) {
      const nodeNames = declarationNames(node, request.content);
      const signature = signatureFor(node, request.content);
      for (const name of nodeNames) {
        // A Java package, Go package, or file-scoped C# namespace is both
        // the file scope and a declaration record. Do not qualify that
        // declaration with itself; children still inherit the file scope.
        const qualifiedName = contexts.length === 0 && fileScope === name &&
          (kind === 'package' || kind === 'namespace')
          ? name
          : qualifiedNameFor(name, contexts, fileScope);
        const declarationId = astDeclarationId(node, signature, request.relativePath);
        const entry: TreeSitterDeclaration = {
          astDeclarationId: declarationId,
          declarationNodeType: node.type,
          isExported: declarationExported(node, request.language.languageId, name, request.content),
          kind,
          name,
          qualifiedName,
          relativePath: request.relativePath,
          signature,
          sourceRange: rangeForNode(node),
          symbolKey: symbolKey(request.language.languageId, qualifiedName, kind, signature, declarationId),
          ...(contexts.at(-1) ? { containerSymbolKey: contexts.at(-1)?.symbolKey } : {}),
        };
        declarations.push(entry);
        if (containerKinds.has(kind) && nodeNames.length === 1) {
          nextContexts = [...contexts, { qualifiedName, symbolKey: entry.symbolKey }];
        }
      }
    }
    for (const child of node.namedChildren) visit(child, nextContexts);
  };

  for (const child of root.namedChildren) visit(child, []);
  return dedupeBy(declarations, (entry) => entry.symbolKey);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ['"', "'", '`'].includes(trimmed[0] ?? '') && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function importTargets(
  node: Parser.SyntaxNode,
  languageId: TreeSitterLanguageId,
  source: string,
): Array<{ range: Parser.SyntaxNode; target: string }> {
  if (languageId === 'javascript' || languageId === 'typescript' || languageId === 'arkts') {
    const sourceNode = node.childForFieldName('source');
    return sourceNode ? [{ range: sourceNode, target: unquote(sourceFor(sourceNode, source)) }] : [];
  }
  if (languageId === 'c' || languageId === 'cpp') {
    const target = node.childForFieldName('path');
    return target ? [{ range: target, target: unquote(sourceFor(target, source)) }] : [];
  }
  if (languageId === 'kotlin') {
    const target = sourceFor(node, source).replace(/^\s*import\s+/, '').replace(/\s+as\s+\w+\s*$/, '').trim();
    return target ? [{ range: node, target }] : [];
  }
  if (languageId === 'java') {
    const target = sourceFor(node, source)
      .replace(/^\s*import\s+(?:static\s+)?/, '')
      .replace(/;\s*$/, '')
      .trim();
    return target ? [{ range: node, target }] : [];
  }
  if (languageId === 'csharp') {
    const target = sourceFor(node, source)
      .replace(/^\s*(?:global\s+)?using\s+(?:static\s+)?/, '')
      .replace(/;\s*$/, '')
      .trim()
      .replace(/^[A-Za-z_][\w]*\s*=\s*/, '');
    return target ? [{ range: node, target }] : [];
  }
  if (languageId === 'python') {
    if (node.type === 'import_from_statement') {
      const moduleName = node.childForFieldName('module_name');
      const fromPrefix = /^\s*from\s+(\.*)/.exec(sourceFor(node, source))?.[1] ?? '';
      const module = moduleName ? sourceFor(moduleName, source) : '';
      return module || fromPrefix ? [{ range: moduleName ?? node, target: `${fromPrefix}${module}` }] : [];
    }
    return node.namedChildren
      .filter((child) => child.type === 'dotted_name')
      .map((child) => ({ range: child, target: sourceFor(child, source) }));
  }
  if (languageId === 'go') {
    const path = node.childForFieldName('path');
    return path ? [{ range: path, target: unquote(sourceFor(path, source)) }] : [];
  }
  if (languageId === 'rust') {
    const target = sourceFor(node, source)
      .replace(/^\s*use\s+/, '')
      .replace(/;\s*$/, '')
      .trim();
    return target ? [{ range: node, target }] : [];
  }
  return [];
}

function collectImports(root: Parser.SyntaxNode, request: TreeSitterIndexRequest): TreeSitterImport[] {
  const imports: TreeSitterImport[] = [];
  const importTypes = new Set(
    request.language.languageId === 'go'
      ? ['import_spec']
      : request.language.languageId === 'python'
        ? ['import_from_statement', 'import_statement']
        : request.language.languageId === 'rust'
          ? ['use_declaration']
          : ['import', 'import_header', 'preproc_include', 'import_declaration', 'import_statement', 'using_directive'],
  );
  const visit = (node: Parser.SyntaxNode): void => {
    if (importTypes.has(node.type)) {
      const reExport = node.parent?.type === 'export_statement';
      for (const target of importTargets(node, request.language.languageId, request.content)) {
        if (!target.target) continue;
        imports.push({
          importKind: reExport ? 're-export' : 'import',
          languageId: request.language.languageId,
          relativePath: request.relativePath,
          sourceRange: rangeForNode(target.range),
          targetReference: target.target,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return dedupeBy(imports, (entry) => `${entry.importKind}:${entry.targetReference}:${rangeKey(entry.sourceRange)}`);
}

function exportTarget(node: Parser.SyntaxNode, source: string): string | undefined {
  const declaration = node.childForFieldName('declaration');
  if (declaration) return declarationNames(declaration, source)[0];
  const clause = node.namedChildren.find((child) => ['export_clause', 'namespace_export', 'identifier'].includes(child.type));
  return clause ? normalizedText(sourceFor(clause, source), 512) : undefined;
}

function collectExports(
  root: Parser.SyntaxNode,
  request: TreeSitterIndexRequest,
  declarations: readonly TreeSitterDeclaration[],
): TreeSitterExport[] {
  const exports: TreeSitterExport[] = [];
  const add = (
    sourceRange: StructuralSourceRange,
    exportKind: TreeSitterExport['exportKind'],
    targetReference?: string,
  ): void => {
    exports.push({
      exportKind,
      languageId: request.language.languageId,
      relativePath: request.relativePath,
      sourceRange,
      ...(targetReference ? { targetReference } : {}),
    });
  };

  if (request.language.languageId === 'javascript' || request.language.languageId === 'typescript' || request.language.languageId === 'arkts') {
    const visit = (node: Parser.SyntaxNode): void => {
      if (node.type === 'export_statement') {
        const sourceNode = node.childForFieldName('source');
        add(
          rangeForNode(node),
          sourceNode ? 're-export' : 'declaration',
          sourceNode ? unquote(sourceFor(sourceNode, request.content)) : exportTarget(node, request.content),
        );
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(root);
  } else {
    for (const declaration of declarations) {
      if (declaration.isExported) {
        add(declaration.sourceRange, 'declaration', declaration.qualifiedName);
      }
    }
  }
  return dedupeBy(exports, (entry) => `${entry.exportKind}:${entry.targetReference ?? ''}:${rangeKey(entry.sourceRange)}`);
}

function rangeKey(range: StructuralSourceRange): string {
  return `${range.startLine}:${range.startColumn}:${range.endLine}:${range.endColumn}`;
}

function collectDiagnostics(root: Parser.SyntaxNode, relativePath: string): TreeSitterDiagnostic[] {
  const diagnostics: TreeSitterDiagnostic[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if ((node.isError || node.isMissing) && diagnostics.length < 25) {
      diagnostics.push({
        code: 'TREE_SITTER_PARSE_ERROR',
        message: node.isMissing
          ? `Tree-sitter reported a missing ${node.type} node.`
          : `Tree-sitter reported a syntax error near ${node.type}.`,
        relativePath,
        severity: 'warning',
        sourceRange: rangeForNode(node),
      });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return dedupeBy(diagnostics, (entry) => `${entry.message}:${entry.sourceRange ? rangeKey(entry.sourceRange) : ''}`);
}

function dedupeBy<T>(entries: readonly T[], key: (entry: T) => string): T[] {
  const result = new Map<string, T>();
  for (const entry of entries) result.set(key(entry), entry);
  return [...result.values()];
}

/**
 * Parses one already-authorized repository-relative source file. The parser
 * only produces structural evidence: declarations, import/export syntax,
 * source ranges, and parse diagnostics. It never attempts call-graph or
 * cross-file definition/reference claims.
 */
export function indexTreeSitterFile(request: TreeSitterIndexRequest): TreeSitterFileIndex {
  const parser = new Parser();
  parser.setLanguage(request.language.grammar as never);
  // The native binding's default input buffer cannot accept an entire large string.
  const tree = parser.parse((offset) => request.content.slice(offset, offset + 8192));
  const declarations = collectDeclarations(tree.rootNode, request);
  return {
    declarations,
    diagnostics: collectDiagnostics(tree.rootNode, request.relativePath),
    exports: collectExports(tree.rootNode, request, declarations),
    imports: collectImports(tree.rootNode, request),
    languageId: request.language.languageId,
    relativePath: request.relativePath,
  };
}

export const treeSitterIndexerInternals = {
  declarationKind,
  normalizedText,
  signatureFor,
  sourceRangeForOffsets,
};
