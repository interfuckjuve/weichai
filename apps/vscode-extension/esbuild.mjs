import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import esbuild from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled verification runtime is LangChain, whose packages require Node
// >= 20. VS Code 1.90 (the declared engine floor) ships Electron 29 / Node
// 20.9, so the extension is compiled for node20 rather than node18.
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
  target: 'node20',
  // Tree-sitter's grammar bindings locate platform-native .node files from
  // their own package directory.  Keep those imports external and copy their
  // packages beside the extension bundle below; bundling them would collapse
  // __dirname and make node-gyp-build load the wrong grammar binary.
  external: ['vscode', ...nativeRuntimePackages],
  sourcemap: true,
  logLevel: 'info',
});

for (const worker of ['structural-parse-worker', 'structural-assembly-worker']) await esbuild.build({
  entryPoints: [path.join(workspaceDirectory, 'services', 'code-indexer', 'src', `${worker}.ts`)],
  bundle: true,
  outfile: path.join(extensionOutputDirectory, `${worker}.cjs`),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: nativeRuntimePackages,
  sourcemap: true,
  logLevel: 'info',
});

const nativeModulesDirectory = path.join(extensionOutputDirectory, 'node_modules');
for (const [source, output] of [
  [path.join(workspaceDirectory, 'services/adaptation-service/src/server.ts'), 'adaptation-server.cjs'],
  [path.join(extensionDirectory, 'src/workspace-compile.ts'), 'workspace-compile.cjs'],
]) await esbuild.build({ entryPoints: [source], bundle: true, outfile: path.join(extensionOutputDirectory, output),
  format: 'cjs', platform: 'node', target: 'node20', external: nativeRuntimePackages, logLevel: 'info' });
const indexerRequire = createRequire(path.join(workspaceDirectory, 'services', 'code-indexer', 'package.json'));

/**
 * A Windows extension host keeps the grammar `.node` files it loaded open, so
 * they cannot be deleted or rewritten while a window is running.  The previous
 * implementation deleted the whole directory first, which failed partway
 * through and left the installed packages incomplete.  Copying only what
 * actually changed makes a routine rebuild a no-op for those files.
 */
const lockedFileCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);

async function sizeOf(file) {
  return stat(file).then((info) => info.size, () => -1);
}

async function digest(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function isIdentical(source, target) {
  if (await sizeOf(source) !== await sizeOf(target)) return false;
  return await digest(source) === await digest(target);
}

async function syncNativeModule(source, target, locked) {
  await mkdir(target, { recursive: true });
  const expected = new Set();
  for (const entry of await readdir(source)) {
    const from = path.join(source, entry);
    const to = path.join(target, entry);
    expected.add(entry);
    // `stat` follows links so a pnpm-managed package copies as real files.
    if ((await stat(from)).isDirectory()) {
      await syncNativeModule(from, to, locked);
      continue;
    }
    if (await isIdentical(from, to)) continue;
    try {
      await cp(from, to, { force: true });
    } catch (error) {
      if (!lockedFileCodes.has(error.code)) throw error;
      locked.push(to);
    }
  }
  for (const entry of await readdir(target)) {
    if (expected.has(entry)) continue;
    try {
      await rm(path.join(target, entry), { recursive: true, force: true });
    } catch (error) {
      // A stale extra file never changes which binary node-gyp-build loads.
      if (!lockedFileCodes.has(error.code)) throw error;
    }
  }
}

const locked = [];
for (const packageName of nativeRuntimePackages) {
  await syncNativeModule(
    path.dirname(indexerRequire.resolve(`${packageName}/package.json`)),
    path.join(nativeModulesDirectory, packageName),
    locked,
  );
}
if (locked.length > 0) {
  throw new Error([
    '无法更新以下本地模块：它们正被一个已加载该扩展的 VS Code 窗口占用。',
    '请关闭运行本扩展的窗口后重新构建（或直接重启 VS Code）：',
    ...locked.map((file) => `  - ${file}`),
  ].join('\n'));
}
