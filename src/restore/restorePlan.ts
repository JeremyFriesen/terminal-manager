import { TerminalStateEntry } from '../state/types';

/**
 * skipNameCounts maps a name to how many terminals already open (e.g. ones
 * that survived a window reload) have it, so those slots aren't recreated as
 * duplicates. A count rather than a plain set because names aren't unique --
 * if 2 of 3 saved "pwsh" entries are already open, only those 2 should be
 * skipped, not all 3 recreated or all 3 skipped. Entries are consumed in
 * order, matching the positional-queue adoption on the tracking side.
 */
export function entriesToCreate(terminals: readonly TerminalStateEntry[], skipNameCounts: ReadonlyMap<string, number>): TerminalStateEntry[] {
  const remainingSkips = new Map(skipNameCounts);
  const toCreate: TerminalStateEntry[] = [];

  for (const entry of terminals) {
    const remaining = remainingSkips.get(entry.name) ?? 0;
    if (remaining > 0) {
      remainingSkips.set(entry.name, remaining - 1);
      continue;
    }
    toCreate.push(entry);
  }

  return toCreate;
}

/** What to type into a freshly created terminal to recreate its state, or undefined for a plain terminal (nothing replayed). */
export function resumeCommandFor(entry: TerminalStateEntry): string | undefined {
  switch (entry.kind) {
    case 'claude':
      return entry.resumeMode === 'exact' && entry.sessionId ? `claude --resume ${entry.sessionId}` : 'claude --resume';
    case 'watched-command':
      return entry.command;
    case 'plain':
      return undefined;
  }
}
