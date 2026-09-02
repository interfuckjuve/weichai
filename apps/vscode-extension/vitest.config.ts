import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./src/test/vscode-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'src/**/*.test.ts',
      'webview/src/**/*.test.ts',
      'webview/src/**/*.test.tsx',
    ],
  },
});
