import * as assert from 'assert';
import * as vscode from 'vscode';
import { activateExtension, closeAllTerminals, deleteStateFile, readStateFile, waitFor } from './testUtil';

describe('terminal lifecycle tracking', () => {
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

  it('records a newly opened plain terminal to the real state file', async () => {
    const terminal = vscode.window.createTerminal({ name: 'itest-plain-a' });

    await waitFor(async () => {
      const state = await readStateFile();
      return !!state?.terminals.some((t) => t.name === 'itest-plain-a');
    });

    const state = await readStateFile();
    const entry = state?.terminals.find((t) => t.name === 'itest-plain-a');
    assert.strictEqual(entry?.kind, 'plain');

    terminal.dispose();
  });

  it('removes a closed terminal from the file, as long as another one is still open', async () => {
    const survivor = vscode.window.createTerminal({ name: 'itest-survivor' });
    const doomed = vscode.window.createTerminal({ name: 'itest-doomed' });

    await waitFor(async () => {
      const state = await readStateFile();
      return !!state?.terminals.some((t) => t.name === 'itest-survivor') && !!state?.terminals.some((t) => t.name === 'itest-doomed');
    });

    doomed.dispose();

    await waitFor(async () => {
      const state = await readStateFile();
      return !!state?.terminals.some((t) => t.name === 'itest-survivor') && !state?.terminals.some((t) => t.name === 'itest-doomed');
    });

    survivor.dispose();
  });

  it('refuses to persist an empty state when the last terminal closes (window-close guard)', async () => {
    const only = vscode.window.createTerminal({ name: 'itest-only' });

    await waitFor(async () => {
      const state = await readStateFile();
      return !!state?.terminals.some((t) => t.name === 'itest-only');
    });

    only.dispose();

    // There's no event for "a save was skipped" -- give the debounced save a
    // window to run (and wrongly clobber the file) before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const state = await readStateFile();
    assert.ok(
      state?.terminals.some((t) => t.name === 'itest-only'),
      'expected the last-closed terminal to remain in the saved file instead of being wiped',
    );
  });
});
