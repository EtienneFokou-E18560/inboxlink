import type { Grant, TokenVault } from "@inboxlink/core";
import { getAccessTokenCache } from "./access-token-cache.js";
import { log } from "./log.js";
import type { GrantStore } from "./store.js";

/**
 * One mailbox, one live grant per tenant.
 *
 * Called after a new grant's token is sealed. Every grant of the same tenant,
 * provider and address that is still `active` or `needs_reauth` and was
 * created before the new one (tie-break on id) is retired inside InboxLink: its sealed token is destroyed, its cached messages
 * are deleted, and it becomes `revoked` with `replacedBy` pointing at the new
 * grant. The row stays, so a host that still holds the old id gets a clear
 * `grant_replaced` instead of a bare 404.
 *
 * The old refresh token is NOT revoked at Google: Google's revoke endpoint ends
 * the whole authorization for that account and client, which would also kill
 * the token that was just issued. Dropping our only copy is enough.
 */
export async function replaceEarlierGrants(input: {
  store: GrantStore;
  vault: TokenVault;
  grant: Grant;
  now?: () => Date;
}): Promise<string[]> {
  const { store, vault, grant } = input;
  // The status change is one conditional write that only takes grants created
  // before this one, so a slower Connect for the same address finishing later
  // cannot retire the newer grant. Tokens and cached messages are destroyed
  // only for the grants this call actually retired.
  const retired = await store.retireEarlierGrants(
    grant,
    (input.now?.() ?? new Date()).toISOString(),
  );
  const replaced: string[] = [];
  for (const old of retired) {
    await vault.destroy(old.id);
    getAccessTokenCache().invalidate(old.id);
    await store.deleteMessages(old.id);
    replaced.push(old.id);
    // Ids only: never log the address or the host's user ids.
    log.info("grant_replaced", {
      grantId: old.id,
      replacedBy: grant.id,
      tenantId: grant.tenantId,
      sameUser: old.externalUserId === grant.externalUserId,
    });
  }
  return replaced;
}

/** The 409 code for a grant that can no longer be read or synced. */
export function inactiveGrantError(grant: Grant): "grant_replaced" | "grant_inactive" {
  return grant.replacedBy ? "grant_replaced" : "grant_inactive";
}
