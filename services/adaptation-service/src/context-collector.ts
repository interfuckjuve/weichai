import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  CallerContext,
  MigrationTargetEntityRef,
  ModuleTarget,
  RelatedTypeContext,
  TargetDependencyContext,
  TargetModuleContext,
  TargetContextFactV2,
} from "@forexplore/contracts";
import { normalizeLanguageId } from "@forexplore/contracts";

const DEFAULT_MAX_CHARS = 24_000;
const DEFAULT_MAX_CALLERS = 3;
const DEFAULT_MAX_RELATED_TYPES = 8;
const DEFAULT_MAX_FILES_TO_SCAN = 1_000;

const BUILT_IN_TYPES = new Set([
  "Action",
  "Array",
  "Boolean",
  "CancellationToken",
  "DateTime",
  "DateTimeOffset",
  "Decimal",
  "Dictionary",
  "Enum",
  "Exception",
  "Func",
  "IEnumerable",
  "IReadOnlyCollection",
  "IReadOnlyList",
  "IReadOnlyDictionary",
  "List",
  "Object",
  "String",
  "Task",
  "TimeSpan",
  "ValueTask",
  "bool",
  "byte",
  "char",
  "decimal",
  "double",
  "float",
  "int",
  "long",
  "object",
  "sbyte",
  "short",
  "string",
  "uint",
  "ulong",
  "ushort",
  "void",
]);

export interface ContextCollectorOptions {
  projectRoot: string;
  target: ModuleTarget;
  maxChars?: number;
  maxCallers?: number;
  maxRelatedTypes?: number;
  signal?: AbortSignal;
  adapterRegistry?: TargetEngineeringAdapterRegistry;
}

export type TargetEngineeringStage = "context" | "patch-locator";

export interface TargetEngineeringUnsupportedReason {
  code:
    | "TARGET_ENGINEERING_ADAPTER_UNAVAILABLE"
    | "TARGET_CONTEXT_CAPABILITY_UNAVAILABLE"
    | "TARGET_PATCH_LOCATOR_CAPABILITY_UNAVAILABLE";
  stage: TargetEngineeringStage;
  languageId: string;
  detail: string;
  retryable: false;
}

export class TargetEngineeringUnsupportedError extends Error {
  readonly reason: TargetEngineeringUnsupportedReason;

  constructor(reason: TargetEngineeringUnsupportedReason) {
    super(`[${reason.code}] ${reason.detail}`);
    this.name = "TargetEngineeringUnsupportedError";
    this.reason = reason;
  }
}

export interface TargetEngineeringCapabilityDescriptor {
  id: string;
  version: string;
  languageId: string;
  context: {
    status: "supported" | "unsupported";
    targetKinds: readonly ("class" | "function")[];
    ownerKinds: readonly ("type" | "module")[];
    relatedFileExtensions: readonly string[];
  };
  patchLocator: {
    status: "supported" | "unsupported";
    targetKinds: readonly ("class" | "function")[];
  };
  quality: {
    level: "language-aware-lexical-heuristic" | "unavailable";
    provesBehavioralCorrectness: false;
    failClosed: true;
    limitations: readonly string[];
  };
}

export interface TargetContextSnapshot {
  schemaVersion: "1.0";
  languageId: string;
  ownerKind: "type" | "module";
  adapter: { id: string; version: string; languageId: string };
  context: TargetModuleContext;
}

export interface TargetPatchLocatorInput {
  source: string;
  targetLine: number;
  targetKind: "class" | "function";
  targetName?: string;
}

export interface TargetPatchLocation {
  startLine: number;
  endLine: number;
  declarationIndentation: string;
}

export interface TargetEngineeringPatchContextV2 {
  source: string;
  target: MigrationTargetEntityRef;
  declaration: TargetContextFactV2;
}

export type TargetEngineeringResult<T> =
  | { status: "supported"; value: T }
  | { status: "unsupported"; reason: TargetEngineeringUnsupportedReason };

export interface TargetEngineeringContextRequest {
  projectRoot: string;
  target: ModuleTarget;
  maxChars: number;
  maxCallers: number;
  maxRelatedTypes: number;
  signal?: AbortSignal;
}

export interface TargetEngineeringAdapter {
  descriptor: TargetEngineeringCapabilityDescriptor;
  collectContext(
    request: TargetEngineeringContextRequest,
  ): TargetEngineeringResult<TargetContextSnapshot>;
  locatePatch(
    input: TargetPatchLocatorInput,
  ): TargetEngineeringResult<TargetPatchLocation>;
  locatePatchFromContext(
    input: TargetEngineeringPatchContextV2,
  ): TargetEngineeringResult<TargetPatchLocation>;
}

export class TargetEngineeringAdapterRegistry {
  private readonly byLanguageId = new Map<string, TargetEngineeringAdapter>();

  constructor(adapters: readonly TargetEngineeringAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: TargetEngineeringAdapter): void {
    const languageId = canonicalTargetLanguageId(adapter.descriptor.languageId);
    assertEngineeringDescriptor(adapter.descriptor, languageId);
    if (this.byLanguageId.has(languageId)) {
      throw new Error(`Target engineering adapter is already registered for ${languageId}.`);
    }
    this.byLanguageId.set(languageId, adapter);
  }

  adapterFor(language: string): TargetEngineeringAdapter | undefined {
    return this.byLanguageId.get(canonicalTargetLanguageId(language));
  }

  capabilities(): TargetEngineeringCapabilityDescriptor[] {
    return [...this.byLanguageId.values()]
      .map(({ descriptor }) => cloneEngineeringDescriptor(descriptor))
      .sort((left, right) => left.languageId.localeCompare(right.languageId));
  }
}

interface BraceEngineeringConfiguration {
  languageId: "java" | "csharp" | "typescript";
  extensions: readonly string[];
  ownerKinds: readonly ("type" | "module")[];
  masking: "java" | "csharp" | "typescript";
}

export function createDefaultTargetEngineeringAdapterRegistry(): TargetEngineeringAdapterRegistry {
  return new TargetEngineeringAdapterRegistry([
    createBraceEngineeringAdapter({
      languageId: "java",
      extensions: [".java"],
      ownerKinds: ["type"],
      masking: "java",
    }),
    createBraceEngineeringAdapter({
      languageId: "csharp",
      extensions: [".cs"],
      ownerKinds: ["type"],
      masking: "csharp",
    }),
    createBraceEngineeringAdapter({
      languageId: "typescript",
      extensions: [".ts", ".tsx", ".mts", ".cts"],
      ownerKinds: ["type", "module"],
      masking: "typescript",
    }),
    createPythonEngineeringAdapter(),
    createCapabilityGapAdapter("go"),
    createCapabilityGapAdapter("rust"),
  ]);
}

function createBraceEngineeringAdapter(
  configuration: BraceEngineeringConfiguration,
): TargetEngineeringAdapter {
  const descriptor: TargetEngineeringCapabilityDescriptor = {
    id: `forexplore.target-engineering.${configuration.languageId}.lexical`,
    version: "1.0.0",
    languageId: configuration.languageId,
    context: {
      status: "supported",
      targetKinds: ["class", "function"],
      ownerKinds: configuration.ownerKinds,
      relatedFileExtensions: configuration.extensions,
    },
    patchLocator: {
      status: "supported",
      targetKinds: ["class", "function"],
    },
    quality: {
      level: "language-aware-lexical-heuristic",
      provesBehavioralCorrectness: false,
      failClosed: true,
      limitations: [
        "Context and patch boundaries are lexical evidence, not compiler AST evidence.",
        "Ambiguous or unbalanced declarations are rejected instead of widening the patch range.",
      ],
    },
  };
  const syntax = createBraceContextSyntax(configuration);
  return {
    descriptor,
    collectContext(request) {
      return {
        status: "supported",
        value: collectContextWithSyntax(request, descriptor, syntax),
      };
    },
    locatePatch(input) {
      return locateBracePatch(input, configuration);
    },
    locatePatchFromContext(input) {
      return locateBracePatch(patchLocatorInputFromContext(input, configuration), configuration);
    },
  };
}

function createPythonEngineeringAdapter(): TargetEngineeringAdapter {
  const descriptor: TargetEngineeringCapabilityDescriptor = {
    id: "forexplore.target-engineering.python.lexical",
    version: "1.0.0",
    languageId: "python",
    context: {
      status: "supported",
      targetKinds: ["class", "function"],
      ownerKinds: ["type", "module"],
      relatedFileExtensions: [".py"],
    },
    patchLocator: {
      status: "supported",
      targetKinds: ["class", "function"],
    },
    quality: {
      level: "language-aware-lexical-heuristic",
      provesBehavioralCorrectness: false,
      failClosed: true,
      limitations: [
        "Indentation, comments, and triple-quoted literals are handled lexically; decorators are not executed.",
        "Ambiguous suites are rejected instead of extending a patch into a sibling declaration.",
      ],
    },
  };
  return {
    descriptor,
    collectContext(request) {
      return {
        status: "supported",
        value: collectContextWithSyntax(request, descriptor, pythonContextSyntax()),
      };
    },
    locatePatch: locatePythonPatch,
    locatePatchFromContext(input) {
      return locatePythonPatch(pythonPatchLocatorInputFromContext(input));
    },
  };
}

function createCapabilityGapAdapter(languageId: "go" | "rust"): TargetEngineeringAdapter {
  const descriptor: TargetEngineeringCapabilityDescriptor = {
    id: `forexplore.target-engineering.${languageId}.capability-gap`,
    version: "1.0.0",
    languageId,
    context: {
      status: "unsupported",
      targetKinds: [],
      ownerKinds: [],
      relatedFileExtensions: [],
    },
    patchLocator: { status: "unsupported", targetKinds: [] },
    quality: {
      level: "unavailable",
      provesBehavioralCorrectness: false,
      failClosed: true,
      limitations: [
        `${languageId} target context and patch location require a dedicated engineering adapter.`,
        "Compiler availability does not imply safe context collection, patching, or behavioral verification.",
      ],
    },
  };
  return {
    descriptor,
    collectContext() {
      return unsupportedEngineering(
        "TARGET_CONTEXT_CAPABILITY_UNAVAILABLE",
        "context",
        languageId,
        `The ${languageId} target engineering adapter is an explicit capability gap.`,
      );
    },
    locatePatch() {
      return unsupportedEngineering(
        "TARGET_PATCH_LOCATOR_CAPABILITY_UNAVAILABLE",
        "patch-locator",
        languageId,
        `The ${languageId} target engineering adapter is an explicit capability gap.`,
      );
    },
    locatePatchFromContext() {
      return unsupportedEngineering(
        "TARGET_PATCH_LOCATOR_CAPABILITY_UNAVAILABLE",
        "patch-locator",
        languageId,
        `The ${languageId} target engineering adapter is an explicit capability gap.`,
      );
    },
  };
}

interface CodeRange {
  declarationStart: number;
  openingBrace: number;
  end: number;
  declaration: string;
}

interface SourceFile {
  path: string;
  content: string;
}

interface TargetContextSyntax {
  findTargetRange(source: string, target: ModuleTarget): CodeRange;
  findContainingType(source: string, offset: number): CodeRange | null;
  extractImports(source: string): string[];
  findNamespace(source: string): string | undefined;
  extractTypeName(declaration: string): string | undefined;
  extractFields(typeSource: string, ownerKind: "type" | "module"): string[];
  extractConstructor(typeSource: string, typeName: string, ownerKind: "type" | "module"): string | undefined;
  extractRelatedMembers(
    typeSource: string,
    targetName: string,
    typeName: string,
    ownerKind: "type" | "module",
  ): string[];
  extractConstraints(source: string, scopeStart: number, scopeEnd: number): string[];
  collectDependencyNames(
    target: ModuleTarget,
    fields: string[],
    constructor: string | undefined,
    typeName: string,
  ): string[];
  buildDependencies(
    target: ModuleTarget,
    fields: string[],
    constructor: string | undefined,
    names: string[],
    definitions: RelatedTypeContext[],
    method: string,
  ): TargetDependencyContext[];
  resolveRelatedTypes(
    files: SourceFile[],
    targetPath: string,
    names: string[],
    maxTypes: number,
    signal: AbortSignal | undefined,
  ): RelatedTypeContext[];
  findCallers(
    files: SourceFile[],
    targetPath: string,
    targetName: string,
    maxCallers: number,
    signal: AbortSignal | undefined,
  ): CallerContext[];
}

export function collectTargetContext(
  options: ContextCollectorOptions,
): TargetModuleContext {
  const result = collectTargetContextSnapshot(options);
  if (result.status === "unsupported") throw new TargetEngineeringUnsupportedError(result.reason);
  return result.value.context;
}

export function collectTargetContextSnapshot(
  options: ContextCollectorOptions,
): TargetEngineeringResult<TargetContextSnapshot> {
  const registry = options.adapterRegistry ?? createDefaultTargetEngineeringAdapterRegistry();
  const languageId = canonicalTargetLanguageId(options.target.language);
  const adapter = registry.adapterFor(languageId);
  if (!adapter) {
    return unsupportedEngineering(
      "TARGET_ENGINEERING_ADAPTER_UNAVAILABLE",
      "context",
      languageId,
      `No target engineering adapter is registered for ${options.target.language}.`,
    );
  }
  if (
    adapter.descriptor.context.status !== "supported" ||
    !adapter.descriptor.context.targetKinds.includes(options.target.kind)
  ) {
    return unsupportedEngineering(
      "TARGET_CONTEXT_CAPABILITY_UNAVAILABLE",
      "context",
      languageId,
      `Adapter ${adapter.descriptor.id} does not provide ${options.target.kind} target context collection for ${options.target.language}.`,
    );
  }
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxCallers = options.maxCallers ?? DEFAULT_MAX_CALLERS;
  const maxRelatedTypes = options.maxRelatedTypes ?? DEFAULT_MAX_RELATED_TYPES;
  assertPositiveInteger(maxChars, "maxChars");
  assertNonNegativeInteger(maxCallers, "maxCallers");
  assertNonNegativeInteger(maxRelatedTypes, "maxRelatedTypes");
  return adapter.collectContext({
    projectRoot: options.projectRoot,
    target: options.target,
    maxChars,
    maxCallers,
    maxRelatedTypes,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export function locateTargetPatch(
  language: string,
  input: TargetPatchLocatorInput,
  registry: TargetEngineeringAdapterRegistry = createDefaultTargetEngineeringAdapterRegistry(),
): TargetEngineeringResult<TargetPatchLocation> {
  const languageId = canonicalTargetLanguageId(language);
  const adapter = registry.adapterFor(languageId);
  if (!adapter) {
    return unsupportedEngineering(
      "TARGET_ENGINEERING_ADAPTER_UNAVAILABLE",
      "patch-locator",
      languageId,
      `No target engineering adapter is registered for ${language}.`,
    );
  }
  if (
    adapter.descriptor.patchLocator.status !== "supported" ||
    !adapter.descriptor.patchLocator.targetKinds.includes(input.targetKind)
  ) {
    return unsupportedEngineering(
      "TARGET_PATCH_LOCATOR_CAPABILITY_UNAVAILABLE",
      "patch-locator",
      languageId,
      `Adapter ${adapter.descriptor.id} does not provide safe ${input.targetKind} patch location for ${language}.`,
    );
  }
  return adapter.locatePatch(input);
}

function collectContextWithSyntax(
  request: TargetEngineeringContextRequest,
  adapter: TargetEngineeringCapabilityDescriptor,
  syntax: TargetContextSyntax,
): TargetContextSnapshot {
  const {
    projectRoot,
    target,
    maxChars,
    maxCallers,
    maxRelatedTypes,
    signal,
  } = request;
  throwIfAborted(signal);

  const root = resolve(projectRoot);
  const targetPath = resolveInsideRoot(root, target.path);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new Error(`Target file does not exist in the project: ${target.path}`);
  }

  const content = normalizeNewlines(readFileSync(targetPath, "utf8"));
  const methodRange = syntax.findTargetRange(content, target);
  const containingType = syntax.findContainingType(content, methodRange.declarationStart);
  const typeRange = containingType ?? methodRange;
  const ownerKind = containingType ? "type" : "module";
  const namespace = syntax.findNamespace(content);
  const usings = syntax.extractImports(content);

  const method = content.slice(methodRange.declarationStart, methodRange.end + 1).trim();
  const containingTypeSource = content
    .slice(typeRange.declarationStart, typeRange.end + 1)
    .trim();
  const typeName = syntax.extractTypeName(typeRange.declaration) ?? target.name;
  const fields = syntax.extractFields(containingTypeSource, ownerKind);
  const constructor = syntax.extractConstructor(containingTypeSource, typeName, ownerKind);
  const relatedMembers = syntax.extractRelatedMembers(containingTypeSource, target.name, typeName, ownerKind);
  const constraints = syntax.extractConstraints(
    content,
    typeRange.declarationStart,
    typeRange.end,
  );

  throwIfAborted(signal);
  const files = listSourceFiles(
    root,
    DEFAULT_MAX_FILES_TO_SCAN,
    adapter.context.relatedFileExtensions,
  );
  const dependencyNames = syntax.collectDependencyNames(
    target,
    fields,
    constructor,
    typeName,
  );
  const definitions = syntax.resolveRelatedTypes(
    files,
    targetPath,
    dependencyNames,
    maxRelatedTypes,
    signal,
  ).map((definition) => ({
    ...definition,
    path: toProjectRelativePath(root, definition.path),
  }));
  const dependencies = syntax.buildDependencies(
    target,
    fields,
    constructor,
    dependencyNames,
    definitions,
    method,
  );
  const callers =
    target.kind === "function"
      ? syntax.findCallers(files, targetPath, target.name, maxCallers, signal).map((caller) => ({
          ...caller,
          path: toProjectRelativePath(root, caller.path),
        }))
      : [];

  const context: TargetModuleContext = {
    schemaVersion: "1.0",
    target,
    source: {
      namespace,
      usings,
      method,
      containingType: containingTypeSource,
      fields,
      constructor,
      relatedMembers,
    },
    dependencies,
    relatedTypes: definitions,
    callers,
    constraints,
    collection: {
      projectRoot: ".",
      targetFile: toProjectRelativePath(root, targetPath),
      maxChars,
      actualChars: 0,
      truncated: false,
      truncatedSections: [],
    },
  };

  applyBudget(context, maxChars);
  return {
    schemaVersion: "1.0",
    languageId: adapter.languageId,
    ownerKind,
    adapter: {
      id: adapter.id,
      version: adapter.version,
      languageId: adapter.languageId,
    },
    context,
  };
}

export function serializeTargetContext(context: TargetModuleContext): string {
  return JSON.stringify(context, null, 2);
}

function createBraceContextSyntax(
  configuration: BraceEngineeringConfiguration,
): TargetContextSyntax {
  return {
    findTargetRange: (source, target) => findBraceTargetRange(source, target, configuration),
    findContainingType: (source, offset) => findBraceContainingType(source, offset, configuration),
    extractImports: (source) => extractBraceImports(source, configuration),
    findNamespace: (source) => configuration.languageId === "typescript" ? undefined : findNamespace(source),
    extractTypeName,
    extractFields: (source, ownerKind) => ownerKind === "type" ? extractFields(source) : [],
    extractConstructor: (source, typeName, ownerKind) => ownerKind === "type"
      ? configuration.languageId === "typescript"
        ? extractTypescriptConstructor(source)
        : extractConstructor(source, typeName, configuration.masking)
      : undefined,
    extractRelatedMembers: (source, targetName, typeName, ownerKind) => ownerKind === "type"
      ? extractRelatedMembers(source, targetName, typeName)
      : [],
    extractConstraints,
    collectDependencyNames,
    buildDependencies,
    resolveRelatedTypes: (files, targetPath, names, maxTypes, signal) =>
      resolveRelatedTypes(files, targetPath, names, maxTypes, signal, configuration),
    findCallers,
  };
}

function pythonContextSyntax(): TargetContextSyntax {
  return {
    findTargetRange: findPythonTargetRange,
    findContainingType: findPythonContainingType,
    extractImports: extractPythonImports,
    findNamespace: () => undefined,
    extractTypeName: (declaration) => /^\s*class\s+([A-Za-z_]\w*)/.exec(declaration)?.[1],
    extractFields: (source, ownerKind) => ownerKind === "type" ? extractPythonFields(source) : [],
    extractConstructor: (source, _typeName, ownerKind) => ownerKind === "type"
      ? extractPythonFunction(source, "__init__")
      : undefined,
    extractRelatedMembers: (source, targetName, _typeName, ownerKind) => ownerKind === "type"
      ? extractPythonRelatedMembers(source, targetName)
      : [],
    extractConstraints: extractPythonConstraints,
    collectDependencyNames,
    buildDependencies: buildPythonDependencies,
    resolveRelatedTypes: resolvePythonRelatedTypes,
    findCallers,
  };
}

function findBraceTargetRange(
  source: string,
  target: ModuleTarget,
  configuration: BraceEngineeringConfiguration,
): CodeRange {
  const escapedName = escapeRegExp(target.name);
  const typeKeywords = configuration.languageId === "typescript"
    ? "class|interface|type|enum"
    : "class|record|struct|interface|enum";
  const pattern = target.kind === "function"
    ? configuration.languageId === "typescript"
      ? new RegExp(
          `(?:\\b(?:const|let|var)\\s+${escapedName}\\s*=\\s*(?:async\\s*)?\\(|\\b${escapedName}\\s*\\()`,
          "g",
        )
      : new RegExp(`\\b${escapedName}\\s*\\(`, "g")
    : new RegExp(`\\b(?:${typeKeywords})\\s+${escapedName}\\b`, "g");
  const candidates: CodeRange[] = [];

  for (const match of source.matchAll(pattern)) {
    const declarationStart = source.lastIndexOf("\n", match.index ?? 0) + 1;
    const openingBrace = declarationOpeningBrace(
      source,
      match.index ?? 0,
      configuration.masking,
    );
    if (openingBrace < 0) continue;
    const end = matchingBrace(source, openingBrace, configuration.masking);
    candidates.push({
      declarationStart,
      openingBrace,
      end,
      declaration: source.slice(declarationStart, openingBrace).trim(),
    });
  }

  if (candidates.length === 0) {
    throw new Error(`Target ${target.name} was not found in ${target.path}.`);
  }

  if (target.line !== undefined) {
    const targetOffset = lineStartOffset(source, target.line);
    const nearest = candidates
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.declarationStart - targetOffset) }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearest) return nearest.candidate;
  }

  return candidates[0];
}

function findPythonTargetRange(source: string, target: ModuleTarget): CodeRange {
  const pattern = target.kind === "function"
    ? new RegExp(`^[\\t ]*(?:async\\s+)?def\\s+${escapeRegExp(target.name)}\\s*\\(`, "gm")
    : new RegExp(`^[\\t ]*class\\s+${escapeRegExp(target.name)}\\b`, "gm");
  const candidates: CodeRange[] = [];
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const declarationStart = match.index;
    const lineEnd = source.indexOf("\n", declarationStart);
    const openingBrace = lineEnd < 0 ? source.length : lineEnd;
    candidates.push({
      declarationStart,
      openingBrace,
      end: pythonBlockEnd(source, declarationStart),
      declaration: source.slice(declarationStart, openingBrace).trim(),
    });
  }
  if (candidates.length === 0) throw new Error(`Target ${target.name} was not found in ${target.path}.`);
  if (target.line !== undefined) {
    const targetOffset = lineStartOffset(source, target.line);
    return candidates
      .map((candidate) => ({ candidate, distance: Math.abs(candidate.declarationStart - targetOffset) }))
      .sort((left, right) => left.distance - right.distance)[0]?.candidate ?? candidates[0];
  }
  return candidates[0];
}

function findBraceContainingType(
  source: string,
  offset: number,
  configuration: BraceEngineeringConfiguration,
): CodeRange | null {
  const typePattern = configuration.languageId === "typescript"
    ? /\b(class|interface|enum)\s+([A-Za-z_]\w*)\b/g
    : /\b(class|record|struct|interface|enum)\s+([A-Za-z_]\w*)\b/g;
  const candidates: CodeRange[] = [];
  for (const match of source.matchAll(typePattern)) {
    const declarationStart = source.lastIndexOf("\n", match.index ?? 0) + 1;
    const openingBrace = declarationOpeningBrace(source, match.index ?? 0, configuration.masking);
    if (openingBrace < 0 || openingBrace > offset) continue;
    const end = matchingBrace(source, openingBrace, configuration.masking);
    if (offset <= end) {
      candidates.push({
        declarationStart,
        openingBrace,
        end,
        declaration: source.slice(declarationStart, openingBrace).trim(),
      });
    }
  }
  return candidates.sort((left, right) => right.openingBrace - left.openingBrace)[0] ?? null;
}

function findPythonContainingType(source: string, offset: number): CodeRange | null {
  const candidates: CodeRange[] = [];
  for (const match of source.matchAll(/^[\t ]*class\s+[A-Za-z_]\w*\b/gm)) {
    if (match.index === undefined || match.index > offset) continue;
    const end = pythonBlockEnd(source, match.index);
    if (offset > end) continue;
    const lineEnd = source.indexOf("\n", match.index);
    candidates.push({
      declarationStart: match.index,
      openingBrace: lineEnd < 0 ? source.length : lineEnd,
      end,
      declaration: source.slice(match.index, lineEnd < 0 ? source.length : lineEnd).trim(),
    });
  }
  return candidates.sort((left, right) => right.declarationStart - left.declarationStart)[0] ?? null;
}

function pythonBlockEnd(source: string, start: number): number {
  const masked = maskPythonSyntax(source);
  const startLineEnd = source.indexOf("\n", start);
  const baseIndent = source.slice(start, startLineEnd < 0 ? source.length : startLineEnd).match(/^\s*/)?.[0].length ?? 0;
  let end = source.length;
  for (let index = startLineEnd < 0 ? source.length : startLineEnd + 1; index < source.length;) {
    const next = source.indexOf("\n", index);
    const lineEnd = next < 0 ? source.length : next;
    const maskedLine = masked.slice(index, lineEnd);
    const originalLine = source.slice(index, lineEnd);
    if (maskedLine.trim() && (originalLine.match(/^\s*/)?.[0].length ?? 0) <= baseIndent) {
      end = index - 1;
      break;
    }
    index = next < 0 ? source.length : next + 1;
  }
  return end;
}

function maskPythonSyntax(source: string): string {
  const output = source.split("");
  const mask = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
    }
  };
  for (let index = 0; index < source.length;) {
    const current = source[index] ?? "";
    if (current === "#") {
      const end = source.indexOf("\n", index + 1);
      const stop = end === -1 ? source.length : end;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (source.startsWith('"""', index) || source.startsWith("'''", index)) {
      const delimiter = source.slice(index, index + 3);
      const end = source.indexOf(delimiter, index + 3);
      const stop = end === -1 ? source.length : end + 3;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (current === '"' || current === "'") {
      const quote = current;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === quote) { cursor += 1; break; }
        else cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function patchLocatorInputFromContext(
  input: TargetEngineeringPatchContextV2,
  configuration: BraceEngineeringConfiguration,
): TargetPatchLocatorInput {
  const declaration = input.declaration.content?.trimStart() ?? "";
  const declarationIsType = configuration.languageId === "typescript"
    ? /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\b/.test(declaration)
    : /^(?:(?:public|private|protected|internal|abstract|sealed|final|static|partial)\s+)*(?:class|record|struct|interface|enum)\b/.test(declaration);
  return {
    source: input.source,
    targetLine: contextDeclarationStartLine(input),
    targetKind: declarationIsType || nativeEntityKindIsType(input.target.kind)
      ? "class"
      : "function",
    targetName: input.target.name,
  };
}

function pythonPatchLocatorInputFromContext(
  input: TargetEngineeringPatchContextV2,
): TargetPatchLocatorInput {
  const declaration = input.declaration.content?.trimStart() ?? "";
  return {
    source: input.source,
    targetLine: contextDeclarationStartLine(input),
    targetKind: /^class\b/.test(declaration) || nativeEntityKindIsType(input.target.kind)
      ? "class"
      : "function",
    targetName: input.target.name,
  };
}

function contextDeclarationStartLine(input: TargetEngineeringPatchContextV2): number {
  const value = input.declaration.attributes.startLine;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  const declaration = input.declaration.content;
  if (declaration) {
    const offset = input.source.indexOf(declaration);
    if (offset >= 0) return input.source.slice(0, offset).split("\n").length;
  }
  throw new Error(
    `Target declaration fact ${input.declaration.id} must provide a positive startLine or exact declaration content.`,
  );
}

function nativeEntityKindIsType(kind: string): boolean {
  return /^(?:class|record|struct|interface|enum|type|trait|protocol)$/i.test(kind.trim());
}

function locateBracePatch(
  input: TargetPatchLocatorInput,
  configuration: BraceEngineeringConfiguration,
): TargetEngineeringResult<TargetPatchLocation> {
  const source = normalizeNewlines(input.source);
  const lines = source.split("\n");
  const startLine = locateDeclarationLine(lines, input, (line) =>
    braceDeclarationMatches(line, input.targetKind, input.targetName, configuration));
  const lineOffsets = sourceLineOffsets(source);
  const declarationOffset = lineOffsets[startLine] ?? 0;
  const openingBrace = declarationOpeningBrace(source, declarationOffset, configuration.masking);
  let endLine: number;
  if (openingBrace < 0) {
    const semicolon = expressionDeclarationSemicolon(source, declarationOffset, configuration.masking);
    if (semicolon === undefined || input.targetKind === "class") {
      throw new Error("Cannot build a safe patch because the target declaration has no isolatable body.");
    }
    endLine = lineIndexAtOffset(lineOffsets, semicolon);
  } else {
    const closingBrace = matchingBrace(source, openingBrace, configuration.masking);
    endLine = lineIndexAtOffset(lineOffsets, closingBrace);
    assertBracePatchBoundary(
      source,
      lines,
      startLine,
      endLine,
      openingBrace,
      configuration,
      input.targetKind,
    );
  }
  return {
    status: "supported",
    value: {
      startLine,
      endLine,
      declarationIndentation: lines[startLine]?.match(/^\s*/)?.[0] ?? "",
    },
  };
}

function locatePythonPatch(
  input: TargetPatchLocatorInput,
): TargetEngineeringResult<TargetPatchLocation> {
  const source = normalizeNewlines(input.source);
  const lines = source.split("\n");
  const startLine = locateDeclarationLine(lines, input, (line) =>
    pythonDeclarationMatches(line, input.targetKind, input.targetName));
  const offsets = sourceLineOffsets(source);
  const endOffset = pythonBlockEnd(source, offsets[startLine] ?? 0);
  const endLine = lineIndexAtOffset(offsets, Math.max(offsets[startLine] ?? 0, endOffset));
  if (endLine < startLine) {
    throw new Error("Cannot build a safe patch because the Python target suite is incomplete.");
  }
  return {
    status: "supported",
    value: {
      startLine,
      endLine,
      declarationIndentation: lines[startLine]?.match(/^\s*/)?.[0] ?? "",
    },
  };
}

function locateDeclarationLine(
  lines: string[],
  input: TargetPatchLocatorInput,
  matches: (line: string) => boolean,
): number {
  const requested = Math.max(0, input.targetLine - 1);
  if (requested >= lines.length) {
    throw new Error("The target line is outside the target file before a safe patch can be built.");
  }
  if (matches(lines[requested] ?? "")) return requested;
  const limit = Math.min(lines.length, requested + 33);
  for (let index = requested + 1; index < limit; index += 1) {
    if (matches(lines[index] ?? "")) return index;
    if (!declarationPrefixTrivia(lines[index] ?? "")) break;
  }
  throw new Error(
    input.targetKind === "class"
      ? "The target line must point at a class declaration before a safe patch can be built."
      : "The target line must point at a method declaration or top-level function before a safe patch can be built.",
  );
}

function braceDeclarationMatches(
  line: string,
  kind: "class" | "function",
  targetName: string | undefined,
  configuration: BraceEngineeringConfiguration,
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const name = targetName ? escapeRegExp(targetName) : "[A-Za-z_$][\\w$]*";
  if (kind === "class") {
    const keywords = configuration.languageId === "typescript"
      ? "class|interface|type|enum"
      : "class|record|struct|interface|enum";
    return new RegExp(`^(?:(?:public|private|protected|internal|abstract|sealed|final|static|export|default|partial)\\s+)*(?:${keywords})\\s+${name}\\b`).test(trimmed);
  }
  if (/^(?:if|for|foreach|while|switch|catch|using|return|new|throw)\b/.test(trimmed)) return false;
  if (configuration.languageId === "typescript") {
    if (new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${name}\\s*(?:<[^>]+>)?\\s*\\(`).test(trimmed)) return true;
    if (new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*=`).test(trimmed)) return true;
  }
  return new RegExp(`\\b${name}\\s*(?:<[^>]+>)?\\s*\\(`).test(trimmed);
}

function pythonDeclarationMatches(
  line: string,
  kind: "class" | "function",
  targetName: string | undefined,
): boolean {
  const name = targetName ? escapeRegExp(targetName) : "[A-Za-z_]\\w*";
  return kind === "class"
    ? new RegExp(`^\\s*class\\s+${name}\\b`).test(line)
    : new RegExp(`^\\s*(?:async\\s+)?def\\s+${name}\\s*\\(`).test(line);
}

function declarationPrefixTrivia(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" ||
    trimmed === "*/" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("[");
}

function expressionDeclarationSemicolon(
  source: string,
  start: number,
  profile: BraceEngineeringConfiguration["masking"],
): number | undefined {
  const masked = maskBraceSyntax(source, profile);
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < masked.length; index += 1) {
    const character = masked[index] ?? "";
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === ";" && parentheses === 0 && brackets === 0) return index;
  }
  return undefined;
}

function assertBracePatchBoundary(
  source: string,
  lines: string[],
  startLine: number,
  endLine: number,
  openingBrace: number,
  configuration: BraceEngineeringConfiguration,
  targetKind: "class" | "function",
): void {
  const masked = maskBraceSyntax(source, configuration.masking);
  const offsets = sourceLineOffsets(source);
  const declarationIndentation = lines[startLine]?.match(/^\s*/)?.[0].length ?? 0;
  let depth = 0;
  let cursor = openingBrace;
  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const lineStart = Math.max(openingBrace, offsets[lineIndex] ?? openingBrace);
    const lineEnd = offsets[lineIndex + 1] ?? masked.length;
    for (; cursor < lineStart; cursor += 1) {
      if (masked[cursor] === "{") depth += 1;
      else if (masked[cursor] === "}") depth -= 1;
    }
    if (lineIndex > startLine && depth === 1) {
      const line = lines[lineIndex] ?? "";
      const indentation = line.match(/^\s*/)?.[0].length ?? 0;
      if (
        indentation <= declarationIndentation &&
        likelySiblingDeclaration(line, targetKind, configuration)
      ) {
        throw new Error(
          "Cannot build a safe patch because a sibling declaration appears before the target declaration closes.",
        );
      }
    }
    for (; cursor < lineEnd; cursor += 1) {
      if (masked[cursor] === "{") depth += 1;
      else if (masked[cursor] === "}") depth -= 1;
    }
  }
  const closingIndentation = lines[endLine]?.match(/^\s*/)?.[0].length ?? 0;
  if (closingIndentation < declarationIndentation) {
    throw new Error(
      "Cannot build a safe patch because the closing brace is outside the target declaration indentation.",
    );
  }
}

function likelySiblingDeclaration(
  line: string,
  targetKind: "class" | "function",
  configuration: BraceEngineeringConfiguration,
): boolean {
  if (braceDeclarationMatches(line, targetKind, undefined, configuration)) return true;
  if (targetKind === "class") return false;
  const trimmed = line.trim();
  if (!trimmed || /^(?:else|do|try|finally|if|for|while|switch|catch|return|throw|new)\b/.test(trimmed)) return false;
  return /^(?:(?:public|private|protected|internal|static|readonly|final|const|volatile|abstract|virtual|override|sealed|async|partial|export)\s+)*(?:[A-Za-z_$][\w$<>,.?\[\]]*\s+)+[A-Za-z_$][\w$]*(?:\s*[=;{])/.test(trimmed);
}

function sourceLineOffsets(source: string): number[] {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function lineIndexAtOffset(offsets: number[], target: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? 0) <= target) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

function declarationOpeningBrace(
  source: string,
  declarationStart: number,
  profile: BraceEngineeringConfiguration["masking"],
): number {
  const masked = maskBraceSyntax(source, profile);
  let parentheses = 0;
  let brackets = 0;
  for (let index = declarationStart; index < masked.length; index += 1) {
    const character = masked[index] ?? "";
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    if (parentheses !== 0 || brackets !== 0) continue;
    if (character === ";") return -1;
    if (character !== "{") continue;
    const closing = matchingBraceInMasked(masked, index);
    if (closing === undefined) return -1;
    const next = nextNonWhitespace(masked, closing + 1);
    if (next !== undefined && masked[next] === "{") {
      index = closing;
      continue;
    }
    return index;
  }
  return -1;
}

function matchingBrace(
  source: string,
  openingBrace: number,
  profile: BraceEngineeringConfiguration["masking"] = "typescript",
): number {
  const masked = maskBraceSyntax(source, profile);
  const closing = matchingBraceInMasked(masked, openingBrace);
  if (closing !== undefined) return closing;
  throw new Error("Target context contains an unmatched brace.");
}

function matchingBraceInMasked(masked: string, openingBrace: number): number | undefined {
  let depth = 0;
  for (let index = openingBrace; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function maskBraceSyntax(
  source: string,
  profile: BraceEngineeringConfiguration["masking"],
): string {
  const output = source.split("");
  const mask = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
    }
  };
  for (let index = 0; index < source.length;) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (current === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      const stop = end === -1 ? source.length : end;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      mask(index, stop);
      index = stop;
      continue;
    }
    const csharpVerbatimPrefixLength = profile === "csharp"
      ? source.startsWith('$@"', index) || source.startsWith('@$"', index)
        ? 3
        : source.startsWith('@"', index)
          ? 2
          : 0
      : 0;
    if (csharpVerbatimPrefixLength > 0) {
      let cursor = index + csharpVerbatimPrefixLength;
      while (cursor < source.length) {
        if (source[cursor] === '"' && source[cursor + 1] === '"') cursor += 2;
        else if (source[cursor] === '"') { cursor += 1; break; }
        else cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    if (profile === "typescript" && current === "`") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === "`") { cursor += 1; break; }
        else cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    if (source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      const stop = end === -1 ? source.length : end + 3;
      mask(index, stop);
      index = stop;
      continue;
    }
    if (current === '"' || current === "'") {
      const quote = current;
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === quote) { cursor += 1; break; }
        else cursor += 1;
      }
      mask(index, cursor);
      index = cursor;
      continue;
    }
    index += 1;
  }
  return output.join("");
}

function nextNonWhitespace(value: string, start: number): number | undefined {
  for (let index = start; index < value.length; index += 1) {
    if (!/\s/.test(value[index] ?? "")) return index;
  }
  return undefined;
}

function extractFields(typeSource: string): string[] {
  const fields: string[] = [];
  for (const line of typeSource.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("///")) continue;
    if (
      /^\s*(?:(?:public|private|protected|internal|static|readonly|volatile|const|new|unsafe|final|transient|synchronized)\s+)+[A-Za-z_]\w*(?:\s*<[^;=()]+>)?(?:\[\])?\s+[A-Za-z_]\w*\s*(?:=.*)?;\s*$/.test(
        line,
      )
    ) {
      fields.push(trimmed);
    }
  }
  return fields;
}

function extractConstructor(
  typeSource: string,
  typeName: string,
  profile: BraceEngineeringConfiguration["masking"] = "typescript",
): string | undefined {
  const pattern = new RegExp(`(?:public|private|protected|internal|static|\\s)+${escapeRegExp(typeName)}\\s*\\([^)]*\\)`);
  const match = pattern.exec(typeSource);
  if (!match) return undefined;
  const openingBrace = typeSource.indexOf("{", match.index + match[0].length);
  if (openingBrace < 0) return match[0].trim();
  const end = matchingBrace(typeSource, openingBrace, profile);
  return typeSource.slice(match.index, end + 1).trim();
}

function extractRelatedMembers(typeSource: string, targetName: string, typeName: string): string[] {
  const members: string[] = [];
  for (const line of typeSource.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("///")) continue;
    if (!trimmed.includes("(") || trimmed.startsWith("if ") || trimmed.startsWith("for ")) continue;
    if (
      targetName &&
      new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\(`).test(trimmed)
    ) continue;
    if (
      typeName &&
      new RegExp(`\\b${escapeRegExp(typeName)}\\s*\\(`).test(trimmed)
    ) continue;
    if (!/\b(?:public|private|protected|internal)\b/.test(trimmed) && !typeSource.includes("interface ")) continue;
    members.push(trimmed.replace(/\s*\{\s*$/, "").trim());
  }
  return [...new Set(members)];
}

function extractBraceImports(
  source: string,
  configuration: BraceEngineeringConfiguration,
): string[] {
  if (configuration.languageId === "typescript") {
    return source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^import\s+(?:type\s+)?/.test(line));
  }
  const prefix = configuration.languageId === "csharp" ? "using" : "import";
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => new RegExp(`^${prefix}\\s+(?:static\\s+)?[^;]+;`).test(line));
}

function extractTypescriptConstructor(typeSource: string): string | undefined {
  const match = /\bconstructor\s*\([^)]*\)/.exec(typeSource);
  if (!match) return undefined;
  const openingBrace = declarationOpeningBrace(typeSource, match.index, "typescript");
  if (openingBrace < 0) return match[0];
  return typeSource.slice(match.index, matchingBrace(typeSource, openingBrace, "typescript") + 1).trim();
}

function extractPythonImports(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:from\s+\S+\s+import\s+|import\s+)/.test(line));
}

function extractPythonFields(typeSource: string): string[] {
  const fields: string[] = [];
  const lines = typeSource.split("\n");
  const classIndent = lines[0]?.match(/^\s*/)?.[0].length ?? 0;
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || /^def\s+|^async\s+def\s+/.test(trimmed)) continue;
    const indentation = line.match(/^\s*/)?.[0].length ?? 0;
    if (indentation <= classIndent) continue;
    if (/^(?:self\.)?[A-Za-z_]\w*\s*(?::[^=]+)?=/.test(trimmed)) fields.push(trimmed);
  }
  return [...new Set(fields)];
}

function extractPythonFunction(source: string, name: string): string | undefined {
  const match = new RegExp(`^[\\t ]*(?:async\\s+)?def\\s+${escapeRegExp(name)}\\s*\\(`, "m").exec(source);
  if (!match || match.index === undefined) return undefined;
  return source.slice(match.index, pythonBlockEnd(source, match.index) + 1).trim();
}

function extractPythonRelatedMembers(source: string, targetName: string): string[] {
  const members: string[] = [];
  for (const match of source.matchAll(/^[\t ]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\([^\n]*$/gm)) {
    if (!match[1] || match[1] === targetName || match[1] === "__init__") continue;
    members.push(match[0].trim().replace(/:\s*$/, ""));
  }
  return [...new Set(members)];
}

function extractConstraints(
  source: string,
  typeStart: number,
  typeEnd: number,
): string[] {
  const lines = source.split("\n");
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length - 1;
  const typeStartLine = lineAt(typeStart);
  const typeEndLine = lineAt(typeEnd);
  return lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(
      ({ line, index }) =>
        index >= typeStartLine &&
        index <= typeEndLine &&
        /\bREQ\s*:/i.test(line),
    )
    .map(({ line }) => line.replace(/^\/\/\s*/, "").replace(/^\/\/\/\s*/, "").trim())
    .filter(Boolean);
}

function extractPythonConstraints(
  source: string,
  scopeStart: number,
  scopeEnd: number,
): string[] {
  return source
    .slice(scopeStart, scopeEnd + 1)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^#.*\bREQ\s*:/i.test(line))
    .map((line) => line.replace(/^#\s*/, "").trim());
}

function findNamespace(source: string): string | undefined {
  return /^\s*(?:namespace|package)\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*(?:;|\{)/m.exec(source)?.[1];
}

function collectDependencyNames(
  target: ModuleTarget,
  fields: string[],
  constructor: string | undefined,
  typeName: string,
): string[] {
  const text = [target.signature, ...fields, constructor ?? ""].join("\n");
  return [
    ...new Set(
      [...text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)]
        .map((match) => match[1])
        .filter((name): name is string => Boolean(name))
        .filter((name) => name !== typeName && name !== target.name && !BUILT_IN_TYPES.has(name)),
    ),
  ];
}

function buildDependencies(
  target: ModuleTarget,
  fields: string[],
  constructor: string | undefined,
  names: string[],
  definitions: RelatedTypeContext[],
  method: string,
): TargetDependencyContext[] {
  const dependencies: TargetDependencyContext[] = [];
  const add = (name: string, kind: TargetDependencyContext["kind"], declaration: string) => {
    if (dependencies.some((dependency) => dependency.name === name && dependency.kind === kind)) return;
    const definition = definitions.find((item) => item.name === name);
    dependencies.push({
      name,
      kind,
      declaration,
      path: definition?.path,
      memberSignatures: definition?.source
        ? extractRelatedMembers(definition.source, "", name).slice(0, 12)
        : undefined,
    });
  };

  for (const field of fields) {
    const fieldName = field.match(/([A-Za-z_]\w*)\s*(?:=.*)?;\s*$/)?.[1];
    const fieldType = field.match(/\b([A-Za-z_]\w*(?:\s*<[^;=()]+>)?(?:\[\])?)\s+[A-Za-z_]\w*\s*(?:=.*)?;\s*$/)?.[1];
    const fieldTypes = fieldType
      ? [...fieldType.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((match) => match[1]).filter(Boolean)
      : [];
    const directFieldType = fieldTypes.find((name) => names.includes(name));
    if (directFieldType) {
      add(directFieldType, "field", field);
    } else if (fieldName && method.includes(fieldName)) {
      add(fieldName, "invocation", field);
    }
  }

  if (constructor) {
    for (const parameter of constructor.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s+([A-Za-z_]\w*)\b/g)) {
      const name = parameter[1];
      if (name && names.includes(name) && !BUILT_IN_TYPES.has(name)) add(name, "constructor", constructor);
    }
  }

  for (const name of names) {
    if (!dependencies.some((dependency) => dependency.name === name)) {
      add(name, target.signature.includes(name) ? "signature" : "type", target.signature);
    }
  }
  return dependencies;
}

function buildPythonDependencies(
  target: ModuleTarget,
  fields: string[],
  constructor: string | undefined,
  names: string[],
  definitions: RelatedTypeContext[],
  method: string,
): TargetDependencyContext[] {
  return names.map((name) => {
    const definition = definitions.find((item) => item.name === name);
    const field = fields.find((item) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(item));
    return {
      name,
      kind: target.signature.includes(name)
        ? "signature"
        : constructor?.includes(name)
          ? "constructor"
          : field
            ? "field"
            : method.includes(name)
              ? "invocation"
              : "type",
      declaration: field ?? constructor ?? target.signature,
      path: definition?.path,
      memberSignatures: definition?.source
        ? extractPythonRelatedMembers(definition.source, "").slice(0, 12)
        : undefined,
    };
  });
}

function resolveRelatedTypes(
  files: SourceFile[],
  targetPath: string,
  names: string[],
  maxTypes: number,
  signal: AbortSignal | undefined,
  configuration: BraceEngineeringConfiguration,
): RelatedTypeContext[] {
  const result: RelatedTypeContext[] = [];
  for (const name of names) {
    throwIfAborted(signal);
    if (result.length >= maxTypes) break;
    for (const file of files) {
      if (file.path === targetPath) continue;
      const typeKeywords = configuration.languageId === "typescript"
        ? "class|interface|enum|type"
        : "class|record|struct|interface|enum";
      const declarationPattern = new RegExp(`\\b(${typeKeywords})\\s+${escapeRegExp(name)}\\b`);
      const match = declarationPattern.exec(file.content);
      if (!match) continue;
      const declarationStart = file.content.lastIndexOf("\n", match.index) + 1;
      const openingBrace = declarationOpeningBrace(file.content, match.index, configuration.masking);
      const end = openingBrace >= 0
        ? matchingBrace(file.content, openingBrace, configuration.masking)
        : match.index + match[0].length;
      result.push({
        name,
        kind: normalizeTypeKind(match[1]),
        path: file.path,
        declaration: file.content.slice(declarationStart, openingBrace >= 0 ? openingBrace : end).trim(),
        source: truncateText(file.content.slice(declarationStart, end + 1).trim(), 4_000),
      });
      break;
    }
  }
  return result;
}

function resolvePythonRelatedTypes(
  files: SourceFile[],
  targetPath: string,
  names: string[],
  maxTypes: number,
  signal: AbortSignal | undefined,
): RelatedTypeContext[] {
  const result: RelatedTypeContext[] = [];
  for (const name of names) {
    throwIfAborted(signal);
    if (result.length >= maxTypes) break;
    for (const file of files) {
      if (file.path === targetPath) continue;
      const match = new RegExp(`^[\\t ]*class\\s+${escapeRegExp(name)}\\b`, "m").exec(file.content);
      if (!match || match.index === undefined) continue;
      const end = pythonBlockEnd(file.content, match.index);
      const declarationEnd = file.content.indexOf("\n", match.index);
      result.push({
        name,
        kind: "class",
        path: file.path,
        declaration: file.content.slice(
          match.index,
          declarationEnd < 0 ? file.content.length : declarationEnd,
        ).trim(),
        source: truncateText(file.content.slice(match.index, end + 1).trim(), 4_000),
      });
      break;
    }
  }
  return result;
}

function findCallers(
  files: SourceFile[],
  targetPath: string,
  targetName: string,
  maxCallers: number,
  signal: AbortSignal | undefined,
): CallerContext[] {
  const callers: CallerContext[] = [];
  const callPattern = new RegExp(`\\b${escapeRegExp(targetName)}\\s*\\(`);
  for (const file of files) {
    throwIfAborted(signal);
    if (file.path === targetPath) continue;
    const lines = file.content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!callPattern.test(lines[index])) continue;
      callers.push({
        path: file.path,
        line: index + 1,
        excerpt: truncateText(lines.slice(Math.max(0, index - 1), index + 2).join("\n").trim(), 500),
      });
      if (callers.length >= maxCallers) return callers;
    }
  }
  return callers;
}

function listSourceFiles(
  root: string,
  maxFiles: number,
  extensions: readonly string[],
): SourceFile[] {
  const files: SourceFile[] = [];
  const normalizedExtensions = new Set(extensions.map((extension) => extension.toLowerCase()));
  const visit = (directory: string): void => {
    if (files.length >= maxFiles) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (entry.name === ".git" || entry.name === "bin" || entry.name === "obj" || entry.name === "node_modules") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (
        entry.isFile() &&
        [...normalizedExtensions].some((extension) => path.toLowerCase().endsWith(extension))
      ) {
        files.push({ path, content: normalizeNewlines(readFileSync(path, "utf8")) });
      }
    }
  };
  visit(root);
  return files;
}

function applyBudget(context: TargetModuleContext, maxChars: number): void {
  const sections: Array<{ name: string; get: () => string; set: (value: string) => void }> = [
    {
      name: "source.containingType",
      get: () => context.source.containingType,
      set: (value) => {
        context.source.containingType = value;
      },
    },
    {
      name: "source.method",
      get: () => context.source.method,
      set: (value) => {
        context.source.method = value;
      },
    },
  ];
  for (let index = 0; index < context.relatedTypes.length; index += 1) {
    sections.push({
      name: `relatedTypes[${index}].source`,
      get: () => context.relatedTypes[index].source,
      set: (value) => {
        context.relatedTypes[index].source = value;
      },
    });
  }
  for (let index = 0; index < context.callers.length; index += 1) {
    sections.push({
      name: `callers[${index}].excerpt`,
      get: () => context.callers[index].excerpt,
      set: (value) => {
        context.callers[index].excerpt = value;
      },
    });
  }

  let serializedLength = JSON.stringify(context).length;
  let sectionIndex = 0;
  while (serializedLength > maxChars && sectionIndex < sections.length) {
    const section = sections[sectionIndex];
    const current = section.get();
    const nextLength = Math.max(160, Math.floor(current.length * 0.65));
    if (nextLength < current.length) {
      section.set(truncateText(current, nextLength));
      context.collection.truncated = true;
      if (!context.collection.truncatedSections.includes(section.name)) {
        context.collection.truncatedSections.push(section.name);
      }
    }
    serializedLength = JSON.stringify(context).length;
    if (nextLength >= current.length) sectionIndex += 1;
  }

  while (serializedLength > maxChars && context.callers.length > 0) {
    context.callers.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("callers");
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.relatedTypes.length > 0) {
    context.relatedTypes.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("relatedTypes");
    serializedLength = JSON.stringify(context).length;
  }

  while (serializedLength > maxChars && context.dependencies.length > 0) {
    context.dependencies.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("dependencies");
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.source.relatedMembers.length > 0) {
    context.source.relatedMembers.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("source.relatedMembers");
    serializedLength = JSON.stringify(context).length;
  }
  while (serializedLength > maxChars && context.source.fields.length > 0) {
    context.source.fields.pop();
    context.collection.truncated = true;
    context.collection.truncatedSections.push("source.fields");
    serializedLength = JSON.stringify(context).length;
  }

  context.collection.actualChars = serializedLength;
}

function resolveInsideRoot(root: string, path: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const segments = normalizedPath.split("/");
  if (isAbsolute(path) || segments.includes("..")) {
    throw new Error(`Target path must stay inside the project root: ${path}`);
  }

  const directPath = resolve(root, normalizedPath);
  if (isInsideRoot(root, directPath) && existsSync(directPath)) {
    return directPath;
  }

  // VS Code can report a workspace-relative path prefixed by the project
  // folder (for example, `repo/.../forexplore-csharp-workspace/src/...`).
  // Accept that form only by stripping the exact configured root directory.
  const rootNameIndex = segments.indexOf(basename(root));
  if (rootNameIndex >= 0 && rootNameIndex < segments.length - 1) {
    const projectRelativePath = segments.slice(rootNameIndex + 1).join("/");
    const resolved = resolve(root, projectRelativePath);
    if (isInsideRoot(root, resolved)) return resolved;
  }

  if (!isInsideRoot(root, directPath)) {
    throw new Error(`Target path must stay inside the project root: ${path}`);
  }
  return directPath;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return Boolean(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}

function toProjectRelativePath(root: string, path: string): string {
  const value = relative(root, path).replace(/\\/g, "/");
  return value || ".";
}

function extractTypeName(declaration: string): string | undefined {
  return /\b(?:class|record|struct|interface|enum|type)\s+([A-Za-z_]\w*)/.exec(declaration)?.[1];
}

function normalizeTypeKind(kind: string): RelatedTypeContext["kind"] {
  if (kind === "class" || kind === "record" || kind === "struct" || kind === "interface" || kind === "enum") return kind;
  return "unknown";
}

function lineStartOffset(source: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  for (let index = 1; index < line; index += 1) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return source.length;
    offset = next + 1;
  }
  return offset;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const marker = "\n... [truncated] ...\n";
  const available = Math.max(0, maxLength - marker.length);
  const head = Math.ceil(available * 0.7);
  return `${value.slice(0, head)}${marker}${value.slice(-Math.max(0, available - head))}`;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function canonicalTargetLanguageId(value: string): string {
  return normalizeLanguageId(value);
}

function unsupportedEngineering<T>(
  code: TargetEngineeringUnsupportedReason["code"],
  stage: TargetEngineeringStage,
  languageId: string,
  detail: string,
): TargetEngineeringResult<T> {
  return {
    status: "unsupported",
    reason: {
      code,
      stage,
      languageId: canonicalTargetLanguageId(languageId),
      detail,
      retryable: false,
    },
  };
}

function assertEngineeringDescriptor(
  descriptor: TargetEngineeringCapabilityDescriptor,
  canonicalLanguageId: string,
): void {
  if (!descriptor.id.trim()) throw new Error("Target engineering adapter id must not be empty.");
  if (!descriptor.version.trim()) throw new Error("Target engineering adapter version must not be empty.");
  if (descriptor.languageId !== canonicalLanguageId) {
    throw new Error(
      `Target engineering adapter languageId must be canonical: expected ${canonicalLanguageId}, received ${descriptor.languageId}.`,
    );
  }
  if (!descriptor.quality.failClosed) {
    throw new Error(`Target engineering adapter ${descriptor.id} must fail closed.`);
  }
  if (descriptor.quality.provesBehavioralCorrectness !== false) {
    throw new Error(`Target engineering adapter ${descriptor.id} cannot claim behavioral correctness.`);
  }
  if (descriptor.quality.limitations.length === 0) {
    throw new Error(`Target engineering adapter ${descriptor.id} must document its limitations.`);
  }
  if (
    descriptor.context.status === "supported" &&
    (descriptor.context.targetKinds.length === 0 ||
      descriptor.context.ownerKinds.length === 0 ||
      descriptor.context.relatedFileExtensions.length === 0)
  ) {
    throw new Error(`Target engineering adapter ${descriptor.id} has an incomplete context capability.`);
  }
  if (
    descriptor.patchLocator.status === "supported" &&
    descriptor.patchLocator.targetKinds.length === 0
  ) {
    throw new Error(`Target engineering adapter ${descriptor.id} has an incomplete patch locator capability.`);
  }
}

function cloneEngineeringDescriptor(
  descriptor: TargetEngineeringCapabilityDescriptor,
): TargetEngineeringCapabilityDescriptor {
  return {
    ...descriptor,
    context: {
      ...descriptor.context,
      targetKinds: [...descriptor.context.targetKinds],
      ownerKinds: [...descriptor.context.ownerKinds],
      relatedFileExtensions: [...descriptor.context.relatedFileExtensions],
    },
    patchLocator: {
      ...descriptor.patchLocator,
      targetKinds: [...descriptor.patchLocator.targetKinds],
    },
    quality: {
      ...descriptor.quality,
      limitations: [...descriptor.quality.limitations],
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}
