import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { GmailAdapter, GmailTokenRefreshError } from "@inboxlink/adapters-gmail";
import type { Grant } from "@inboxlink/core";
import {
  createAccessTokenCache,
  resetAccessTokenCacheForTests,
} from "./access-token-cache.js";
import { openGrantAccessToken } from "./gmail-access.js";
import { MemoryStore } from "./store.js";
import { MemoryTokenVault } from "./vault/memory-vault.js";

const MASTER = "test-master-key-at-least-16";
const REFRESH = "1//refresh-for-cache-unit";

function grant(id = "grant_open"): Grant {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: "default",
    externalUserId: "user-1",
    provider: "gmail",
    email: "user@example.com",
    status: "active",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    createdAt: now,
    updatedAt: now,
  };
}

describe("openGrantAccessToken", () => {
  beforeEach(() => {
    resetAccessTokenCacheForTests();
  });

  it("refreshes once then serves from cache without a second refresh", async () => {
    let refreshes = 0;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const g = grant();
    await store.putGrant(g);
    await vault.seal(REFRESH, { grantId: g.id, tenantId: g.tenantId });

    const gmail = {
      async refreshAccessToken(refreshToken: string) {
        assert.equal(refreshToken, REFRESH);
        refreshes += 1;
        return {
          accessToken: `access-${refreshes}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      },
    };

    const first = await openGrantAccessToken({ store, vault, gmail, grant: g });
    assert.deepEqual(first, { ok: true, accessToken: "access-1" });
    const second = await openGrantAccessToken({ store, vault, gmail, grant: g });
    assert.deepEqual(second, { ok: true, accessToken: "access-1" });
    assert.equal(refreshes, 1);
  });

  it("re-refreshes after the cache entry expires", async () => {
    let now = 1_000_000;
    const cache = createAccessTokenCache({ now: () => now, skewMs: 0 });
    resetAccessTokenCacheForTests(cache);

    let refreshes = 0;
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const g = grant("grant_expire");
    await store.putGrant(g);
    await vault.seal(REFRESH, { grantId: g.id, tenantId: g.tenantId });

    const gmail = {
      async refreshAccessToken() {
        refreshes += 1;
        return {
          accessToken: `access-${refreshes}`,
          expiresAt: new Date(now + 1000).toISOString(),
        };
      },
    };

    assert.equal((await openGrantAccessToken({ store, vault, gmail, grant: g, cache })).ok, true);
    now = 1_000_999;
    assert.equal((await openGrantAccessToken({ store, vault, gmail, grant: g, cache })).ok, true);
    assert.equal(refreshes, 1);
    now = 1_001_000;
    const third = await openGrantAccessToken({ store, vault, gmail, grant: g, cache });
    assert.deepEqual(third, { ok: true, accessToken: "access-2" });
    assert.equal(refreshes, 2);
  });

  it("marks needs_reauth when Google refuses the refresh token (invalid_grant)", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const g = grant("grant_fail");
    await store.putGrant(g);
    await vault.seal(REFRESH, { grantId: g.id, tenantId: g.tenantId });

    const gmail = {
      async refreshAccessToken(): Promise<never> {
        throw new GmailTokenRefreshError(400, "invalid_grant");
      },
    };

    const result = await openGrantAccessToken({ store, vault, gmail, grant: g });
    assert.deepEqual(result, { ok: false, error: "needs_reauth" });
    const updated = await store.getGrant(g.id);
    assert.equal(updated?.status, "needs_reauth");
  });

  for (const [label, failure] of [
    ["Google answers 500", () => new GmailTokenRefreshError(500, undefined)],
    ["Google answers 503 with a JSON error", () => new GmailTokenRefreshError(503, "temporarily_unavailable")],
    ["our client is misconfigured (invalid_client)", () => new GmailTokenRefreshError(401, "invalid_client")],
    ["the network fails", () => new TypeError("fetch failed")],
  ] as const) {
    it(`keeps the grant active and asks nothing of the person when ${label}`, async () => {
      const store = new MemoryStore();
      const vault = new MemoryTokenVault(MASTER);
      const g = grant(`grant_temp_${label.length}`);
      await store.putGrant(g);
      await vault.seal(REFRESH, { grantId: g.id, tenantId: g.tenantId });
      const gmail = {
        async refreshAccessToken(): Promise<never> {
          throw failure();
        },
      };
      const result = await openGrantAccessToken({ store, vault, gmail, grant: g });
      assert.deepEqual(result, { ok: false, error: "provider_unavailable" });
      assert.equal((await store.getGrant(g.id))?.status, "active", "no reconnect for a temporary failure");
    });
  }

  it("returns missing_refresh_token without calling Google when vault is empty", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const g = grant("grant_empty");
    await store.putGrant(g);
    let called = false;
    const gmail = {
      async refreshAccessToken() {
        called = true;
        return { accessToken: "x" };
      },
    };
    const result = await openGrantAccessToken({ store, vault, gmail, grant: g });
    assert.deepEqual(result, { ok: false, error: "missing_refresh_token" });
    assert.equal(called, false);
  });

  it("works with a real GmailAdapter stub refresh (placeholder credentials)", async () => {
    const store = new MemoryStore();
    const vault = new MemoryTokenVault(MASTER);
    const g = grant("grant_stub");
    await store.putGrant(g);
    await vault.seal(REFRESH, { grantId: g.id, tenantId: g.tenantId });
    const gmail = new GmailAdapter({
      clientId: "change-me.apps.googleusercontent.com",
      clientSecret: "change-me-secret",
      redirectUri: "http://localhost/callback",
    });
    const first = await openGrantAccessToken({ store, vault, gmail, grant: g });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = await openGrantAccessToken({ store, vault, gmail, grant: g });
    assert.deepEqual(first, second);
  });
});
