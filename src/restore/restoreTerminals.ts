import * as vscode from 'vscode';
import { StateRepository } from '../state/storage';
import { entriesToCreate, resumeCommandFor } from './restorePlan';
import { sleep } from '../sleep';

export async function restoreTerminals(repository: StateRepository, skipNameCounts: ReadonlyMap<string, number> = new Map()): Promise<void> {
  const state = await repository.load();
  const toCreate = entriesToCreate(state.terminals, skipNameCounts);
  const staggerMs = vscode.workspace.getConfiguration('terminalManager').get<number>('restoreStaggerMs', 150);

  // Staggered rather than a tight loop -- restoring many terminals at once
  // (each a real OS process spawn, more so for claude/kubectl/ssh entries)
  // would otherwise spike CPU and spawn everything in one burst.
  for (let i = 0; i < toCreate.length; i++) {
    const entry = toCreate[i];
    const terminal = vscode.window.createTerminal({ name: entry.name, cwd: entry.cwd });
    const command = resumeCommandFor(entry);
    if (command) {
      terminal.sendText(command);
    }
    if (staggerMs > 0 && i < toCreate.length - 1) {
      await sleep(staggerMs);
    }
  }
}
