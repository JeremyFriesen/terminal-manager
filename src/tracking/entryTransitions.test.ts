import { describe, it, expect } from 'vitest';
import {
  buildNameQueues,
  buildEntryForCommand,
  buildEntryForNewTerminal,
  revertToPlainOnCommandEnd,
  renamedEntry,
  needsClaudeCorrelation,
  pickBestAdoptionMatch,
} from './entryTransitions';
import { TerminalStateEntry } from '../state/types';

describe('buildNameQueues', () => {
  it('groups a single entry per name', () => {
    const entries: TerminalStateEntry[] = [
      { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' },
      { kind: 'watched-command', name: 'docker', cwd: 'C:\\repo', command: 'docker logs -f a', label: 'docker logs' },
    ];
    const queues = buildNameQueues(entries);
    expect(queues.get('pwsh')).toEqual([entries[0]]);
    expect(queues.get('docker')).toEqual([entries[1]]);
  });

  it('preserves order for entries sharing a name', () => {
    const first: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };
    const second: TerminalStateEntry = { kind: 'claude', name: 'pwsh', cwd: 'C:\\repo', resumeMode: 'interactive-fallback' };
    const queues = buildNameQueues([first, second]);
    expect(queues.get('pwsh')).toEqual([first, second]);
  });

  it('returns an empty map for no entries', () => {
    expect(buildNameQueues([]).size).toBe(0);
  });
});

describe('buildEntryForCommand', () => {
  it('builds a claude entry defaulting to the interactive fallback', () => {
    expect(buildEntryForCommand('claude --resume abc', 'my-term', 'C:\\repo')).toEqual({
      kind: 'claude',
      name: 'my-term',
      cwd: 'C:\\repo',
      resumeMode: 'interactive-fallback',
    });
  });

  it('builds an exact-mode claude entry immediately when --resume already names a session id', () => {
    expect(buildEntryForCommand('claude --resume 68b141fc-fb9e-46ce-bb39-3b68f8e1ed98', 'my-term', 'C:\\repo')).toEqual({
      kind: 'claude',
      name: 'my-term',
      cwd: 'C:\\repo',
      sessionId: '68b141fc-fb9e-46ce-bb39-3b68f8e1ed98',
      resumeMode: 'exact',
    });
  });

  it('builds a watched-command entry capturing the exact command and its label', () => {
    expect(buildEntryForCommand('docker logs -f web', 'docker', 'C:\\repo')).toEqual({
      kind: 'watched-command',
      name: 'docker',
      cwd: 'C:\\repo',
      label: 'docker logs',
      command: 'docker logs -f web',
    });
  });

  it('redacts a secret in the stored command', () => {
    const entry = buildEntryForCommand('docker logs -f web --since API_KEY=sk-abc123', 'docker', 'C:\\repo');
    expect(entry.kind).toBe('watched-command');
    if (entry.kind === 'watched-command') {
      expect(entry.command).not.toContain('sk-abc123');
      expect(entry.command).toContain('***REDACTED***');
    }
  });

  it('builds a plain entry for anything else', () => {
    expect(buildEntryForCommand('git status', 'pwsh', 'C:\\repo')).toEqual({
      kind: 'plain',
      name: 'pwsh',
      cwd: 'C:\\repo',
    });
  });
});

describe('buildEntryForNewTerminal', () => {
  it('classifies a Container Tools "View Logs" terminal from its name alone', () => {
    expect(buildEntryForNewTerminal('Logs: app-postgres', 'C:\\repo')).toEqual({
      kind: 'watched-command',
      name: 'Logs: app-postgres',
      cwd: 'C:\\repo',
      label: 'docker logs',
      command: 'docker logs -f "app-postgres"',
    });
  });

  it('builds a plain entry for an ordinary terminal name', () => {
    expect(buildEntryForNewTerminal('pwsh', 'C:\\repo')).toEqual({
      kind: 'plain',
      name: 'pwsh',
      cwd: 'C:\\repo',
    });
  });
});

describe('revertToPlainOnCommandEnd', () => {
  it('reverts a claude entry to plain, keeping its cwd and the current name', () => {
    const existing: TerminalStateEntry = {
      kind: 'claude',
      name: 'old-name',
      cwd: 'C:\\repo',
      sessionId: 'abc',
      resumeMode: 'exact',
    };
    expect(revertToPlainOnCommandEnd(existing, 'new-name')).toEqual({
      kind: 'plain',
      name: 'new-name',
      cwd: 'C:\\repo',
    });
  });

  it('reverts a watched-command entry to plain', () => {
    const existing: TerminalStateEntry = {
      kind: 'watched-command',
      name: 'docker',
      cwd: 'C:\\repo',
      command: 'docker logs -f web',
      label: 'docker logs',
    };
    expect(revertToPlainOnCommandEnd(existing, 'docker')).toEqual({ kind: 'plain', name: 'docker', cwd: 'C:\\repo' });
  });

  it('does nothing when already plain', () => {
    const existing: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };
    expect(revertToPlainOnCommandEnd(existing, 'pwsh')).toBeUndefined();
  });

  it('does nothing when there is no existing entry', () => {
    expect(revertToPlainOnCommandEnd(undefined, 'pwsh')).toBeUndefined();
  });
});

describe('renamedEntry', () => {
  it('returns an updated entry when the name changed', () => {
    const entry: TerminalStateEntry = { kind: 'plain', name: 'old', cwd: 'C:\\repo' };
    expect(renamedEntry('new', entry)).toEqual({ kind: 'plain', name: 'new', cwd: 'C:\\repo' });
  });

  it('returns undefined when the name is unchanged', () => {
    const entry: TerminalStateEntry = { kind: 'plain', name: 'same', cwd: 'C:\\repo' };
    expect(renamedEntry('same', entry)).toBeUndefined();
  });

  it('preserves kind-specific fields when renaming', () => {
    const entry: TerminalStateEntry = {
      kind: 'watched-command',
      name: 'old',
      cwd: 'C:\\repo',
      command: 'docker logs -f web',
      label: 'docker logs',
    };
    expect(renamedEntry('new', entry)).toEqual({
      kind: 'watched-command',
      name: 'new',
      cwd: 'C:\\repo',
      command: 'docker logs -f web',
      label: 'docker logs',
    });
  });
});

describe('needsClaudeCorrelation', () => {
  it('is true for a claude entry still in interactive-fallback', () => {
    const entry: TerminalStateEntry = { kind: 'claude', name: 'pwsh', cwd: 'C:\\repo', resumeMode: 'interactive-fallback' };
    expect(needsClaudeCorrelation(entry)).toBe(true);
  });

  it('is false for a claude entry already resolved to exact', () => {
    const entry: TerminalStateEntry = {
      kind: 'claude',
      name: 'pwsh',
      cwd: 'C:\\repo',
      sessionId: 'abc-123',
      resumeMode: 'exact',
    };
    expect(needsClaudeCorrelation(entry)).toBe(false);
  });

  it('is false for non-claude entries', () => {
    expect(needsClaudeCorrelation({ kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' })).toBe(false);
    expect(
      needsClaudeCorrelation({ kind: 'watched-command', name: 'docker', cwd: 'C:\\repo', command: 'docker logs -f a', label: 'docker logs' }),
    ).toBe(false);
  });
});

describe('pickBestAdoptionMatch', () => {
  it('returns undefined when there are no candidates', () => {
    expect(pickBestAdoptionMatch(undefined, 123)).toBeUndefined();
    expect(pickBestAdoptionMatch([], 123)).toBeUndefined();
  });

  it('falls back to positional (first-in-queue) when pid is undefined', () => {
    const first: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo', pid: 111 };
    const second: TerminalStateEntry = { kind: 'claude', name: 'pwsh', cwd: 'C:\\repo', resumeMode: 'interactive-fallback', pid: 222 };
    const candidates = [first, second];
    expect(pickBestAdoptionMatch(candidates, undefined)).toBe(first);
    expect(candidates).toEqual([second]); // consumed from the queue
  });

  it('falls back to positional when no candidate has a matching pid', () => {
    const first: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo', pid: 111 };
    const second: TerminalStateEntry = { kind: 'claude', name: 'pwsh', cwd: 'C:\\repo', resumeMode: 'interactive-fallback', pid: 222 };
    const candidates = [first, second];
    expect(pickBestAdoptionMatch(candidates, 999)).toBe(first);
  });

  it('prefers an exact pid match over position, even if it is not first in the queue', () => {
    const first: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo', pid: 111 };
    const second: TerminalStateEntry = { kind: 'claude', name: 'pwsh', cwd: 'C:\\repo', resumeMode: 'interactive-fallback', pid: 222 };
    const third: TerminalStateEntry = { kind: 'watched-command', name: 'pwsh', cwd: 'C:\\repo', command: 'docker logs -f a', label: 'docker logs', pid: 333 };
    const candidates = [first, second, third];

    expect(pickBestAdoptionMatch(candidates, 333)).toBe(third);
    // Only the matched entry was removed -- the other two remain, in their original order.
    expect(candidates).toEqual([first, second]);
  });

  it('falls back to position when candidates have no recorded pid at all', () => {
    const first: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };
    const candidates = [first];
    expect(pickBestAdoptionMatch(candidates, 123)).toBe(first);
  });
});
