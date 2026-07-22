import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

let channel: vscode.OutputChannel | undefined;
let logFilePath: string | undefined;

/**
 * The Output channel is always on -- standard, expected extension behavior,
 * with no disk cost unless a user opens it. File logging is opt-in
 * (terminalManager.debugLogging, off by default) because unlike the Output
 * channel its content survives a window close, which is exactly why it's
 * useful for diagnosing cross-window-lifecycle behavior -- but it also grows
 * unboundedly with no rotation, which isn't something to inflict on every
 * user's workspace by default.
 */
export function initLogging(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('Terminal Manager');
  context.subscriptions.push(channel);

  const debugLogging = vscode.workspace.getConfiguration('terminalManager').get<boolean>('debugLogging', false);
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (debugLogging && folder) {
    const dir = path.join(folder.uri.fsPath, '.vscode');
    try {
      fs.mkdirSync(dir, { recursive: true });
      logFilePath = path.join(dir, 'terminal-manager.log');
    } catch {
      logFilePath = undefined;
    }
  }
}

export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  channel?.appendLine(message);
  if (logFilePath) {
    // Fire-and-forget async, not sync -- a burst of events (e.g. a large
    // restore) would otherwise serialize on blocking disk I/O for every
    // single one. Ordering between concurrent writes isn't guaranteed, which
    // is fine for a best-effort debug log.
    void fsPromises.appendFile(logFilePath, line + '\n').catch(() => {
      // best effort -- logging must never break the extension
    });
  }
}
