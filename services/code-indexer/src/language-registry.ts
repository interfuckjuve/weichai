import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
import Kotlin from '@tree-sitter-grammars/tree-sitter-kotlin';
import CSharp from 'tree-sitter-c-sharp';
import Go from 'tree-sitter-go';
import Java from 'tree-sitter-java';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import Rust from 'tree-sitter-rust';
import TypeScript from 'tree-sitter-typescript';
import type {
  LanguageCapabilityLevel,
  LanguageRegistration,
} from '@forexplore/contracts';

/**
 * The structural layer deliberately has its own identifiers instead of using
 * the retrieval `Language` union.  In particular, JavaScript is indexable
 * even though the legacy retrieval contract has no JavaScript member yet.
 */
export type TreeSitterLanguageId =
  | 'c'
  | 'cpp'
  | 'kotlin'
  | 'arkts'
  | 'csharp'
  | 'go'
  | 'java'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'typescript';

export type TreeSitterCapabilityLevel = Extract<LanguageCapabilityLevel, 'structural'>;

/**
 * The node bindings expose a grammar object, not merely its native language
 * pointer.  Passing the object to Parser#setLanguage preserves the node type
 * metadata used when Tree-sitter materializes syntax nodes.
 */
export interface TreeSitterGrammar {
  language: unknown;
  name: string;
  nodeTypeInfo: unknown[];
}

export interface TreeSitterLanguageRegistration {
  capabilityLevel: TreeSitterCapabilityLevel;
  fileExtensions: readonly string[];
  grammar: TreeSitterGrammar;
  /** Per-extension grammar override, used for TSX while retaining TypeScript's language id. */
  grammarsByExtension?: Readonly<Record<string, TreeSitterGrammar>>;
  languageId: TreeSitterLanguageId;
}

function normalizeExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

function extensionForPath(relativePath: string): string | undefined {
  const slash = Math.max(relativePath.lastIndexOf('/'), relativePath.lastIndexOf('\\'));
  const name = relativePath.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? undefined : name.slice(dot).toLowerCase();
}

/**
 * Registry ownership stays in the indexer: consumers can request a grammar
 * by a stable language id or a repository-relative path, but never pass a
 * parser or arbitrary native binding into the scan pipeline.
 */
export class LanguageRegistry {
  readonly #byExtension = new Map<string, TreeSitterLanguageRegistration>();
  readonly #byId = new Map<TreeSitterLanguageId, TreeSitterLanguageRegistration>();

  constructor(registrations: readonly TreeSitterLanguageRegistration[]) {
    for (const registration of registrations) this.register(registration);
  }

  get(languageId: TreeSitterLanguageId): TreeSitterLanguageRegistration | undefined {
    return this.#byId.get(languageId);
  }

  list(): TreeSitterLanguageRegistration[] {
    return [...this.#byId.values()].sort((left, right) =>
      left.languageId.localeCompare(right.languageId),
    );
  }

  /** Safe registry metadata for persistence/UI; native grammar objects stay local. */
  describe(): LanguageRegistration[] {
    return this.list().map((registration) => ({
      languageId: registration.languageId,
      displayName: displayNameFor(registration.languageId),
      fileExtensions: [...registration.fileExtensions],
      grammar: registration.grammar.name,
      capabilityLevel: registration.capabilityLevel,
    }));
  }

  register(registration: TreeSitterLanguageRegistration): void {
    if (!registration.languageId) throw new Error('Tree-sitter language registrations require a languageId.');
    if (!registration.grammar?.language) {
      throw new Error(`Tree-sitter language registration ${registration.languageId} has no grammar.`);
    }
    if (registration.fileExtensions.length === 0) {
      throw new Error(`Tree-sitter language registration ${registration.languageId} has no file extensions.`);
    }
    if (this.#byId.has(registration.languageId)) {
      throw new Error(`Tree-sitter language ${registration.languageId} is already registered.`);
    }

    for (const extension of registration.fileExtensions) {
      const normalized = normalizeExtension(extension);
      const existing = this.#byExtension.get(normalized);
      if (existing) {
        throw new Error(
          `Tree-sitter extension ${normalized} is already registered for ${existing.languageId}.`,
        );
      }
      this.#byExtension.set(normalized, registration);
    }
    this.#byId.set(registration.languageId, registration);
  }

  resolvePath(relativePath: string): TreeSitterLanguageRegistration | undefined {
    const extension = extensionForPath(relativePath);
    const registration = extension ? this.#byExtension.get(extension) : undefined;
    if (!registration || !extension) return registration;
    const grammar = registration.grammarsByExtension?.[extension] ?? registration.grammar;
    return grammar === registration.grammar ? registration : { ...registration, grammar };
  }
}

function displayNameFor(languageId: TreeSitterLanguageId): string {
  const names: Readonly<Record<TreeSitterLanguageId, string>> = {
    c: 'C', cpp: 'C++', kotlin: 'Kotlin', arkts: 'ArkTS (TypeScript syntax subset)',
    csharp: 'C#',
    go: 'Go',
    java: 'Java',
    javascript: 'JavaScript',
    python: 'Python',
    rust: 'Rust',
    typescript: 'TypeScript',
  };
  return names[languageId];
}

const defaultRegistrations: readonly TreeSitterLanguageRegistration[] = [
  { languageId: 'c', fileExtensions: ['.c', '.h'], grammar: C as TreeSitterGrammar, capabilityLevel: 'structural' },
  { languageId: 'cpp', fileExtensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], grammar: Cpp as TreeSitterGrammar, capabilityLevel: 'structural' },
  { languageId: 'kotlin', fileExtensions: ['.kt', '.kts'], grammar: Kotlin as TreeSitterGrammar, capabilityLevel: 'structural' },
  // ArkUI-specific syntax remains diagnostic; do not advertise compiler-level ArkTS support.
  { languageId: 'arkts', fileExtensions: ['.ets'], grammar: TypeScript.typescript as TreeSitterGrammar, capabilityLevel: 'structural' },
  {
    languageId: 'java',
    fileExtensions: ['.java'],
    grammar: Java as TreeSitterGrammar,
    capabilityLevel: 'structural',
  },
  {
    languageId: 'csharp',
    fileExtensions: ['.cs'],
    grammar: CSharp as TreeSitterGrammar,
    capabilityLevel: 'structural',
  },
  {
    languageId: 'typescript',
    fileExtensions: ['.ts', '.mts', '.cts', '.tsx'],
    grammar: TypeScript.typescript as TreeSitterGrammar,
    grammarsByExtension: { '.tsx': TypeScript.tsx as TreeSitterGrammar },
    capabilityLevel: 'structural',
  },
  {
    languageId: 'javascript',
    fileExtensions: ['.js', '.mjs', '.cjs', '.jsx'],
    grammar: JavaScript as TreeSitterGrammar,
    capabilityLevel: 'structural',
  },
  {
    languageId: 'python',
    fileExtensions: ['.py'],
    grammar: Python as TreeSitterGrammar,
    capabilityLevel: 'structural',
  },
  {
    languageId: 'go',
    fileExtensions: ['.go'],
    grammar: Go as TreeSitterGrammar,
    capabilityLevel: 'structural',
  },
  {
    languageId: 'rust',
    fileExtensions: ['.rs'],
    grammar: Rust as TreeSitterGrammar,
    capabilityLevel: 'structural',
  },
];

/** The first-party grammar set required by the structural index v1. */
export function createDefaultLanguageRegistry(): LanguageRegistry {
  return new LanguageRegistry(defaultRegistrations);
}

export const languageRegistryInternals = { extensionForPath, normalizeExtension };
