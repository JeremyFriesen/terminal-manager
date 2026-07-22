import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

export const EXTENSION_ID = 'jeremyfriesen.terminal-manager';

export async function activateExtension(): Promise<vscode.Extension<unknown>> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) {
    throw new Error(`Extension ${EXTENSION_ID} not found -- is it built and is the fixture workspace loaded via .vscode-test.mjs?`);
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext;
}

interface RawStateFile {
  version: number;
  savedAt: string;
  terminals: Array<Record<string, unknown>>;
}

export function stateFilePath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder open -- fixture workspace failed to load.');
  }
  return path.join(folder.uri.fsPath, '.vscode', 'terminal-state.json');
}

export async function readStateFile(): Promise<RawStateFile | undefined> {
  try {
    const raw = await fs.readFile(stateFilePath(), 'utf8');
    return JSON.parse(raw) as RawStateFile;
  } catch {
    return undefined;
  }
}

export async function writeStateFile(terminals: Array<Record<string, unknown>>): Promise<void> {
  const file = stateFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const content: RawStateFile = { version: 1, savedAt: new Date().toISOString(), terminals };
  await fs.writeFile(file, JSON.stringify(content, null, 2), 'utf8');
}

export async function deleteStateFile(): Promise<void> {
  await fs.rm(stateFilePath(), { force: true });
}

/** Polls `predicate` until it returns true, or throws once `timeoutMs` elapses -- there's no event to await for most of what these tests wait on (debounced saves, shell integration coming up, restored terminals appearing). */
export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10000, intervalMs = 200): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms${lastError ? ` (last error: ${String(lastError)})` : ''}`);
}

export function closeAllTerminals(): void {
  for (const terminal of vscode.window.terminals) {
    terminal.dispose();
  }
}
