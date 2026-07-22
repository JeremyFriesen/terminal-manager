import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension, closeAllTerminals, deleteStateFile, readStateFile, waitFor, writeStateFile } from './testUtil';

describe('restore via command', () => {
  before(async () => {
    await activateExtension();
  });

  beforeEach(async () => {
    closeAllTerminals();
    await deleteStateFile();
  });

  after(() => {
    closeAllTerminals();
  });

  it('recreates a plain terminal from a pre-seeded state file', async function () {
    this.timeout(20000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'fixture workspace must be open');

    await writeStateFile([{ kind: 'plain', name: 'itest-restored', cwd: folder!.uri.fsPath }]);

    await vscode.commands.executeCommand('terminalManager.restoreStateNow');

    await waitFor(() => vscode.window.terminals.some((t) => t.name === 'itest-restored'), 10000);
  });

  it('does not duplicate a terminal that survived and is already open under the same name', async function () {
    this.timeout(20000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'fixture workspace must be open');

    const existing = vscode.window.createTerminal({ name: 'itest-no-dup' });
    // Wait for the tracker itself (not just vscode.window.terminals, which
    // updates independently and can race ahead of the extension's own
    // onDidOpenTerminal listener) to have recorded this terminal -- otherwise
    // restoreStateNow could run before currentNameCounts() knows about it.
    await waitFor(async () => {
      const state = await readStateFile();
      return !!state?.terminals.some((t) => t.name === 'itest-no-dup');
    });

    await writeStateFile([{ kind: 'plain', name: 'itest-no-dup', cwd: folder!.uri.fsPath }]);
    await vscode.commands.executeCommand('terminalManager.restoreStateNow');

    // Give restoreTerminals a beat to (wrongly, if this regresses) create a
    // second one before asserting there's still exactly one.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const matching = vscode.window.terminals.filter((t) => t.name === 'itest-no-dup');
    assert.strictEqual(matching.length, 1, `expected exactly one "itest-no-dup" terminal, found ${matching.length}`);

    existing.dispose();
  });
});
