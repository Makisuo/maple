/**
 * Shared TTL map for this app's small, credential-bearing in-memory caches.
 *
 * A plain `Map<string, { expiresAt }>` never actually forgets anything: an
 * entry is only ever replaced by a fresh lookup for the SAME key, so a key
 * that stops being looked up — a workspace that uninstalled the app, a thread
 * that went quiet — stays resident for the life of the process. "Expired"
 * ends up meaning "not served" rather than "gone", which is fine for a
 * boolean and not fine for the workspace cache, whose entries hold a
 * decrypted Slack bot token and a full-access Maple API key.
 *
 * So expiry is enforced three ways:
 *   - on read: an expired entry is deleted, not just ignored;
 *   - on write: a full sweep of expired entries (rate-limited to once per
 *     `sweepIntervalMs` so a hot cache doesn't walk itself on every set),
 *     plus oldest-insertion eviction once `maxEntries` is reached, so the map
 *     cannot grow without bound even if nothing has expired yet;
 *   - in the background: a self-stopping timer sweep, so a process that goes
 *     idle — the case no access-triggered sweep can ever reach — does not sit
 *     on live-ish credentials until the next event arrives. The timer is
 *     `unref`'d and clears itself once the cache is empty, so it neither
 *     holds the process open nor ticks forever on an unused cache.
 */

export interface TtlCacheEntry {
  /** Epoch ms after which the entry must no longer be served — or retained. */
  readonly expiresAt: number;
}

export interface TtlCache<V extends TtlCacheEntry> {
  /** The live entry for `key`, or undefined when absent or expired. */
  get(key: string): V | undefined;
  set(key: string, entry: V): void;
  /** Drops every entry and stops the background sweep. */
  clear(): void;
  /** Entry count including any not-yet-swept expired ones (tests/diagnostics). */
  readonly size: number;
}

export function createTtlCache<V extends TtlCacheEntry>(options: {
  /** Hard cap; reaching it evicts oldest insertions first. */
  readonly maxEntries: number;
  /** Minimum gap between full sweeps (also the background sweep period). */
  readonly sweepIntervalMs: number;
}): TtlCache<V> {
  const entries = new Map<string, V>();
  let nextSweepAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function sweep(now: number): void {
    nextSweepAt = now + options.sweepIntervalMs;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function stopTimer(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  function startTimer(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      sweep(Date.now());
      if (entries.size === 0) stopTimer();
    }, options.sweepIntervalMs);
    // Never keep the process alive for a cache sweep.
    timer.unref?.();
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry;
    },

    set(key, entry) {
      const now = Date.now();
      if (now >= nextSweepAt || entries.size >= options.maxEntries) sweep(now);
      // Still at the cap after dropping expired entries: evict oldest
      // insertions so a workspace/thread explosion cannot grow the map without
      // bound. Deleting `key` first keeps a refresh from evicting a stranger.
      entries.delete(key);
      while (entries.size >= options.maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(key, entry);
      startTimer();
    },

    clear() {
      entries.clear();
      nextSweepAt = 0;
      stopTimer();
    },

    get size() {
      return entries.size;
    },
  };
}
