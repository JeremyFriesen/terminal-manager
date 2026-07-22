import * as vscode from 'vscode';
import { StateRepository } from './state/storage';
import { emptyState } from './state/types';
import { TerminalTracker } from './tracking/terminalTracker';
import { restoreTerminals } from './restore/restoreTerminals';

export function registerCommands(
  context: vscode.ExtensionContext,
  repository: StateRepository,
  tracker: TerminalTracker,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.saveStateNow', async () => {
      await tracker.flush();
      void vscode.window.showInformationMessage('Terminal Manager: state saved.');
    }),
    vscode.commands.registerCommand('terminalManager.restoreStateNow', async () => {
      await restoreTerminals(repository, tracker.currentNameCounts());
    }),
    vscode.commands.registerCommand('terminalManager.clearState', async () => {
      await repository.save(emptyState());
      void vscode.window.showInformationMessage('Terminal Manager: saved state cleared.');
    }),
  );
}

const DISABLED_MESSAGE =
  'Terminal Manager is disabled for this workspace. Set "terminalManager.enabled": true in this workspace\'s ' +
  'settings and reload the window to use it.';

/** Keeps the commands visible/discoverable in the Command Palette even when off, rather than having them silently not exist. */
export function registerDisabledCommands(context: vscode.ExtensionContext): void {
  const showDisabledMessage = () => void vscode.window.showInformationMessage(DISABLED_MESSAGE);
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.saveStateNow', showDisabledMessage),
    vscode.commands.registerCommand('terminalManager.restoreStateNow', showDisabledMessage),
    vscode.commands.registerCommand('terminalManager.clearState', showDisabledMessage),
  );
}

/**
 * Written to the *workspace* settings target specifically (.vscode/settings.json),
 * never Global/User -- these settings are deliberately per-project opt-in, so a
 * command run from one workspace must never flip the default for every other
 * project you open.
 */
async function updateWorkspaceSetting(key: string, value: boolean, friendlyName: string): Promise<void> {
  try {
    await vscode.workspace.getConfiguration('terminalManager').update(key, value, vscode.ConfigurationTarget.Workspace);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Terminal Manager: couldn't update "${friendlyName}" -- ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // activate() only reads this setting once at startup, so it doesn't take
  // effect live -- offer to reload rather than leaving the user to guess why
  // nothing changed.
  const choice = await vscode.window.showInformationMessage(
    `Terminal Manager: ${friendlyName} ${value ? 'enabled' : 'disabled'} for this workspace. Reload the window for it to take effect.`,
    'Reload Window',
  );
  if (choice === 'Reload Window') {
    void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/** Registered unconditionally (regardless of terminalManager.enabled) since "Enable" must work precisely while currently disabled, and vice versa. */
export function registerToggleCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('terminalManager.enable', () => updateWorkspaceSetting('enabled', true, 'tracking')),
    vscode.commands.registerCommand('terminalManager.disable', () => updateWorkspaceSetting('enabled', false, 'tracking')),
    vscode.commands.registerCommand('terminalManager.enableLogging', () => updateWorkspaceSetting('debugLogging', true, 'debug logging')),
    vscode.commands.registerCommand('terminalManager.disableLogging', () => updateWorkspaceSetting('debugLogging', false, 'debug logging')),
  );
}

const SUPPRESS_ENABLE_PROMPT_KEY = 'terminalManager.suppressEnablePrompt';

/**
 * Surfaces the Enable command itself on activation rather than relying on the
 * user already knowing it exists from the README or a Command Palette
 * search. Suppression is workspace-scoped (workspaceState), not global --
 * unlike the Claude version-mismatch warning, this is specifically about
 * *this* project not being enabled, so dismissing it here shouldn't silently
 * suppress it in every other project too.
 */
export async function maybeShowEnablePrompt(context: vscode.ExtensionContext): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    return; // nothing to enable without a workspace folder to write settings into
  }
  if (context.workspaceState.get<boolean>(SUPPRESS_ENABLE_PROMPT_KEY)) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Terminal Manager is available for this workspace but not enabled. Enable it to start tracking and restoring terminals here.',
    'Enable',
    "Don't show again",
  );
  if (choice === 'Enable') {
    await vscode.commands.executeCommand('terminalManager.enable');
  } else if (choice === "Don't show again") {
    await context.workspaceState.update(SUPPRESS_ENABLE_PROMPT_KEY, true);
  }
}
