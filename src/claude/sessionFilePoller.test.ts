import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { subscribeToSessionFiles, activePollerCount } from './sessionFilePoller';

describe('subscribeToSessionFiles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shares a single poll per tick across multiple subscribers on the same cwd', () => {
    const pollFn = vi.fn(() => new Map([['a.jsonl', 1]]));
    const updates1: Map<string, number>[] = [];
    const updates2: Map<string, number>[] = [];

    const unsub1 = subscribeToSessionFiles('C:\\repo', (files) => updates1.push(files), pollFn);
    const unsub2 = subscribeToSessionFiles('C:\\repo', (files) => updates2.push(files), pollFn);

    // Flush only the deferred (0ms) immediate checks -- one per subscriber --
    // without also crossing into the interval's first (2000ms-out) tick.
    vi.advanceTimersByTime(0);
    expect(pollFn).toHaveBeenCalledTimes(2);

    pollFn.mockClear();
    vi.advanceTimersByTime(2000);

    // One shared interval tick serves both subscribers from a single poll.
    expect(pollFn).toHaveBeenCalledTimes(1);
    expect(updates1.length).toBeGreaterThan(0);
    expect(updates2.length).toBeGreaterThan(0);

    unsub1();
    unsub2();
  });

  it('runs independent pollers for different cwds', () => {
    const pollFn = vi.fn(() => new Map<string, number>());
    const unsubA = subscribeToSessionFiles('C:\\repo-a', () => {}, pollFn);
    const unsubB = subscribeToSessionFiles('C:\\repo-b', () => {}, pollFn);

    expect(activePollerCount()).toBe(2);

    unsubA();
    expect(activePollerCount()).toBe(1);

    unsubB();
    expect(activePollerCount()).toBe(0);
  });

  it('stops polling once all subscribers for a cwd unsubscribe', () => {
    const pollFn = vi.fn(() => new Map<string, number>());
    const unsub = subscribeToSessionFiles('C:\\repo', () => {}, pollFn);
    vi.runOnlyPendingTimers();
    pollFn.mockClear();

    unsub();

    vi.advanceTimersByTime(10000);
    expect(pollFn).not.toHaveBeenCalled();
  });

  it('does not notify a subscriber after it unsubscribes, even if others remain', () => {
    const pollFn = vi.fn(() => new Map([['a.jsonl', 1]]));
    const updates: Map<string, number>[] = [];

    const unsub1 = subscribeToSessionFiles('C:\\repo', (files) => updates.push(files), pollFn);
    const unsub2 = subscribeToSessionFiles('C:\\repo', () => {}, pollFn);
    vi.runOnlyPendingTimers();

    unsub1();
    updates.length = 0;

    vi.advanceTimersByTime(2000);
    expect(updates).toHaveLength(0);

    unsub2();
  });
});
