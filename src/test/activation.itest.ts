import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension } from './testUtil';

/**
 * Runs inside a real VS Code Extension Development Host (via @vscode/test-electron),
 * against the fixture workspace at src/test/fixture-workspace, which has
 * terminalManager.enabled = true. This is the one thing the unit suite
 * structurally cannot cover: that activate() actually runs to completion
 * against the real vscode API and registers what it promises to.
 */
describe('extension activation', () => {
  it('activates without throwing and reports itself active', async () => {
    const ext = await activateExtension();
    assert.strictEqual(ext.isActive, true);
  });

  it('registers all seven commands', async () => {
    await activateExtension();
    const all = await vscode.commands.getCommands(true);
    const expected = [
      'terminalManager.saveStateNow',
      'terminalManager.restoreStateNow',
      'terminalManager.clearState',
      'terminalManager.enable',
      'terminalManager.disable',
      'terminalManager.enableLogging',
      'terminalManager.disableLogging',
    ];
    for (const command of expected) {
      assert.ok(all.includes(command), `expected command "${command}" to be registered`);
    }
  });

  it('picked up the fixture workspace setting that enables tracking', () => {
    const enabled = vscode.workspace.getConfiguration('terminalManager').get<boolean>('enabled');
    assert.strictEqual(enabled, true);
  });
});
