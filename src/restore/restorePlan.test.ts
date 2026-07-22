import { describe, it, expect } from 'vitest';
import { entriesToCreate, resumeCommandFor } from './restorePlan';
import { TerminalStateEntry } from '../state/types';

const claudeExact: TerminalStateEntry = {
  kind: 'claude',
  name: 'claude',
  cwd: 'C:\\repo',
  sessionId: 'abc-123',
  resumeMode: 'exact',
};
const claudeFallback: TerminalStateEntry = { kind: 'claude', name: 'claude', cwd: 'C:\\repo', resumeMode: 'interactive-fallback' };
const dockerLogs: TerminalStateEntry = {
  kind: 'watched-command',
  name: 'docker',
  cwd: 'C:\\repo',
  command: 'docker logs -f web',
  label: 'docker logs',
};
const plain: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };

describe('resumeCommandFor', () => {
  it('resumes an exact claude session by id', () => {
    expect(resumeCommandFor(claudeExact)).toBe('claude --resume abc-123');
  });

  it('falls back to the interactive picker when not exact', () => {
    expect(resumeCommandFor(claudeFallback)).toBe('claude --resume');
  });

  it('replays the docker command verbatim', () => {
    expect(resumeCommandFor(dockerLogs)).toBe('docker logs -f web');
  });

  it('sends nothing for a plain terminal', () => {
    expect(resumeCommandFor(plain)).toBeUndefined();
  });
});

describe('entriesToCreate', () => {
  it('creates everything when nothing is already open', () => {
    const result = entriesToCreate([claudeExact, dockerLogs, plain], new Map());
    expect(result).toEqual([claudeExact, dockerLogs, plain]);
  });

  it('skips an entry whose name is already open', () => {
    const result = entriesToCreate([claudeExact, dockerLogs, plain], new Map([['docker', 1]]));
    expect(result).toEqual([claudeExact, plain]);
  });

  it('only skips as many same-named entries as the count allows', () => {
    const pwsh1: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };
    const pwsh2: TerminalStateEntry = {
      kind: 'watched-command',
      name: 'pwsh',
      cwd: 'C:\\repo',
      command: 'docker logs -f a',
      label: 'docker logs',
    };
    const pwsh3: TerminalStateEntry = { kind: 'claude', name: 'pwsh', cwd: 'C:\\repo', resumeMode: 'interactive-fallback' };

    // 2 of the 3 "pwsh"-named terminals are already open -- only the 3rd should be recreated.
    const result = entriesToCreate([pwsh1, pwsh2, pwsh3], new Map([['pwsh', 2]]));
    expect(result).toEqual([pwsh3]);
  });

  it('recreates everything if more are saved than are currently open', () => {
    const pwsh1: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };
    const pwsh2: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };

    const result = entriesToCreate([pwsh1, pwsh2], new Map([['pwsh', 5]]));
    expect(result).toEqual([]);
  });
});
