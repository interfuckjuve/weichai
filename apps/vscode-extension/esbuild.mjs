import esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

// sql.js keeps the registry portable across VS Code/Electron ABIs. Its WASM
// binary is resolved explicitly at runtime and therefore has to sit beside the
// bundled extension entrypoint (which is already included by the VSIX files
// allow-list).
await mkdir('dist/extension', { recursive: true });
await copyFile(
  path.resolve('../../node_modules/sql.js/dist/sql-wasm.wasm'),
  path.resolve('dist/extension/sql-wasm.wasm'),
);
