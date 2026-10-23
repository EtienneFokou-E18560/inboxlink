import type { Grant, Provider, TokenVault } from "@inboxlink/core";
import { getAccessTokenCache } from "./access-token-cache.js";
import { replaceEarlierGrants } from "./grants-replace.js";
import { log } from "./log.js";
import type { GrantStore } from "./store.js";

/**
 * What a finished Connect does with the tenant's existing grants for the same
 * mailbox, per tenant:
 *
 * - `replace` (default, unchanged for every host that does not opt in): a new
 *   grant is made and earlier live grants for the same address are retired,
 *   their token and cached messages deleted.
 * - `reuse`: when the tenant already has a live grant for the address, the
 *   fresh token goes on that grant, which keeps its id and its cached messages,
 *   becomes `active` and is owned by the connecting host user. Reads that name
 *   the previous owner get 409 `grant_replaced`.
 *
 * In both, a host may name the grant this Connect replaces (`replacesGrantId`
 * on the link session, after asking the person). When the new mailbox is a
 * different address, that grant is retired; when it is the same address it is
 * reused (`reuse`) or replaced (`replace`) as above. Without it, a different
 * address is added next to the existing grants.
 */
export type ConnectPolicy = "replace" | "reuse";

export const CONNECT_POLICIES: readonly ConnectPolicy[] = ["replace", "reuse"];

/**
 * Parse `INBOXLINK_CONNECT_POLICY`: comma or whitespace separated
 * `tenantId=policy` entries (`askel=reuse`). Unset or empty: every tenant
 * `replace`. An invalid entry throws so a typo fails at boot, not silently.
 */
export function parseConnectPolicies(raw: string | undefined): Record<string, ConnectPolicy> {
  const out: Record<string, ConnectPolicy> = {};
  if (!raw) return out;
  for (const part of raw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const tenantId = eq > 0 ? part.slice(0, eq).trim() : "";
    const policy = eq > 0 ? part.slice(eq + 1).trim() : "";
    if (!tenantId || !(CONNECT_POLICIES as readonly string[]).includes(policy)) {
      throw new Error(
        `INBOXLINK_CONNECT_POLICY entry must be tenantId=replace or tenantId=reuse: ${part}`,
      );
    }
    out[tenantId] = policy as ConnectPolicy;
  }
  return out;
}

export function connectPolicyFor(
  policies: Record<string, ConnectPolicy> | undefined,
  tenantId: string,
): ConnectPolicy {
  return policies?.[tenantId] ?? "replace";
}

export type ConnectGrantInput = {
  store: GrantStore;
  vault: TokenVault;
  policy: ConnectPolicy;
  tenantId: string;
  externalUserId: string;
  provider: Provider;
  /** The address the provider reported; undefined when it sent none. */
  email: string | undefined;
  /** Used for a new grant when the provider sent no address. */
  fallbackEmail: string;
  refreshToken: string;
  scopes: string[];
  replacesGrantId?: string;
  /** `createdAt` for a new grant (strictly increasing within a process). */
  createdAt: () => string;
  newGrantId: () => string;
};

export type ConnectGrantOutcome = {
  grant: Grant;
  /** True when an existing grant was reused (same id, cache kept). */
  reused: boolean;
  /** Set when a reused grant belonged to another host user until now. */
  previousExternalUserId?: string;
  /** Grants this Connect retired; their token and cache are already deleted. */
  retired: Grant[];
};

export class VaultSealError extends Error {
  constructor(readonly grantId: string) {
    super("vault_seal_failed");
    this.name = "VaultSealError";
  }
}

/**
 * Settle a finished Connect: reuse a live grant or create a new one, then
 * retire what it replaces. Retiring is best-effort (a failure is logged and
 * the next Connect retries), but sealing the token is not: a seal failure
 * throws `VaultSealError` and leaves no new grant behind.
 */
export async function connectGrant(input: ConnectGrantInput): Promise<ConnectGrantOutcome> {
  if (input.policy === "reuse" && input.email) {
    const reused = await tryReuse(input, input.email);
    if (reused) return reused;
  }
  return createNew(input);
}

async function tryReuse(input: ConnectGrantInput, email: string): Promise<ConnectGrantOutcome | undefined> {
  const { store, vault, tenantId } = input;
  const live = await store.findLiveGrantsByAddress(tenantId, input.provider, email);
  const target = pickReuseTarget(live, input.externalUserId, input.replacesGrantId);
  if (!target) return undefined;

  // Seal first so the grant is never active without the fresh token. The
  // vault write is an upsert keyed by grant id: the old token is overwritten.
  try {
    await vault.seal(input.refreshToken, { grantId: target.id, tenantId });
  } catch {
    // The old token (if any) is still in place and the grant untouched.
    throw new VaultSealError(target.id);
  }
  const claimed = await store.reassignGrant({
    id: target.id,
    tenantId,
    externalUserId: input.externalUserId,
    scopes: input.scopes,
    updatedAt: new Date().toISOString(),
  });
  getAccessTokenCache().invalidate(target.id);
  if (!claimed) {
    // Retired between the lookup and the claim (a concurrent Connect took the
    // address another way). A revoked grant holds no token: drop what we just
    // sealed and fall back to a new grant.
    const now = await store.getGrant(target.id);
    if (!now || now.status === "revoked") await vault.destroy(target.id);
    return undefined;
  }

  const others = live.filter((g) => g.id !== target.id).map((g) => g.id);
  const retired = await retireSafe(input, { ids: others, replacedBy: target.id });
  const named = input.replacesGrantId;
  if (named && named !== target.id && !others.includes(named)) {
    retired.push(...(await retireSafe(input, { ids: [named], replacedBy: target.id, ownOnly: true })));
  }
  log.info("grant_reused", {
    grantId: target.id,
    tenantId,
    sameUser: claimed.previousExternalUserId === input.externalUserId,
    retired: retired.length,
  });
  return {
    grant: claimed.grant,
    reused: true,
    ...(claimed.previousExternalUserId !== input.externalUserId
      ? { previousExternalUserId: claimed.previousExternalUserId }
      : {}),
    retired,
  };
}

/**
 * Which live grant for the address takes the fresh token: the connecting
 * user's own (newest), else the grant the host said this Connect replaces,
 * else the newest live grant of the tenant for that address.
 */
export function pickReuseTarget(
  live: Grant[],
  externalUserId: string,
  replacesGrantId: string | undefined,
): Grant | undefined {
  const newestFirst = [...live].reverse();
  return (
    newestFirst.find((g) => g.externalUserId === externalUserId) ??
    (replacesGrantId ? newestFirst.find((g) => g.id === replacesGrantId) : undefined) ??
    newestFirst[0]
  );
}

async function createNew(input: ConnectGrantInput): Promise<ConnectGrantOutcome> {
  const { store, vault, tenantId } = input;
  const createdAt = input.createdAt();
  const grant: Grant = {
    id: input.newGrantId(),
    tenantId,
    externalUserId: input.externalUserId,
    provider: input.provider,
    email: input.email ?? input.fallbackEmail,
    status: "active",
    scopes: [...input.scopes],
    createdAt,
    updatedAt: createdAt,
  };
  await store.putGrant(grant);
  try {
    await vault.seal(input.refreshToken, { grantId: grant.id, tenantId });
  } catch {
    await store.deleteGrant(grant.id, tenantId);
    throw new VaultSealError(grant.id);
  }

  const retired: Grant[] = [];
  // One live grant per mailbox: retire this tenant's earlier grants for the
  // same address (any host user). Skipped when the provider sent no address.
  // A failure here must not fail a Connect whose token is already sealed: the
  // duplicates stay (as before this rule) and the next Connect retries.
  if (input.email) {
    try {
      const ids = await replaceEarlierGrants({ store, vault, grant });
      for (const id of ids) {
        const old = await store.getGrant(id);
        if (old) retired.push(old);
      }
    } catch (err) {
      log.warn("grant_replace_failed", {
        grantId: grant.id,
        tenantId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  // The grant the host said this Connect replaces (the person chose "replace"
  // for a different address). Only the same host user's own grant.
  if (input.replacesGrantId && !retired.some((g) => g.id === input.replacesGrantId)) {
    retired.push(...(await retireSafe(input, { ids: [input.replacesGrantId], replacedBy: grant.id, ownOnly: true })));
  }
  return { grant, reused: false, retired };
}

/**
 * Retire grants by id (live ones of this tenant only), then delete their
 * tokens and cached messages. Logs and returns [] on a store failure.
 */
async function retireSafe(
  input: ConnectGrantInput,
  what: { ids: string[]; replacedBy: string; ownOnly?: boolean },
): Promise<Grant[]> {
  const { store, vault, tenantId } = input;
  if (what.ids.length === 0) return [];
  try {
    const retired = await store.retireGrants({
      ids: what.ids,
      tenantId,
      replacedBy: what.replacedBy,
      updatedAt: new Date().toISOString(),
      // The grant named by the host must be that host user's own; same-address
      // duplicates may belong to anyone in the tenant.
      ...(what.ownOnly ? { externalUserId: input.externalUserId } : {}),
    });
    for (const old of retired) {
      await vault.destroy(old.id);
      getAccessTokenCache().invalidate(old.id);
      await store.deleteMessages(old.id);
      log.info("grant_replaced", {
        grantId: old.id,
        replacedBy: what.replacedBy,
        tenantId,
        sameUser: old.externalUserId === input.externalUserId,
      });
    }
    return retired;
  } catch (err) {
    log.warn("grant_replace_failed", {
      grantId: what.replacedBy,
      tenantId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return [];
  }
}
