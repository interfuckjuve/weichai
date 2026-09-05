import esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(extensionDirectory, '..', '..');
const extensionOutputDirectory = path.join(extensionDirectory, 'dist', 'extension');
const nativeRuntimePackages = [
  'node-gyp-build',
  'tree-sitter',
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

const nativeModulesDirectory = path.join(extensionOutputDirectory, 'node_modules');
await rm(nativeModulesDirectory, { recursive: true, force: true });
await mkdir(nativeModulesDirectory, { recursive: true });
await Promise.all(nativeRuntimePackages.map(async (packageName) => {
  await cp(
    path.join(workspaceDirectory, 'node_modules', packageName),
    path.join(nativeModulesDirectory, packageName),
    { recursive: true, dereference: true },
  );
}));
