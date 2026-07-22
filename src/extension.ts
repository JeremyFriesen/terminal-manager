import * as vscode from 'vscode';
import { createStateRepository } from './state/storage';
import { TerminalTracker } from './tracking/terminalTracker';
import { restoreTerminals } from './restore/restoreTerminals';
import { registerCommands, registerDisabledCommands, registerToggleCommands, maybeShowEnablePrompt } from './commands';
import { initLogging, log } from './logging';

let tracker: TerminalTracker | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogging(context);
  log('activate() start');

  const config = vscode.workspace.getConfiguration('terminalManager');
  const enabled = config.get<boolean>('enabled', false);
  log(`activate() terminalManager.enabled = ${enabled}`);

  // Registered regardless of enabled state -- "Enable" must work precisely
  // when currently disabled, and vice versa.
  registerToggleCommands(context);

  // Having a saved terminal-state-manager.json and the extension installed is
  // deliberately not enough on its own -- each workspace must opt in via this
  // setting, so installing the extension for one project can't silently start
  // tracking/restoring terminals in every other workspace you happen to open.
  if (!enabled) {
    registerDisabledCommands(context);
    void maybeShowEnablePrompt(context);
    return;
  }

  const repository = createStateRepository();
  const initialState = await repository.load();
  log(`activate() loaded state: ${initialState.terminals.length} entries [${initialState.terminals.map((t) => `${t.name}:${t.kind}`).join(', ')}]`);

  tracker = new TerminalTracker(context, repository);
  await tracker.start(initialState);
  context.subscriptions.push(tracker);

  registerCommands(context, repository, tracker);

  if (config.get<boolean>('autoRestoreOnStartup', true)) {
    const delayMs = config.get<number>('restoreDelayMs', 1500);
    setTimeout(() => {
      const skip = tracker?.currentNameCounts();
      log(`restore timer firing, skipping already-open names [${Array.from(skip ?? []).map(([n, c]) => `${n}x${c}`).join(', ')}]`);
      void restoreTerminals(repository, skip);
    }, delayMs);
  }
}

export async function deactivate(): Promise<void> {
  log('deactivate() invoked, flushing state');
  await tracker?.flush();
}
