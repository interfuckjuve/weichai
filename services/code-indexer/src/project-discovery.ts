import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AnalysisRevisionId,
  LanguageId,
  ProjectId,
  ProjectRecord,
  RepositoryId,
} from '@forexplore/contracts';
import {
  sourceRangeForOffsets,
  type StructuralSourceRange,
} from './tree-sitter-indexer.js';

export interface ProjectDiscoveryFile {
  content: string;
  languageId?: LanguageId;
  relativePath: string;
}

export interface ProjectReferenceSyntax {
  sourceRange: StructuralSourceRange;
  sourceRelativePath: string;
  targetReference: string;
}

export interface ProjectDiscoveryRequest {
  analysisRevision: AnalysisRevisionId;
  files: readonly ProjectDiscoveryFile[];
  repositoryId: RepositoryId;
}

export interface ProjectDiscoveryResult {
  projectReferences: ProjectReferenceSyntax[];
  projects: ProjectRecord[];
}

interface ManifestKind {
  kind: string;
  languageIds: LanguageId[];
  matches(relativePath: string): boolean;
}

const manifestKinds: readonly ManifestKind[] = [
  {
    kind: 'maven',
    languageIds: ['java'],
    matches: (path) => basename(path).toLowerCase() === 'pom.xml',
  },
  {
    kind: 'gradle',
    languageIds: ['java'],
    matches: (path) => ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
      .includes(basename(path).toLowerCase()),
  },
  {
    kind: 'dotnet',
    languageIds: ['csharp'],
    matches: (path) => /\.(?:csproj|sln)$/i.test(path),
  },
  {
    kind: 'node',
    languageIds: ['javascript', 'typescript'],
    matches: (path) => basename(path).toLowerCase() === 'package.json',
  },
  {
    kind: 'python',
    languageIds: ['python'],
    matches: (path) => basename(path).toLowerCase() === 'pyproject.toml',
  },
  {
    kind: 'go',
    languageIds: ['go'],
    matches: (path) => basename(path).toLowerCase() === 'go.mod',
  },
  {
    kind: 'cargo',
    languageIds: ['rust'],
    matches: (path) => basename(path).toLowerCase() === 'cargo.toml',
  },
];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function basename(relativePath: string): string {
  return canonicalPath(relativePath).split('/').at(-1) ?? relativePath;
}

function directory(relativePath: string): string {
  const normalized = canonicalPath(relativePath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function projectId(kind: string, root: string, manifests: readonly string[]): ProjectId {
  return `project-${sha256(JSON.stringify({ kind, root, manifests })).slice(0, 24)}`;
}

function displayName(root: string, manifestPaths: readonly string[]): string {
  if (root) return root.split('/').at(-1) ?? root;
  const manifest = manifestPaths[0];
  return manifest ? basename(manifest).replace(/\.[^.]+$/, '') : 'repository';
}

function sourceRoots(kind: string, root: string): string[] {
  const join = (child: string): string => root ? `${root}/${child}` : child;
  switch (kind) {
    case 'maven':
    case 'gradle':
      return [join('src/main/java'), join('src')];
    case 'dotnet':
    case 'node':
    case 'python':
    case 'go':
    case 'cargo':
      return [join('src'), root];
    default:
      return [root];
  }
}

function testRoots(kind: string, root: string): string[] {
  const join = (child: string): string => root ? `${root}/${child}` : child;
  switch (kind) {
    case 'maven':
    case 'gradle':
      return [join('src/test/java'), join('test'), join('tests')];
    default:
      return [join('test'), join('tests')];
  }
}

function pathWithin(relativePath: string, root: string): boolean {
  const normalizedPath = canonicalPath(relativePath);
  const normalizedRoot = canonicalPath(root).replace(/\/$/, '');
  return !normalizedRoot || normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function projectReference(
  file: ProjectDiscoveryFile,
  rawTarget: string,
  offset: number,
  knownPaths: ReadonlySet<string>,
  expectedManifestNames: readonly string[],
): ProjectReferenceSyntax | undefined {
  const raw = rawTarget.trim().replaceAll('\\', '/').replace(/^(?:file:|workspace:)/, '');
  if (!raw) return undefined;
  const sourcePath = canonicalPath(file.relativePath);
  // Keep references external/unresolved rather than accidentally treating an
  // absolute host path as a repository edge. The dependency resolver will
  // retain the resulting explicit evidence as unresolved.
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    return {
      sourceRange: sourceRangeForOffsets(file.content, offset, offset + rawTarget.length),
      sourceRelativePath: sourcePath,
      targetReference: raw,
    };
  }
  const base = canonicalPath(path.posix.normalize(path.posix.join(directory(sourcePath), raw)));
  const candidates = raw.toLowerCase().endsWith('.csproj') ||
      expectedManifestNames.some((name) => basename(base).toLowerCase() === name)
    ? [base]
    : expectedManifestNames.map((name) => canonicalPath(path.posix.join(base, name)));
  const target = candidates.find((candidate) => knownPaths.has(candidate)) ?? candidates[0] ?? base;
  const targetReference = path.posix.relative(directory(sourcePath), target) || basename(target);
  return {
    sourceRange: sourceRangeForOffsets(file.content, offset, offset + rawTarget.length),
    sourceRelativePath: sourcePath,
    targetReference,
  };
}

function quotedValues(value: string): Array<{ offset: number; value: string }> {
  const values: Array<{ offset: number; value: string }> = [];
  const expression = /["']([^"']+)["']/g;
  for (const match of value.matchAll(expression)) {
    const target = match[1];
    if (target === undefined || match.index === undefined) continue;
    values.push({ value: target, offset: match.index + match[0].indexOf(target) });
  }
  return values;
}

function projectReferenceSyntax(
  file: ProjectDiscoveryFile,
  knownPaths: ReadonlySet<string>,
  packageManifestsByName: ReadonlyMap<string, string>,
): ProjectReferenceSyntax[] {
  const relativePath = canonicalPath(file.relativePath);
  const references: ProjectReferenceSyntax[] = [];
  const add = (value: string, offset: number, manifests: readonly string[]): void => {
    const reference = projectReference(file, value, offset, knownPaths, manifests);
    if (reference) references.push(reference);
  };

  if (relativePath.toLowerCase().endsWith('.csproj')) {
    const expression = /<ProjectReference\s+[^>]*\bInclude\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi;
    for (const match of file.content.matchAll(expression)) {
      const value = match[1];
      if (!value || match.index === undefined) continue;
      add(value, match.index + match[0].indexOf(value), ['.csproj']);
    }
  } else if (basename(relativePath).toLowerCase() === 'pom.xml') {
    const expression = /<module>\s*([^<\s]+)\s*<\/module>/gi;
    for (const match of file.content.matchAll(expression)) {
      const value = match[1];
      if (!value || match.index === undefined) continue;
      add(value, match.index + match[0].indexOf(value), ['pom.xml']);
    }
  } else if (['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts']
    .includes(basename(relativePath).toLowerCase())) {
    // Gradle project paths are explicit but not filesystem paths. Convert
    // only the `:nested:module` notation to a candidate manifest; no class or
    // dependency inference is attempted.
    const expression = /(?:include|project)\s*\(?\s*(["']:[^"']+["'])/g;
    for (const match of file.content.matchAll(expression)) {
      if (match.index === undefined) continue;
      for (const quoted of quotedValues(match[0])) {
        const modulePath = quoted.value.replace(/^:/, '').replaceAll(':', '/');
        add(modulePath, match.index + quoted.offset, ['build.gradle.kts', 'build.gradle']);
      }
    }
  } else if (basename(relativePath).toLowerCase() === 'package.json') {
    try {
      const parsed = JSON.parse(file.content) as Record<string, unknown>;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const dependencies = parsed[section];
        if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
        for (const [name, spec] of Object.entries(dependencies as Record<string, unknown>)) {
          if (typeof spec !== 'string') continue;
          const offset = file.content.indexOf(spec);
          if (offset < 0) continue;
          if (/^(?:file:|workspace:\.{1,2}\/)/.test(spec)) {
            add(spec, offset, ['package.json']);
          } else if (spec === 'workspace:*') {
            const target = packageManifestsByName.get(name);
            if (target) {
              const reference = path.posix.relative(directory(relativePath), target) || basename(target);
              references.push({
                sourceRange: sourceRangeForOffsets(file.content, offset, offset + spec.length),
                sourceRelativePath: relativePath,
                targetReference: reference,
              });
            } else {
              references.push({
                sourceRange: sourceRangeForOffsets(file.content, offset, offset + spec.length),
                sourceRelativePath: relativePath,
                targetReference: spec,
              });
            }
          }
        }
      }
    } catch {
      // Tree-sitter/JSON diagnostics own malformed manifests; project
      // discovery remains best-effort and never fabricates a dependency.
    }
  } else if (basename(relativePath).toLowerCase() === 'cargo.toml') {
    const expression = /\bpath\s*=\s*["']([^"']+)["']/g;
    for (const match of file.content.matchAll(expression)) {
      const value = match[1];
      if (!value || match.index === undefined) continue;
      add(value, match.index + match[0].indexOf(value), ['Cargo.toml']);
    }
  } else if (basename(relativePath).toLowerCase() === 'go.mod') {
    const expression = /^\s*replace\s+\S+\s*(?:\S+\s*)?=>\s*([^\s]+).*$/gim;
    for (const match of file.content.matchAll(expression)) {
      const value = match[1];
      if (!value || match.index === undefined || !value.startsWith('.')) continue;
      add(value, match.index + match[0].indexOf(value), ['go.mod']);
    }
  } else if (basename(relativePath).toLowerCase() === 'pyproject.toml') {
    // PEP 621 itself does not standardize local dependency objects, but the
    // common Poetry/PDM forms use a literal `path = "..."`. Keep that
    // explicit source syntax and resolve only a pyproject manifest target.
    const expression = /\bpath\s*=\s*["']([^"']+)["']/g;
    for (const match of file.content.matchAll(expression)) {
      const value = match[1];
      if (!value || match.index === undefined) continue;
      add(value, match.index + match[0].indexOf(value), ['pyproject.toml']);
    }
  }
  const unique = new Map<string, ProjectReferenceSyntax>();
  for (const reference of references) {
    unique.set(`${reference.sourceRelativePath}\u0000${reference.targetReference}\u0000${reference.sourceRange.startLine}\u0000${reference.sourceRange.startColumn}`, reference);
  }
  return [...unique.values()];
}

/**
 * Find build/package boundaries without parsing application code. The result
 * is deterministic and contains only repository-relative paths, so a caller
 * can persist it as part of an immutable analysis revision.
 */
export function discoverProjects(request: ProjectDiscoveryRequest): ProjectDiscoveryResult {
  const groups = new Map<string, {
    kind: string;
    languageIds: LanguageId[];
    manifestPaths: string[];
    root: string;
  }>();

  for (const file of request.files) {
    const relativePath = canonicalPath(file.relativePath);
    for (const manifest of manifestKinds) {
      if (!manifest.matches(relativePath)) continue;
      const root = directory(relativePath);
      const key = `${manifest.kind}\u0000${root}`;
      const group = groups.get(key) ?? {
        kind: manifest.kind,
        languageIds: [...manifest.languageIds],
        manifestPaths: [],
        root,
      };
      group.manifestPaths.push(relativePath);
      groups.set(key, group);
    }
  }

  const projects = [...groups.values()]
    .map((group): ProjectRecord => {
      const manifests = [...new Set(group.manifestPaths)].sort(compareText);
      return {
        repositoryId: request.repositoryId,
        analysisRevision: request.analysisRevision,
        projectId: projectId(group.kind, group.root, manifests),
        kind: group.kind,
        displayName: displayName(group.root, manifests),
        relativePath: group.root,
        manifestPaths: manifests,
        sourceRoots: sourceRoots(group.kind, group.root),
        testRoots: testRoots(group.kind, group.root),
        languageIds: [...group.languageIds].sort(compareText),
      };
    })
    .sort((left, right) => compareText(left.projectId, right.projectId));

  const knownPaths = new Set(request.files.map((file) => canonicalPath(file.relativePath)));
  const packageManifestsByName = new Map<string, string>();
  for (const file of request.files) {
    if (basename(file.relativePath).toLowerCase() !== 'package.json') continue;
    try {
      const parsed = JSON.parse(file.content) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim() && !packageManifestsByName.has(parsed.name)) {
        packageManifestsByName.set(parsed.name, canonicalPath(file.relativePath));
      }
    } catch {
      // A malformed manifest is not a project-reference fact.
    }
  }

  if (request.files.some((file) => !projectForPath(projects, file.relativePath, file.languageId))) {
    projects.push({
      repositoryId: request.repositoryId, analysisRevision: request.analysisRevision,
      projectId: projectId('directory', '', []), kind: 'directory', displayName: '未归属工程文件',
      relativePath: '', manifestPaths: [], sourceRoots: [''], testRoots: [],
      languageIds: [...new Set(request.files.flatMap((file) => file.languageId ? [file.languageId] : []))],
    });
  }
  return {
    projects,
    projectReferences: request.files
      .flatMap((file) => projectReferenceSyntax(file, knownPaths, packageManifestsByName))
      .sort((left, right) =>
        compareText(
          `${left.sourceRelativePath}:${left.targetReference}:${left.sourceRange.startLine}:${left.sourceRange.startColumn}`,
          `${right.sourceRelativePath}:${right.targetReference}:${right.sourceRange.startLine}:${right.sourceRange.startColumn}`,
        ),
      ),
  };
}

/** Assign a source/configuration file to its deepest compatible project boundary. */
export function projectForPath(
  projects: readonly ProjectRecord[],
  relativePath: string,
  languageId?: LanguageId,
): ProjectRecord | undefined {
  const candidates = projects.filter((project) =>
    pathWithin(relativePath, project.relativePath) &&
    (languageId === undefined || project.languageIds.includes(languageId)),
  );
  candidates.sort((left, right) => {
    const depth = canonicalPath(right.relativePath).length - canonicalPath(left.relativePath).length;
    return depth || Number(left.kind === 'directory') - Number(right.kind === 'directory') || compareText(left.projectId, right.projectId);
  });
  return candidates[0];
}

export const projectDiscoveryInternals = {
  basename,
  canonicalPath,
  directory,
  pathWithin,
  projectId,
};
