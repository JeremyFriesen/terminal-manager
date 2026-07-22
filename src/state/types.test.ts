import { describe, it, expect } from 'vitest';
import { emptyState, shouldPersist, parseState, TerminalStateEntry } from './types';

const plain: TerminalStateEntry = { kind: 'plain', name: 'pwsh', cwd: 'C:\\repo' };

describe('emptyState', () => {
  it('has version 1 and no terminals', () => {
    const state = emptyState();
    expect(state.version).toBe(1);
    expect(state.terminals).toEqual([]);
  });

  it('stamps a fresh ISO timestamp', () => {
    expect(() => new Date(emptyState().savedAt).toISOString()).not.toThrow();
  });
});

describe('shouldPersist', () => {
  it('refuses to persist an empty terminal list', () => {
    expect(shouldPersist(emptyState())).toBe(false);
  });

  it('persists when there is at least one entry', () => {
    const state = emptyState();
    state.terminals = [plain];
    expect(shouldPersist(state)).toBe(true);
  });
});

describe('parseState', () => {
  it('parses valid, well-formed state', () => {
    const raw = JSON.stringify({ version: 1, savedAt: '2026-01-01T00:00:00.000Z', terminals: [plain] });
    expect(parseState(raw)).toEqual({ version: 1, savedAt: '2026-01-01T00:00:00.000Z', terminals: [plain] });
  });

  it('falls back to empty for invalid JSON', () => {
    expect(parseState('{not valid json')).toEqual(expect.objectContaining({ version: 1, terminals: [] }));
  });

  it('falls back to empty for valid JSON with the wrong shape', () => {
    expect(parseState('{"hello":"world"}')).toEqual(expect.objectContaining({ version: 1, terminals: [] }));
  });

  it('falls back to empty for a terminals field that is not an array', () => {
    expect(parseState('{"version":1,"terminals":"nope"}')).toEqual(expect.objectContaining({ version: 1, terminals: [] }));
  });

  it('falls back to empty for an unrecognized future version', () => {
    expect(parseState('{"version":2,"terminals":[]}')).toEqual(expect.objectContaining({ version: 1, terminals: [] }));
  });

  it('falls back to empty for an empty string', () => {
    expect(parseState('')).toEqual(expect.objectContaining({ version: 1, terminals: [] }));
  });
});
