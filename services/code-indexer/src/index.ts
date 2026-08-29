/**
 * @forexplore/code-indexer
 *
 * Module 1 — 代码仓库发现与符号提取
 *   discover repositories → scan source files → extract symbols → output documents
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { IndexedCodeDocument, Language } from '@forexplore/contracts';
import { discoverRepositories, resolveSourceRoot } from './discover.js';
import type { CorpusManifest } from './discover.js';
import { extractSymbols, fileExtensions, isTestPath } from './extractor.js';
import type { SymbolMatch } from './extractor.js';

export type { CorpusManifest } from './discover.js';
export type { SymbolMatch } from './extractor.js';
export type {
  AnalyzeRepositoryRequest,
  CompilerProbe,
  CompilerProbeDiagnostic,
  CompilerProbeRequest,
  CompilerProbeResult,
  CompilerProbeStatus,
  SemanticDependencyBinding,
} from './repository-analysis.js';
export {
  analyzeRepository,
  readRepositoryAnalysisArtifact,
  repositoryAnalysisContentHash,
  repositoryAnalysisArtifactDirectory,
  repositoryAnalysisArtifactPath,
  repositoryAnalysisSnapshotId,
  repositoryAnalysisVersion,
  verifyRepositoryStaticAnalysis,
  writeRepositoryAnalysisArtifact,
} from './repository-analysis.js';

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === 'target' ||
        entry.name === 'build' ||
        entry.name === '__pycache__' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (fileExtensions[path.extname(entry.name)]) files.push(absolute);
    }
  }
  await visit(root);
  return files;
}

export async function extractCorpus(
  corpusRoot: string,
): Promise<IndexedCodeDocument[]> {
  const documents: IndexedCodeDocument[] = [];

  for (const { root: repositoryRoot, manifest } of await discoverRepositories(corpusRoot)) {
    const scanRoot = resolveSourceRoot(repositoryRoot, manifest.sourceRoot);
    for (const absolutePath of await sourceFiles(scanRoot)) {
      const relativePath = path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
      if (isTestPath(relativePath)) continue;
      const fileLanguage = fileExtensions[path.extname(absolutePath)];
      if (!fileLanguage || fileLanguage !== manifest.language) continue;
      const source = await readFile(absolutePath, 'utf8');
      for (const symbol of extractSymbols(source, manifest.language)) {
        documents.push({
          id: `${manifest.repository}:${relativePath}:${symbol.line}:${symbol.name}`,
          title: symbol.kind === 'class'
            ? manifest.retrievalClassAliases?.[symbol.name] || symbol.name
            : symbol.name,
          repository: `fixture/${manifest.repository}`,
          license: manifest.license || 'Unknown',
          language: manifest.language,
          kind: symbol.kind,
          path: relativePath,
          signature: symbol.signature,
          summary: symbol.summary,
          preview: symbol.preview,
          content: symbol.preview,
          dependencies: manifest.dependencies || [],
          compatibility: [`Extracted from ${manifest.language} source`],
          risks: manifest.synthetic ? ['Synthetic evaluation fixture'] : [],
        });
      }
    }
  }

  return documents;
}

export { discoverRepositories, extractSymbols, resolveSourceRoot };
