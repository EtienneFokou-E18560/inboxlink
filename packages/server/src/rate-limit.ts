/**
 * Lightweight in-process sliding-window rate limiter.
 * Suitable for single-instance / soft abuse guards — not a distributed quota.
 */

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSec: number };

export type RateLimiter = {
  check(key: string): RateLimitResult;
};

export function createRateLimiter(opts: {
  windowMs: number;
  maxRequests: number;
  /** Optional clock for tests. */
  now?: () => number;
}): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const now = opts.now ?? Date.now;

  return {
    check(key: string): RateLimitResult {
      const t = now();
      let bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        bucket = { count: 0, resetAt: t + opts.windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > opts.maxRequests) {
        return {
          ok: false,
          retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)),
        };
      }
      // Bound memory for long-lived processes.
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) {
          if (t >= v.resetAt) buckets.delete(k);
        }
      }
      return { ok: true };
    },
  };
}

/** No-op limiter for single-mode demos and tests that disable abuse guards. */
export function createPassthroughRateLimiter(): RateLimiter {
  return { check: () => ({ ok: true }) };
}
