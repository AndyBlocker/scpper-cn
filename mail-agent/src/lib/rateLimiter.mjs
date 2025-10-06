class SlidingWindowRateLimiter {
  constructor({ windowMs, max }) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error('[mail-agent] windowMs must be a positive number');
    }
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error('[mail-agent] max must be a positive number');
    }
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map();
  }

  consume(key) {
    const now = Date.now();
    const entries = this._prune(key, now);

    if (entries.length >= this.max) {
      const oldest = entries[0];
      const retryAfterMs = Math.max(0, this.windowMs - (now - oldest));
      return {
        allowed: false,
        retryAfterMs,
        remaining: 0
      };
    }

    entries.push(now);
    this.buckets.set(key, entries);

    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.max(0, this.max - entries.length)
    };
  }

  _prune(key, now) {
    const stored = this.buckets.get(key);
    if (!stored || stored.length === 0) {
      return [];
    }
    const fresh = stored.filter((timestamp) => now - timestamp < this.windowMs);
    if (fresh.length === 0) {
      this.buckets.delete(key);
      return [];
    }
    this.buckets.set(key, fresh);
    return fresh;
  }
}

export class RateLimiterManager {
  constructor(defaultConfig, overrides = {}) {
    this.defaultConfig = defaultConfig;
    this.overrides = overrides;
    this.limiters = new Map();
  }

  _getLimiter(type) {
    const limiterKey = type || '__default__';
    if (this.limiters.has(limiterKey)) {
      return this.limiters.get(limiterKey);
    }
    const override = type ? this.overrides[type] : undefined;
    const config = override || this.defaultConfig;
    const limiter = new SlidingWindowRateLimiter(config);
    this.limiters.set(limiterKey, limiter);
    return limiter;
  }

  consume(key, type) {
    const limiter = this._getLimiter(type);
    return limiter.consume(key);
  }
}
