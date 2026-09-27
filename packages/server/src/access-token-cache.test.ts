import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAccessTokenCache } from "./access-token-cache.js";

describe("access token cache", () => {
  it("returns undefined on miss and after invalidate", () => {
    const cache = createAccessTokenCache({ now: () => 1_000_000 });
    assert.equal(cache.get("grant_a"), undefined);
    cache.set("grant_a", "tok-1", new Date(1_000_000 + 3_600_000).toISOString());
    assert.equal(cache.get("grant_a"), "tok-1");
    cache.invalidate("grant_a");
    assert.equal(cache.get("grant_a"), undefined);
  });

  it("expires at Google expiresAt minus skew", () => {
    let now = 1_000_000;
    const cache = createAccessTokenCache({
      now: () => now,
      skewMs: 60_000,
    });
    const expiresAt = new Date(1_000_000 + 3_600_000).toISOString();
    cache.set("grant_a", "tok-1", expiresAt);
    assert.equal(cache.get("grant_a"), "tok-1");

    // Still valid just before skew window.
    now = 1_000_000 + 3_600_000 - 60_000 - 1;
    assert.equal(cache.get("grant_a"), "tok-1");

    // Inside skew window → miss.
    now = 1_000_000 + 3_600_000 - 60_000;
    assert.equal(cache.get("grant_a"), undefined);
    assert.equal(cache.size(), 0);
  });

  it("uses default TTL when expiresAt is omitted", () => {
    let now = 0;
    const cache = createAccessTokenCache({
      now: () => now,
      defaultTtlMs: 1000,
      skewMs: 0,
    });
    cache.set("grant_a", "tok-1");
    assert.equal(cache.get("grant_a"), "tok-1");
    now = 999;
    assert.equal(cache.get("grant_a"), "tok-1");
    now = 1000;
    assert.equal(cache.get("grant_a"), undefined);
  });

  it("does not store tokens already past the skew window", () => {
    const now = 5_000_000;
    const cache = createAccessTokenCache({ now: () => now, skewMs: 60_000 });
    cache.set("grant_a", "tok-stale", new Date(now + 30_000).toISOString());
    assert.equal(cache.get("grant_a"), undefined);
    assert.equal(cache.size(), 0);
  });

  it("clear drops all entries", () => {
    const cache = createAccessTokenCache({ now: () => 0, skewMs: 0, defaultTtlMs: 60_000 });
    cache.set("a", "1");
    cache.set("b", "2");
    assert.equal(cache.size(), 2);
    cache.clear();
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.size(), 0);
  });
});
