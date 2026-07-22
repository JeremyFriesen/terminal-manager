/**
 * `pid` is the OS process id of the terminal's shell at the time it was last
 * saved, when resolvable. It does NOT survive a full close+reopen (a fresh
 * process gets a new, unpredictable pid) -- it's only meaningful for matching
 * a terminal rediscovered after a `Ctrl+R` reload back to the right saved
 * entry, since VS Code persists the underlying process (and therefore its
 * pid) across a reload. Purely a disambiguation aid on top of name matching,
 * never a substitute for it (a saved entry with no recorded pid, or a
 * rediscovered terminal whose pid isn't resolvable yet, both fall back to the
 * existing positional-queue-by-name behavior).
 */
export type TerminalStateEntry =
  | {
      kind: 'claude';
      name: string;
      cwd: string;
      sessionId?: string;
      resumeMode: 'exact' | 'interactive-fallback';
      pid?: number;
    }
  | {
      kind: 'watched-command';
      name: string;
      cwd: string;
      command: string;
      /** Which pattern matched, e.g. "docker logs", "kubectl logs", "ssh" -- informational only. */
      label: string;
      pid?: number;
    }
  | {
      kind: 'plain';
      name: string;
      cwd: string;
      pid?: number;
    };

export interface WorkspaceTerminalState {
  version: 1;
  savedAt: string;
  terminals: TerminalStateEntry[];
}

export function emptyState(): WorkspaceTerminalState {
  return { version: 1, savedAt: new Date().toISOString(), terminals: [] };
}

/**
 * Interprets raw file content as state, falling back to empty for anything
 * that isn't recognizable (missing file, invalid JSON, wrong shape, a future
 * version this build doesn't know about). Pulled out of the repository's
 * load() specifically so this decision is testable without real file I/O.
 */
export function parseState(raw: string): WorkspaceTerminalState {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.terminals)) {
      return parsed as WorkspaceTerminalState;
    }
  } catch {
    // fall through to empty
  }
  return emptyState();
}

/**
 * VS Code does not revive terminal processes across a full window close (only
 * across a reload), so onDidCloseTerminal fires for every terminal as the
 * window goes down -- indistinguishable, from passive tracking, from the user
 * genuinely closing every terminal by hand. Refusing to persist "nothing"
 * through passive tracking means a window close can't wipe out what should be
 * restored next time; only the explicit "Clear Saved Terminal State" command
 * bypasses this and produces an empty file.
 */
export function shouldPersist(state: WorkspaceTerminalState): boolean {
  return state.terminals.length > 0;
}
