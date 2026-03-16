/**
 * In-memory sliding-window rate limiter.
 * Suitable for single-instance PM2 deployments.  For horizontal scaling,
 * swap the backing store to Redis.
 */

interface WindowEntry {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  private windowMs: number;
  private maxHits: number;
  private store = new Map<string, WindowEntry>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sweepTimer: any;

  constructor(opts: { windowMs: number; maxHits: number }) {
    this.windowMs = opts.windowMs;
    this.maxHits = opts.maxHits;
    // Periodically evict cold keys to prevent unbounded memory growth
    this.sweepTimer = setInterval(() => this.sweep(), this.windowMs * 2);
    if (typeof this.sweepTimer?.unref === 'function') this.sweepTimer.unref();
  }

  /**
   * Record a hit and return whether the request is allowed.
   * @returns `true` if within limit, `false` if rate-limited.
   */
  hit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }
    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(t => t > cutoff);
    if (entry.timestamps.length >= this.maxHits) {
      return false;
    }
    entry.timestamps.push(now);
    return true;
  }

  /** Return remaining attempts for `key` within the current window. */
  remaining(key: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entry = this.store.get(key);
    if (!entry) return this.maxHits;
    const active = entry.timestamps.filter(t => t > cutoff).length;
    return Math.max(0, this.maxHits - active);
  }

  private sweep() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.store) {
      entry.timestamps = entry.timestamps.filter(t => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.store.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.sweepTimer);
    this.store.clear();
  }
}
