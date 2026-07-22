const POLL_INTERVAL_MS = 2000;

interface PollerEntry {
  timer: ReturnType<typeof setInterval>;
  subscribers: Set<(files: Map<string, number>) => void>;
}

const pollers = new Map<string, PollerEntry>();

/** Exposed for tests -- how many distinct cwds currently have an active poller. */
export function activePollerCount(): number {
  return pollers.size;
}

/**
 * Multiple claude terminals restoring into the same cwd used to each run
 * their own independent `readdirSync` poll loop -- N terminals meant N
 * redundant directory listings every 2s. This shares one poller per cwd
 * across however many callers are waiting on it, notifying all of them from
 * a single underlying read.
 *
 * Generic over `pollFn` (rather than reaching for a specific filesystem call
 * itself) so it has no dependency on Claude specifics and can be unit tested
 * without touching disk or `os.homedir()`.
 */
export function subscribeToSessionFiles(
  cwd: string,
  onUpdate: (files: Map<string, number>) => void,
  pollFn: (cwd: string) => Map<string, number>,
): () => void {
  let entry = pollers.get(cwd);
  if (!entry) {
    const subscribers = new Set<(files: Map<string, number>) => void>();
    const timer = setInterval(() => {
      const files = pollFn(cwd);
      for (const subscriber of subscribers) {
        subscriber(files);
      }
    }, POLL_INTERVAL_MS);
    entry = { timer, subscribers };
    pollers.set(cwd, entry);
  }
  entry.subscribers.add(onUpdate);

  // Deferred, not synchronous: lets the caller finish assigning its own
  // unsubscribe handle before the first update can possibly arrive, so an
  // immediate match can't fire before there's anything to call to clean up.
  setTimeout(() => onUpdate(pollFn(cwd)), 0);

  return () => {
    const current = pollers.get(cwd);
    if (!current) {
      return;
    }
    current.subscribers.delete(onUpdate);
    if (current.subscribers.size === 0) {
      clearInterval(current.timer);
      pollers.delete(cwd);
    }
  };
}
