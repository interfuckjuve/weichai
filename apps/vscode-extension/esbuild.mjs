import { createRequire } from 'node:module';
import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(extensionDirectory, '..', '..');
const extensionOutputDirectory = process.env.FOREXPLORE_EXTENSION_OUTPUT_DIRECTORY
  ? path.resolve(process.env.FOREXPLORE_EXTENSION_OUTPUT_DIRECTORY)
  : path.join(extensionDirectory, 'dist', 'extension');
const nativeRuntimePackages = [
  'node-gyp-build',
  'tree-sitter',
  'tree-sitter-c',
  'tree-sitter-cpp',
  '@tree-sitter-grammars/tree-sitter-kotlin',
  'tree-sitter-c-sharp',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-rust',
  'tree-sitter-typescript',
];

await esbuild.build({
  entryPoints: [path.join(extensionDirectory, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(extensionOutputDirectory, 'extension.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  // Tree-sitter's grammar bindings locate platform-native .node files from
  // their own package directory.  Keep those imports external and copy their
  // packages beside the extension bundle below; bundling them would collapse
  // __dirname and make node-gyp-build load the wrong grammar binary.
  external: ['vscode', ...nativeRuntimePackages],
  sourcemap: true,
  logLevel: 'info',
});

await esbuild.build({
  entryPoints: [path.join(workspaceDirectory, 'services', 'code-indexer', 'src', 'structural-parse-worker.ts')],
  bundle: true,
  outfile: path.join(extensionOutputDirectory, 'structural-parse-worker.cjs'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: nativeRuntimePackages,
  sourcemap: true,
  logLevel: 'info',
});

const nativeModulesDirectory = path.join(extensionOutputDirectory, 'node_modules');
await rm(nativeModulesDirectory, { recursive: true, force: true });
await mkdir(nativeModulesDirectory, { recursive: true });
const indexerRequire = createRequire(path.join(workspaceDirectory, 'services', 'code-indexer', 'package.json'));
await Promise.all(nativeRuntimePackages.map(async (packageName) => {
  await cp(
    path.dirname(indexerRequire.resolve(`${packageName}/package.json`)),
    path.join(nativeModulesDirectory, packageName),
    { recursive: true, dereference: true },
  );
}));
