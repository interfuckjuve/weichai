/**
 * Integration test runner: downloads (once) a VSCode runtime through
 * @vscode/test-electron and executes the extension-host suite against the
 * built extension.
 *
 * Usage: npm run test:integration --workspace forexplore-vscode
 */
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extensionRoot = fileURLToPath(new URL('../../..', import.meta.url));
const suitePath = fileURLToPath(new URL('../../../dist/test/integration/suite.js', import.meta.url));
const extensionDevelopmentPath = path.resolve(extensionRoot);
const fixtureWorkspace = fileURLToPath(
  new URL('../../../../../fixtures/target-system/commons-fileupload-java-skeleton', import.meta.url),
);
async function main(): Promise<void> {
  try {
    const configuredExecutable = process.env.FOREXPLORE_TEST_VSCODE_PATH?.trim();
    const executablePath = configuredExecutable
      ? path.resolve(configuredExecutable)
      : await downloadAndUnzipVSCode({ version: 'stable' });
    await ensureMacOsExecutableCompatibility(executablePath);
    await runTests({
      vscodeExecutablePath: executablePath,
      extensionDevelopmentPath,
      extensionTestsPath: suitePath,
      launchArgs: [
        '--disable-extensions',
        '--disable-workspace-trust',
        '--user-data-dir',
        path.join(extensionRoot, '.vscode-test-user'),
        '--folder-uri',
        pathToFileURL(fixtureWorkspace).toString(),
      ],
    });
  } catch (error) {
    console.error('Integration tests failed:', error);
    process.exitCode = 1;
  }
}

/**
 * VS Code 1.131+ renamed the macOS launcher from `Electron` to `Code`, while
 * @vscode/test-electron still resolves `Contents/MacOS/Electron`. Symlink the
 * new name so the test host can launch the downloaded build.
 */
async function ensureMacOsExecutableCompatibility(executablePath: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  const macOsDirectory = path.join(path.dirname(executablePath), 'MacOS');
  const electronPath = path.join(macOsDirectory, 'Electron');
  const codePath = path.join(macOsDirectory, 'Code');
  if (!existsSync(macOsDirectory)) return;
  if (!existsSync(electronPath) && existsSync(codePath)) {
    symlinkSync('Code', electronPath);
  }
}

void main();
