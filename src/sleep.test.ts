import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sleep } from './sleep';

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not resolve before the given delay', async () => {
    let resolved = false;
    void sleep(1000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);
  });

  it('resolves once the given delay has elapsed', async () => {
    let resolved = false;
    void sleep(1000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(true);
  });
});
