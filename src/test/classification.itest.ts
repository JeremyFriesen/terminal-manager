import * as vscode from 'vscode';
import { activateExtension, closeAllTerminals, deleteStateFile, readStateFile, waitFor } from './testUtil';

/**
 * Exercises real onDidStartTerminalShellExecution wiring against a live
 * shell (assumes the fixture workspace's default integrated terminal profile
 * is PowerShell, as it is on this project's dev machine) -- classify.ts's
 * regexes themselves are already exhaustively covered by the vitest unit
 * suite, so the point here is only to prove the real event fires and reaches
 * the state file, not to re-verify pattern matching.
 *
 * Every non-plain entry reverts to plain the moment its shell command ends
 * (see revertToPlainOnCommandEnd), and neither `claude` nor `docker` is
 * necessarily installed on the test machine, so each command is chained with
 * `; Start-Sleep -Seconds N` -- the *typed line* (and therefore the
 * classification) still starts with the real command, but the overall shell
 * execution keeps running past the debounced save, long enough to observe it
 * on disk before it reverts.
 */
describe('command classification via real shell execution', () => {
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

  it('classifies "claude --resume <uuid>" as an exact-mode claude session', async function () {
    this.timeout(20000);
    const terminal = vscode.window.createTerminal({ name: 'itest-claude' });
    await waitFor(() => terminal.shellIntegration !== undefined, 15000);

    const sessionId = '68b141fc-fb9e-46ce-bb39-3b68f8e1ed98';
    terminal.sendText(`claude --resume ${sessionId}; Start-Sleep -Seconds 6`, true);

    await waitFor(async () => {
      const state = await readStateFile();
      const entry = state?.terminals.find((t) => t.name === 'itest-claude');
      return entry?.kind === 'claude' && entry.sessionId === sessionId && entry.resumeMode === 'exact';
    }, 8000);

    terminal.dispose();
  });

  it('classifies "docker logs -f <container>" as a watched-command', async function () {
    this.timeout(20000);
    const terminal = vscode.window.createTerminal({ name: 'itest-docker' });
    await waitFor(() => terminal.shellIntegration !== undefined, 15000);

    terminal.sendText('docker logs -f some-container; Start-Sleep -Seconds 6', true);

    await waitFor(async () => {
      const state = await readStateFile();
      const entry = state?.terminals.find((t) => t.name === 'itest-docker');
      return entry?.kind === 'watched-command' && entry.label === 'docker logs';
    }, 8000);

    terminal.dispose();
  });

  it('reverts a watched-command entry back to plain once the command ends', async function () {
    this.timeout(20000);
    const terminal = vscode.window.createTerminal({ name: 'itest-revert' });
    await waitFor(() => terminal.shellIntegration !== undefined, 15000);

    terminal.sendText('docker logs -f some-container; Start-Sleep -Seconds 2', true);

    await waitFor(async () => {
      const state = await readStateFile();
      return state?.terminals.find((t) => t.name === 'itest-revert')?.kind === 'watched-command';
    }, 8000);

    await waitFor(async () => {
      const state = await readStateFile();
      return state?.terminals.find((t) => t.name === 'itest-revert')?.kind === 'plain';
    }, 8000);

    terminal.dispose();
  });
});
