import { TerminalStateEntry } from '../state/types';
import { classifyCommand, classifyTerminalName, extractResumeSessionId } from './classify';
import { redactSecrets } from './redact';

/**
 * Groups saved entries by name into per-name queues, for matching rediscovered
 * (post-reload) terminals back to their saved kind. A queue rather than a
 * single value because terminal names aren't unique -- entries sharing a name
 * are consumed in order (first live terminal with that name gets the first
 * queued entry) rather than collapsed onto one, which would misattribute kind
 * whenever 2+ terminals share a name.
 */
export function buildNameQueues(entries: readonly TerminalStateEntry[]): Map<string, TerminalStateEntry[]> {
  const byName = new Map<string, TerminalStateEntry[]>();
  for (const entry of entries) {
    const queue = byName.get(entry.name);
    if (queue) {
      queue.push(entry);
    } else {
      byName.set(entry.name, [entry]);
    }
  }
  return byName;
}

/**
 * Picks which queued same-name candidate a rediscovered terminal should
 * adopt. Prefers an exact pid match (VS Code persists the underlying process
 * -- and its pid -- across a `Ctrl+R` reload, so this is a near-certain
 * identity match when available) over the positional first-in-queue
 * fallback. Mutates `candidates` by removing whichever entry is returned, to
 * match the existing `.shift()` queue-consumption behavior. `undefined` pid
 * (not yet resolved, or genuinely unavailable) or no pid match both fall back
 * to position, same as if pid tracking didn't exist at all.
 */
export function pickBestAdoptionMatch(candidates: TerminalStateEntry[] | undefined, pid: number | undefined): TerminalStateEntry | undefined {
  if (!candidates || candidates.length === 0) {
    return undefined;
  }
  if (pid !== undefined) {
    const pidMatchIndex = candidates.findIndex((c) => c.pid === pid);
    if (pidMatchIndex !== -1) {
      return candidates.splice(pidMatchIndex, 1)[0];
    }
  }
  return candidates.shift();
}

/**
 * Classifies a just-started shell command into the entry it should produce.
 * The stored `command` is redacted -- restoring a terminal whose command
 * contained a secret will replay a broken/incomplete command rather than a
 * working one, which is the intended tradeoff: never keep a secret readable
 * on disk just to make one-click resume more convenient.
 */
export function buildEntryForCommand(commandLine: string, name: string, cwd: string): TerminalStateEntry {
  const classification = classifyCommand(commandLine);
  switch (classification.kind) {
    case 'watched-command':
      return { kind: 'watched-command', name, cwd, label: classification.label, command: redactSecrets(commandLine) };
    case 'claude': {
      const sessionId = extractResumeSessionId(commandLine);
      return sessionId
        ? { kind: 'claude', name, cwd, sessionId, resumeMode: 'exact' }
        : { kind: 'claude', name, cwd, resumeMode: 'interactive-fallback' };
    }
    case 'plain':
      return { kind: 'plain', name, cwd };
  }
}

/**
 * Called for a genuinely new terminal (no saved entry to adopt) at open time.
 * Most terminals only get classified later once a command actually runs in
 * them (see buildEntryForCommand), but some -- e.g. Container Tools' "View
 * Logs", which runs as a VS Code Task rather than an interactive shell
 * command -- never fire a shell-execution event at all. The terminal's name
 * is the only signal available for those, so it's checked here before
 * defaulting to plain.
 */
export function buildEntryForNewTerminal(name: string, cwd: string): TerminalStateEntry {
  const named = classifyTerminalName(name);
  if (named) {
    return { kind: 'watched-command', name, cwd, label: named.label, command: redactSecrets(named.command) };
  }
  return { kind: 'plain', name, cwd };
}

/**
 * The tracked command (claude, docker logs -f, ...) has returned control to
 * the shell prompt, so the terminal reverts to plain until another command
 * reclassifies it. Returns undefined if there's nothing to change (no
 * existing entry, or it was already plain). This is also how a Claude session
 * ended via its own `/exit` (not a new shell command, so nothing else re-fires)
 * gets reflected.
 */
export function revertToPlainOnCommandEnd(existing: TerminalStateEntry | undefined, currentName: string): TerminalStateEntry | undefined {
  if (!existing || existing.kind === 'plain') {
    return undefined;
  }
  return { kind: 'plain', name: currentName, cwd: existing.cwd };
}

/**
 * VS Code has no onDidChangeTerminalName event, so a manual "Rename..." is
 * only detectable by polling Terminal.name against what's stored. Returns
 * undefined if nothing changed.
 */
export function renamedEntry(currentName: string, entry: TerminalStateEntry): TerminalStateEntry | undefined {
  if (currentName === entry.name) {
    return undefined;
  }
  return { ...entry, name: currentName };
}

/**
 * Whether a just-classified entry still needs the background session-file
 * poll. Already-exact entries (an explicit `--resume <id>` was in the
 * command line -- see extractResumeSessionId) skip it entirely: polling
 * would never succeed for those anyway, since resuming appends to the
 * existing session file rather than creating a new one.
 */
export function needsClaudeCorrelation(entry: TerminalStateEntry): boolean {
  return entry.kind === 'claude' && entry.resumeMode !== 'exact';
}
