import type { Grant, TokenVault } from "@inboxlink/core";
import type { AccessTokenCache } from "./access-token-cache.js";
import { getAccessTokenCache } from "./access-token-cache.js";
import type { GrantStore } from "./store.js";

export type CiphertextVault = TokenVault & {
  getCiphertext(grantId: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
};

export type GmailTokenRefresher = {
  refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt?: string;
  }>;
};

export type OpenGrantAccessOk = { ok: true; accessToken: string };
export type OpenGrantAccessFail = {
  ok: false;
  error: "missing_refresh_token" | "needs_reauth";
};

/**
 * Open vault → refresh (or cache hit) → short-lived access token for a grant.
 * Refresh tokens never enter the cache. On refresh failure the grant is marked
 * `needs_reauth` and any cached access token for the grant is dropped.
 */
export async function openGrantAccessToken(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailTokenRefresher;
  grant: Grant;
  /** Defaults to the process-wide in-isolate cache. */
  cache?: AccessTokenCache;
}): Promise<OpenGrantAccessOk | OpenGrantAccessFail> {
  const { store, vault, gmail, grant } = input;
  const cache = input.cache ?? getAccessTokenCache();

  const cached = cache.get(grant.id);
  if (cached) return { ok: true, accessToken: cached };

  const ciphertext = await vault.getCiphertext(grant.id);
  if (!ciphertext) {
    return { ok: false, error: "missing_refresh_token" };
  }

  let refreshToken: string;
  try {
    refreshToken = await vault.open(ciphertext, {
      grantId: grant.id,
      tenantId: grant.tenantId,
    });
  } catch {
    return { ok: false, error: "missing_refresh_token" };
  }

  try {
    const refreshed = await gmail.refreshAccessToken(refreshToken);
    cache.set(grant.id, refreshed.accessToken, refreshed.expiresAt);
    return { ok: true, accessToken: refreshed.accessToken };
  } catch {
    cache.invalidate(grant.id);
    await markNeedsReauth(store, grant);
    return { ok: false, error: "needs_reauth" };
  }
}

export async function markNeedsReauth(store: GrantStore, grant: Grant): Promise<void> {
  grant.status = "needs_reauth";
  grant.updatedAt = new Date().toISOString();
  await store.updateGrant(grant);
}
