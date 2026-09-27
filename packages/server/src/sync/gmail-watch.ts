import type { Grant } from "@inboxlink/core";
import { GmailAdapter, GmailApiError } from "@inboxlink/adapters-gmail";
import { getAccessTokenCache } from "../access-token-cache.js";
import {
  markNeedsReauth,
  openGrantAccessToken,
  type CiphertextVault,
} from "../gmail-access.js";
import { log } from "../log.js";
import type { GrantStore } from "../store.js";

export type WatchResult = {
  grantId: string;
  status: "ok" | "skipped" | "needs_reauth" | "watch_failed";
  historyId?: string;
  expiration?: string;
  error?: string;
};

/**
 * Call Gmail `users.watch` and persist historyId + watch expiration on the
 * sync cursor. No-ops when `topicName` is unset (push not configured).
 * Never throws — Connect / renew cron stay green on watch failures.
 */
export async function startOrRenewGmailWatch(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  grant: Grant;
  /** Full Pub/Sub topic resource name (`projects/…/topics/…`). */
  topicName?: string;
}): Promise<WatchResult> {
  const topic = input.topicName?.trim();
  if (!topic) {
    return { grantId: input.grant.id, status: "skipped" };
  }
  if (input.grant.provider !== "gmail" || input.grant.status !== "active") {
    return { grantId: input.grant.id, status: "skipped" };
  }

  const access = await openGrantAccessToken({
    store: input.store,
    vault: input.vault,
    gmail: input.gmail,
    grant: input.grant,
  });
  if (!access.ok) {
    return { grantId: input.grant.id, status: "needs_reauth", error: access.error };
  }

  try {
    const watched = await input.gmail.watchMailbox({
      accessToken: access.accessToken,
      topicName: topic,
    });
    const existing = await input.store.getSyncCursor(input.grant.id);
    await input.store.putSyncCursor({
      grantId: input.grant.id,
      kind: "gmail_history",
      // Prefer existing watermark when present; seed from watch otherwise.
      value: existing?.value || watched.historyId,
      updatedAt: new Date().toISOString(),
      watchExpiration: watched.expiration,
    });
    log.info("gmail_watch_ok", {
      grantId: input.grant.id,
      expiration: watched.expiration,
    });
    return {
      grantId: input.grant.id,
      status: "ok",
      historyId: watched.historyId,
      expiration: watched.expiration,
    };
  } catch (err) {
    if (err instanceof GmailApiError && (err.status === 401 || err.status === 403)) {
      getAccessTokenCache().invalidate(input.grant.id);
      await markNeedsReauth(input.store, input.grant);
      return { grantId: input.grant.id, status: "needs_reauth", error: "needs_reauth" };
    }
    log.warn("gmail_watch_failed", {
      grantId: input.grant.id,
      error: err instanceof Error ? err.message : "unknown",
      gmailStatus: err instanceof GmailApiError ? err.status : undefined,
    });
    return {
      grantId: input.grant.id,
      status: "watch_failed",
      error: err instanceof GmailApiError ? `gmail_${err.status}` : "watch_failed",
    };
  }
}

/** Renew watches for all active Gmail grants (daily cron). */
export async function renewAllGmailWatches(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  topicName?: string;
}): Promise<{ renewed: number; failed: number; skipped: number; needsReauth: number }> {
  const topic = input.topicName?.trim();
  if (!topic) {
    return { renewed: 0, failed: 0, skipped: 0, needsReauth: 0 };
  }
  const grants = await input.store.listActiveGmailGrants();
  let renewed = 0;
  let failed = 0;
  let skipped = 0;
  let needsReauth = 0;
  for (const grant of grants) {
    const result = await startOrRenewGmailWatch({
      store: input.store,
      vault: input.vault,
      gmail: input.gmail,
      grant,
      topicName: topic,
    });
    if (result.status === "ok") renewed += 1;
    else if (result.status === "needs_reauth") needsReauth += 1;
    else if (result.status === "skipped") skipped += 1;
    else failed += 1;
  }
  log.info("gmail_watch_renew_sweep", { renewed, failed, skipped, needsReauth });
  return { renewed, failed, skipped, needsReauth };
}
