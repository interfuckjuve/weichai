import esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/test/integration/suite.ts'],
  bundle: true,
  outfile: 'dist/test/integration/suite.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'info',
});
