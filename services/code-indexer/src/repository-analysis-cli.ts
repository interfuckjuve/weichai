import path from 'node:path';
import {
  analyzeRepository,
  writeRepositoryAnalysisArtifact,
} from './repository-analysis.js';

const args = process.argv.slice(2);
const writeArtifact = args.includes('--write-artifact');
const semanticEnrichment = args.includes('--semantic-enrichment');
const allowDirtyWorktreeForPlanning = args.includes('--allow-dirty-planning');
const rootArgument = args.find((arg) => !arg.startsWith('--'));

if (!rootArgument) {
  throw new Error(
    'Usage: npm run analyze-repository -- <repositoryRoot> [--write-artifact] [--semantic-enrichment] [--allow-dirty-planning]',
  );
}

const root = path.resolve(rootArgument);
const analysis = await analyzeRepository({
  root,
  ...(semanticEnrichment ? { semanticEnrichment: true } : {}),
  ...(allowDirtyWorktreeForPlanning ? { allowDirtyWorktreeForPlanning: true } : {}),
});
if (writeArtifact) {
  const artifactPath = await writeRepositoryAnalysisArtifact(root, analysis);
  if (process.stdout.isTTY) {
    console.error(`[code-indexer] wrote immutable analysis snapshot: ${artifactPath}`);
  }
}
process.stdout.write(`${JSON.stringify(analysis)}\n`);
