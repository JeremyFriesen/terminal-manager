import * as vscode from 'vscode';
import { WorkspaceTerminalState, emptyState, parseState } from './types';

export interface StateRepository {
  load(): Promise<WorkspaceTerminalState>;
  save(state: WorkspaceTerminalState): Promise<void>;
  /** The file this repository reads/writes, if resolvable right now -- used to recognize an external write to it (e.g. an editor save) as distinct from our own. */
  fileUri(): vscode.Uri | undefined;
}

class WorkspaceFileStateRepository implements StateRepository {
  fileUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      return undefined;
    }
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'terminal-state.json');
  }

  async load(): Promise<WorkspaceTerminalState> {
    const uri = this.fileUri();
    if (!uri) {
      return emptyState();
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return parseState(Buffer.from(bytes).toString('utf8'));
    } catch {
      return emptyState();
    }
  }

  async save(state: WorkspaceTerminalState): Promise<void> {
    const uri = this.fileUri();
    if (!uri) {
      return;
    }
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    const bytes = Buffer.from(JSON.stringify(state, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(uri, bytes);
  }
}

export function createStateRepository(): StateRepository {
  return new WorkspaceFileStateRepository();
}
