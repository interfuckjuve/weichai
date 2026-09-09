import { createHash } from 'node:crypto';
import Parser from 'tree-sitter';
import type { DependencyEdgeRecord, IndexedFileRecord, SourceRange, SymbolRecord } from '@forexplore/contracts';
import { createDefaultLanguageRegistry } from './language-registry.js';

type Input = { repositoryId: string; analysisRevision: string; files: IndexedFileRecord[]; symbols: SymbolRecord[];
  read(path: string): string | undefined; signal?: AbortSignal };
const native = (symbol: SymbolRecord) => ['c', 'cpp'].includes(symbol.languageId);
const range = (node: Parser.SyntaxNode): SourceRange => ({ startLine: node.startPosition.row + 1, startColumn: node.startPosition.column + 1,
  endLine: node.endPosition.row + 1, endColumn: node.endPosition.column + 1 });
const literal = (node: Parser.SyntaxNode | null | undefined) => node?.type === 'string_literal' && /^"[^"\\]*"$/.test(node.text) ? node.text.slice(1, -1) : undefined;
const args = (node: Parser.SyntaxNode) => node.childForFieldName('arguments')?.namedChildren ?? [];
function declaratorName(node: Parser.SyntaxNode): string {
  let value = node;
  while (value.childForFieldName('declarator')) value = value.childForFieldName('declarator')!;
  return value.type === 'identifier' ? value.text : '';
}
function jniName(name: string): string {
  // JNI escapes UTF-16 code units, including both halves of supplementary characters.
  return name.replaceAll('.', '/').split('').map(c => /[a-zA-Z0-9]/.test(c) ? c : c === '/' ? '_' : c === '_' ? '_1'
    : c === ';' ? '_2' : c === '[' ? '_3' : `_0${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
}

/** Only unambiguous primitive, java.lang and fully qualified descriptors; imports need semantic binding. */
function jniParameters(signature: string): string | undefined {
  const parameters = /\(([^()]*)\)/.exec(signature)?.[1];
  if (parameters === undefined) return undefined;
  if (!parameters.trim()) return '';
  const primitives: Record<string, string> = { boolean: 'Z', byte: 'B', char: 'C', short: 'S', int: 'I', long: 'J', float: 'F', double: 'D' };
  const descriptors: string[] = [];
  for (const parameter of parameters.split(',')) {
    const match = /^(?:final\s+)?([\w.$]+)((?:\s*\[\s*\])*)(\s*\.\.\.)?\s+[\w$]+((?:\s*\[\s*\])*)\s*$/.exec(parameter.trim());
    if (!match) return undefined;
    const type = match[1]!;
    const base = primitives[type] ?? (type === 'String' || type === 'Object' ? `Ljava/lang/${type};`
      : /^(?:[a-zA-Z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/.test(type) ? `L${type.replaceAll('.', '/')};` : undefined);
    if (!base) return undefined;
    descriptors.push('['.repeat((match[2]!.match(/\[/g)?.length ?? 0) + (match[4]!.match(/\[/g)?.length ?? 0) + Number(Boolean(match[3]))) + base);
  }
  return descriptors.join('');
}

/** Conservative syntactic bindings. No SDK, macro evaluation or dynamic registration is inferred. */
export function resolveCrossLanguageBindings(input: Input): DependencyEdgeRecord[] {
  const edges: DependencyEdgeRecord[] = [];
  const add = (source: SymbolRecord, kind: string, reference: string, candidates: SymbolRecord[], evidence = source.sourceRange) => {
    const targets = [...new Map(candidates.map(value => [value.symbolKey, value])).values()];
    const resolution = targets.length === 1 ? 'resolved' : targets.length ? 'ambiguous' : 'unresolved';
    const identity = [kind, source.symbolKey, reference, evidence];
    edges.push({ repositoryId: input.repositoryId, analysisRevision: input.analysisRevision,
      dependencyEdgeId: `binding:${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24)}`,
      kind, sourceRelativePath: source.relativePath, sourceSymbolKey: source.symbolKey, targetReference: reference,
      ...(targets.length === 1 ? { targetRelativePath: targets[0]!.relativePath, targetSymbolKey: targets[0]!.symbolKey } : {}),
      internal: true, resolution, provider: 'tree-sitter', confidence: resolution === 'resolved' ? 0.85 : 0.2,
      evidenceLevel: resolution === 'resolved' ? 'syntactic' : resolution, evidenceRanges: [evidence] });
  };
  for (const source of input.symbols) {
    input.signal?.throwIfAborted();
    if (source.languageId === 'java' && /\bnative\b/.test(source.signature ?? '')) {
      const reference = `Java_${jniName(source.qualifiedName)}`;
      // Short JNI exports are insufficient to disambiguate overloaded native methods.
      const overloads = input.symbols.filter(value => value.languageId === 'java' && value.qualifiedName === source.qualifiedName && /\bnative\b/.test(value.signature ?? ''));
      const targets = input.symbols.filter(value => native(value) && value.name === reference && /^JNIEXPORT\b/.test(value.signature ?? ''));
      const parameters = jniParameters(source.signature ?? '');
      const longReference = parameters === undefined ? undefined : `${reference}__${jniName(parameters)}`;
      const longTargets = longReference === undefined ? [] : input.symbols.filter(value => native(value) && value.name === longReference && /^JNIEXPORT\b/.test(value.signature ?? ''));
      // The VM searches the short name first. An overloaded short export cannot
      // be made safe merely by finding a compatible long export alongside it.
      add(source, 'jni-binding', targets.length ? reference : longReference ?? reference,
        targets.length ? overloads.length === 1 ? targets : [] : longTargets);
    }
    if (source.languageId === 'kotlin' && /\bexpect\b/.test(source.signature ?? '')) {
      const module = /^(.*\/)?src\/commonMain\//.exec(source.relativePath)?.[1] ?? (source.relativePath.startsWith('src/commonMain/') ? '' : undefined);
      const signature = (value: SymbolRecord) => (value.signature ?? '').replace(/\b(expect|actual)\s+/g, '').replace(/\s+/g, ' ').trim();
      const targets = module === undefined ? [] : input.symbols.filter(value => value.languageId === 'kotlin' && value.qualifiedName === source.qualifiedName &&
        /\bactual\b/.test(value.signature ?? '') && value.relativePath.startsWith(`${module}src/`) &&
        /^\w+Main\//.test(value.relativePath.slice(`${module}src/`.length)) && signature(value) === signature(source));
      add(source, 'kmp-binding', source.qualifiedName, targets);
    }
  }
  // Read one native/ArkTS file at a time from the immutable snapshot. Source text
  // is released per iteration; only bounded registration facts survive it.
  const registry = createDefaultLanguageRegistry();
  const registrations: Array<{ module: string; exported: string; target: SymbolRecord }> = [];
  const calls: Array<{ module: string; exported: string; source: SymbolRecord; range: SourceRange }> = [];
  for (const file of input.files.filter(value => ['c', 'cpp', 'arkts'].includes(value.languageId ?? ''))) {
    input.signal?.throwIfAborted();
    const content = input.read(file.relativePath);
    if (content === undefined || !/napi_|NAPI_MODULE|lib[^'"\s]+\.so/.test(content)) continue;
    const language = registry.resolvePath(file.relativePath);
    if (!language) continue;
    const parser = new Parser(); parser.setLanguage(language.grammar as never);
    const root = parser.parse(offset => content.slice(offset, offset + 8192)).rootNode;
    const symbols = input.symbols.filter(value => value.relativePath === file.relativePath);
    const owner = (node: Parser.SyntaxNode) => symbols.filter(value => ['function', 'method', 'constructor'].includes(value.kind) &&
      (value.sourceRange.startLine < node.startPosition.row + 1 || value.sourceRange.startLine === node.startPosition.row + 1 && value.sourceRange.startColumn <= node.startPosition.column + 1) &&
      (value.sourceRange.endLine > node.endPosition.row + 1 || value.sourceRange.endLine === node.endPosition.row + 1 && value.sourceRange.endColumn >= node.endPosition.column + 1))
      .sort((a, b) => (a.sourceRange.endLine - a.sourceRange.startLine) - (b.sourceRange.endLine - b.sourceRange.startLine))[0];
    const expressions = root.descendantsOfType('call_expression');
    if (file.languageId === 'arkts') {
      const imports = new Map<string, string>();
      for (const statement of root.descendantsOfType('import_statement')) {
        const source = statement.childForFieldName('source')?.text;
        const module = source && /^['"]lib([^'"]+)\.so['"]$/.exec(source)?.[1];
        const clause = statement.namedChildren.find(value => value.type === 'import_clause');
        const name = clause?.namedChildren.find(value => value.type === 'identifier');
        if (module && name) imports.set(name.text, module);
      }
      for (const call of expressions) {
        const fn = call.childForFieldName('function');
        if (fn?.type !== 'member_expression') continue;
        const object = fn.childForFieldName('object'), property = fn.childForFieldName('property');
        const module = object?.type === 'identifier' ? imports.get(object.text) : undefined;
        const source = owner(call);
        // Shadowed imported names cannot be bound without lexical resolution.
        const shadowed = object && root.descendantsOfType(['variable_declarator', 'required_parameter', 'optional_parameter']).some(value => value.childForFieldName('name')?.text === object.text || value.childForFieldName('pattern')?.text === object.text);
        if (module && property && source && !shadowed) calls.push({ module, exported: property.text, source, range: range(call) });
      }
      continue;
    }
    const modules = new Map<string, string[]>();
    const register = (module: string, init: string) => modules.set(init, [...(modules.get(init) ?? []), module]);
    for (const call of expressions) if (call.childForFieldName('function')?.text === 'NAPI_MODULE') {
      const values = args(call);
      if (values.length === 2 && values.every(value => value.type === 'identifier')) register(values[0]!.text, values[1]!.text);
    }
    for (const declaration of root.descendantsOfType('declaration')) {
      if (declaration.childForFieldName('type')?.text !== 'napi_module') continue;
      const init = declaration.childForFieldName('declarator');
      const value = init?.childForFieldName('value');
      if (!init || !value) continue;
      const name = declaratorName(init);
      if (!expressions.some(call => call.childForFieldName('function')?.text === 'napi_module_register' && args(call)[0]?.text.replace(/\s/g, '') === `&${name}`)) continue;
      const fields = new Map(value.namedChildren.filter(child => child.type === 'initializer_pair').map(child =>
        [child.childForFieldName('designator')?.text, child.childForFieldName('value')]));
      const module = literal(fields.get('.nm_modname')), callback = fields.get('.nm_register_func');
      if (module && callback?.type === 'identifier') register(module, callback.text);
    }
    for (const definition of root.descendantsOfType('function_definition')) {
      const initName = declaratorName(definition), moduleNames = modules.get(initName);
      if (!moduleNames) continue;
      const parameters = definition.childForFieldName('declarator')?.childForFieldName('parameters')?.namedChildren ?? [];
      const exportsName = parameters[1] ? declaratorName(parameters[1]) : '';
      const returns = definition.descendantsOfType('return_statement');
      if (!exportsName || returns.length !== 1 || returns[0]!.namedChildren[0]?.text !== exportsName) continue;
      for (const call of definition.descendantsOfType('call_expression')) {
        if (call.childForFieldName('function')?.text !== 'napi_define_properties') continue;
        const values = args(call), descriptorName = values[3];
        if (values.length !== 4 || values[1]?.text !== exportsName || descriptorName?.type !== 'identifier') continue;
        const declarations = definition.descendantsOfType('declaration').filter(value => value.childForFieldName('type')?.text === 'napi_property_descriptor' &&
          value.childForFieldName('declarator') && declaratorName(value.childForFieldName('declarator')!) === descriptorName.text);
        if (declarations.length !== 1) continue;
        const list = declarations[0]!.childForFieldName('declarator')?.childForFieldName('value');
        // Only a literal count matching the actual descriptor list is supported.
        if (!list || values[2]?.type !== 'number_literal' || Number(values[2].text) !== list.namedChildren.length) continue;
        for (const entry of list.namedChildren) {
          if (entry.type !== 'initializer_list') continue;
          const items = entry.namedChildren, exported = literal(items[0]), callback = items[2];
          if (!exported || callback?.type !== 'identifier') continue;
          for (const target of symbols.filter(value => value.name === callback.text && value.kind === 'function')) {
            for (const module of moduleNames) registrations.push({ module, exported, target });
          }
        }
      }
    }
  }
  for (const call of calls) add(call.source, 'napi-binding', `lib${call.module}.so::${call.exported}`,
    registrations.filter(value => value.module === call.module && value.exported === call.exported).map(value => value.target), call.range);
  return edges;
}
