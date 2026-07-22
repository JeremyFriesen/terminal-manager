import { describe, it, expect } from 'vitest';
import {
  encodeCwdToProjectDirName,
  isCompatibleClaudeVersion,
  pickCorrelatedSessionFile,
  buildCorrelationResult,
  createCancelToken,
  filterSessionFiles,
  parseClaudeVersionOutput,
  TESTED_CLAUDE_VERSION,
} from './sessionCorrelator';

describe('createCancelToken', () => {
  it('starts out not cancelled', () => {
    expect(createCancelToken()).toEqual({ cancelled: false });
  });

  it('returns a fresh, independent object each call', () => {
    const a = createCancelToken();
    const b = createCancelToken();
    a.cancelled = true;
    expect(b.cancelled).toBe(false);
  });
});

describe('encodeCwdToProjectDirName', () => {
  it('replaces Windows-style separators and the drive-letter colon with dashes', () => {
    expect(encodeCwdToProjectDirName('C:\\Users\\jerem\\Projects\\demo')).toBe('C--Users-jerem-Projects-demo');
  });

  it('replaces POSIX-style separators with dashes', () => {
    expect(encodeCwdToProjectDirName('/Users/jerem/Projects/demo')).toBe('-Users-jerem-Projects-demo');
  });
});

describe('isCompatibleClaudeVersion', () => {
  it('is compatible when the major version matches the tested version', () => {
    expect(isCompatibleClaudeVersion('2.1.216')).toBe(true);
    expect(isCompatibleClaudeVersion('2.9.0')).toBe(true);
  });

  it('is incompatible when the major version differs', () => {
    expect(isCompatibleClaudeVersion('3.0.0')).toBe(false);
    expect(isCompatibleClaudeVersion('1.9.9')).toBe(false);
  });

  it('is incompatible when the version is unknown', () => {
    expect(isCompatibleClaudeVersion(undefined)).toBe(false);
  });
});

describe('pickCorrelatedSessionFile', () => {
  const before = new Map([
    ['a.jsonl', 100],
    ['b.jsonl', 100],
  ]);

  it('reports none-yet when nothing new appeared and nothing existing changed', () => {
    expect(pickCorrelatedSessionFile(new Map([['a.jsonl', 100], ['b.jsonl', 100]]), before)).toEqual({ status: 'none-yet' });
  });

  it('finds the single new session file and strips the extension', () => {
    const current = new Map([...before, ['c.jsonl', 200]]);
    expect(pickCorrelatedSessionFile(current, before)).toEqual({ status: 'found', sessionId: 'c' });
  });

  it('is ambiguous when more than one new file appears at once', () => {
    const current = new Map([...before, ['c.jsonl', 200], ['d.jsonl', 200]]);
    expect(pickCorrelatedSessionFile(current, before)).toEqual({ status: 'ambiguous' });
  });

  it('reports none-yet when the directory is empty relative to a nonexistent before-map', () => {
    expect(pickCorrelatedSessionFile(new Map(), new Map())).toEqual({ status: 'none-yet' });
  });

  it('finds a new file when nothing existed before', () => {
    expect(pickCorrelatedSessionFile(new Map([['only.jsonl', 100]]), new Map())).toEqual({ status: 'found', sessionId: 'only' });
  });

  // The scenario that was silently broken before this existed: resuming an
  // existing session via the interactive `claude --resume` picker never
  // creates a new file, so this is the only signal that can ever correlate
  // it -- without it, a terminal already in interactive-fallback mode could
  // never reach "exact", no matter how many times it was restored.
  it('finds a session by an existing file being touched, when no new file appeared', () => {
    const current = new Map([['a.jsonl', 500], ['b.jsonl', 100]]); // a.jsonl's mtime advanced
    expect(pickCorrelatedSessionFile(current, before)).toEqual({ status: 'found', sessionId: 'a' });
  });

  it('is ambiguous when more than one existing file is touched at once', () => {
    const current = new Map([['a.jsonl', 500], ['b.jsonl', 500]]);
    expect(pickCorrelatedSessionFile(current, before)).toEqual({ status: 'ambiguous' });
  });

  it('does not treat an unchanged existing file as touched', () => {
    const current = new Map([['a.jsonl', 100], ['b.jsonl', 100]]);
    expect(pickCorrelatedSessionFile(current, before)).toEqual({ status: 'none-yet' });
  });

  it('prefers a new file over a touched existing one when both are present', () => {
    const current = new Map([['a.jsonl', 500], ['b.jsonl', 100], ['c.jsonl', 200]]);
    expect(pickCorrelatedSessionFile(current, before)).toEqual({ status: 'found', sessionId: 'c' });
  });
});

describe('buildCorrelationResult', () => {
  it('falls back with a version-mismatch warning when the installed version is incompatible', () => {
    const result = buildCorrelationResult('3.0.0', undefined, false);
    expect(result.resumeMode).toBe('interactive-fallback');
    expect(result.sessionId).toBeUndefined();
    expect(result.warning).toContain('3.0.0');
    expect(result.warning).toContain(TESTED_CLAUDE_VERSION);
  });

  it('falls back with a version-mismatch warning when the version is unknown, even if a sessionId was somehow found', () => {
    // Version incompatibility is checked first -- an unknown/incompatible
    // installed version should never be trusted with an "exact" result.
    const result = buildCorrelationResult(undefined, 'abc-123', false);
    expect(result.resumeMode).toBe('interactive-fallback');
    expect(result.warning).toContain('unknown');
  });

  it('falls back with a "could not identify" warning when no session was found and it was not cancelled', () => {
    const result = buildCorrelationResult(TESTED_CLAUDE_VERSION, undefined, false);
    expect(result.resumeMode).toBe('interactive-fallback');
    expect(result.warning).toMatch(/could not uniquely identify/i);
  });

  it('falls back with no warning when no session was found because it was cancelled', () => {
    const result = buildCorrelationResult(TESTED_CLAUDE_VERSION, undefined, true);
    expect(result.resumeMode).toBe('interactive-fallback');
    expect(result.warning).toBeUndefined();
  });

  it('resolves exact when the version is compatible and a session id was found', () => {
    const result = buildCorrelationResult(TESTED_CLAUDE_VERSION, 'abc-123', false);
    expect(result).toEqual({ sessionId: 'abc-123', resumeMode: 'exact' });
  });
});

describe('filterSessionFiles', () => {
  it('keeps only .jsonl files', () => {
    expect(filterSessionFiles(['a.jsonl', 'b.txt', 'c.jsonl', '.DS_Store'])).toEqual(new Set(['a.jsonl', 'c.jsonl']));
  });

  it('returns an empty set for no matches', () => {
    expect(filterSessionFiles(['readme.md'])).toEqual(new Set());
  });

  it('returns an empty set for an empty list', () => {
    expect(filterSessionFiles([])).toEqual(new Set());
  });
});

describe('parseClaudeVersionOutput', () => {
  it('extracts the version from real-shaped output', () => {
    expect(parseClaudeVersionOutput('2.1.216 (Claude Code)')).toBe('2.1.216');
  });

  it('returns undefined when no version-shaped substring is present', () => {
    expect(parseClaudeVersionOutput('command not found')).toBeUndefined();
  });

  it('extracts the first version-shaped substring if the output has extra text before it', () => {
    expect(parseClaudeVersionOutput('Checking for updates...\n2.1.216 (Claude Code)')).toBe('2.1.216');
  });
});
