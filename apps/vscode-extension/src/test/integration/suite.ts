import * as assert from 'node:assert';
import * as vscode from 'vscode';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms.`);
}

function findTranslationTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(isTranslationTab);
}

/**
 * VS Code 1.136 exposes an internally prefixed view type in TabInputWebview
 * (`mainThreadWebview-forexplore.translation`), while older builds expose
 * the contributed view type verbatim. Both identify the same panel.
 */
function isTranslationTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && (
    tab.input.viewType === 'forexplore.translation' ||
    tab.input.viewType.endsWith('-forexplore.translation')
  );
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('forexplore.forexplore-vscode');
  assert.ok(extension, 'extension forexplore.forexplore-vscode must be activated');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'forexplore.showPanel',
    'forexplore.checkRepositories',
    'forexplore.reindex',
    'forexplore.refreshCodeIntelligence',
    'forexplore.restoreLastCheckpoint',
  ]) {
    assert.ok(commands.includes(command), `command ${command} must be registered`);
  }
  // Repository configuration and project analysis must be accessible before selecting a method.
  await vscode.commands.executeCommand('forexplore.showPanel');
  await waitFor(() => findTranslationTab() !== undefined);
  assert.ok(findTranslationTab(), 'project panel must open without an editor selection');

  // Re-running the panel command must reuse the same panel.
  await vscode.commands.executeCommand('forexplore.showPanel');
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const panels = tabs.filter(isTranslationTab);
  assert.strictEqual(panels.length, 1, 'translation panel must be reused, not duplicated');
}
