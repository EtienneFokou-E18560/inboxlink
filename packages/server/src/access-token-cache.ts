/**
 * Short-lived Gmail access-token cache, keyed by grant id.
 *
 * In-process only: each Node / Vercel isolate keeps its own Map. Cold starts
 * always miss; multiple concurrent instances do not share entries. Suitable
 * for cutting vault decrypt + Google refresh RTTs on warm hot paths — not a
 * durable or cross-instance store. Never cache refresh tokens here.
 */

export type CachedAccessToken = {
  accessToken: string;
  /** Absolute expiry time (ms since epoch), after skew. */
  expiresAtMs: number;
};

export type AccessTokenCache = {
  get(grantId: string): string | undefined;
  set(grantId: string, accessToken: string, expiresAt?: string): void;
  invalidate(grantId: string): void;
  clear(): void;
  /** Test / ops introspection. */
  size(): number;
};

export type AccessTokenCacheOptions = {
  /** Clock for expiry checks (tests). */
  now?: () => number;
  /**
   * Drop the entry this many ms before Google's `expires_at`.
   * Default 60_000 (1 minute).
   */
  skewMs?: number;
  /**
   * When Google omits `expires_in`, keep the token this long.
   * Default 50 minutes (under the usual 1h Google access-token lifetime).
   */
  defaultTtlMs?: number;
  /** Soft cap before opportunistic prune of expired entries. Default 10_000. */
  maxEntries?: number;
};

const DEFAULT_SKEW_MS = 60_000;
const DEFAULT_TTL_MS = 50 * 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

export function createAccessTokenCache(opts: AccessTokenCacheOptions = {}): AccessTokenCache {
  const entries = new Map<string, CachedAccessToken>();
  const now = opts.now ?? Date.now;
  const skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
  const defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

  function pruneExpired(t: number): void {
    for (const [id, entry] of entries) {
      if (t >= entry.expiresAtMs) entries.delete(id);
    }
  }

  return {
    get(grantId: string): string | undefined {
      const entry = entries.get(grantId);
      if (!entry) return undefined;
      const t = now();
      if (t >= entry.expiresAtMs) {
        entries.delete(grantId);
        return undefined;
      }
      return entry.accessToken;
    },

    set(grantId: string, accessToken: string, expiresAt?: string): void {
      const t = now();
      let expiresAtMs: number;
      if (expiresAt) {
        const parsed = Date.parse(expiresAt);
        expiresAtMs = Number.isFinite(parsed) ? parsed - skewMs : t + defaultTtlMs;
      } else {
        expiresAtMs = t + defaultTtlMs;
      }
      // Never cache a token that is already within the skew window.
      if (expiresAtMs <= t) return;
      entries.set(grantId, { accessToken, expiresAtMs });
      if (entries.size > maxEntries) pruneExpired(t);
    },

    invalidate(grantId: string): void {
      entries.delete(grantId);
    },

    clear(): void {
      entries.clear();
    },

    size(): number {
      return entries.size;
    },
  };
}

/** Process-wide cache shared by routes + sync within one isolate. */
let processCache: AccessTokenCache = createAccessTokenCache();

export function getAccessTokenCache(): AccessTokenCache {
  return processCache;
}

/** Replace the process cache (tests). Pass nothing to reset to a fresh default. */
export function resetAccessTokenCacheForTests(cache?: AccessTokenCache): void {
  processCache = cache ?? createAccessTokenCache();
}
