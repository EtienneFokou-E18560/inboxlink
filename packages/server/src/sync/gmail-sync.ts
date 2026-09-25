import type { Grant, Message, SyncCursor } from "@inboxlink/core";
import { GmailAdapter, GmailApiError, type GmailHistoryRecord } from "@inboxlink/adapters-gmail";
import { getAccessTokenCache } from "../access-token-cache.js";
import {
  markNeedsReauth,
  openGrantAccessToken,
  type CiphertextVault,
} from "../gmail-access.js";
import type { GrantStore } from "../store.js";

const BOOTSTRAP_MAX = 50;

export type { CiphertextVault };

export type SyncResult = {
  grantId: string;
  status: "ok" | "needs_reauth" | "gmail_unavailable";
  mode: "bootstrap" | "incremental";
  historyId?: string;
  upserted: number;
  deleted: number;
  error?: string;
};

/**
 * Inline Gmail sync: bootstrap via messages.list + profile historyId, then
 * incremental users.history.list with a persisted watermark. No Redis required.
 */
export async function syncGmailGrant(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  grant: Grant;
  /** Force a full mailbox bootstrap even when a cursor exists. */
  forceBootstrap?: boolean;
}): Promise<SyncResult> {
  const { store, vault, gmail, grant } = input;
  const grantId = grant.id;

  const access = await openAccessToken({ store, vault, gmail, grant });
  if (access.status !== "ok") {
    return {
      grantId,
      status: access.status,
      mode: "bootstrap",
      upserted: 0,
      deleted: 0,
      error: access.error,
    };
  }

  const cursor = await store.getSyncCursor(grantId);
  const force = input.forceBootstrap === true || !cursor?.value;

  try {
    if (!force) {
      try {
        return await runIncremental({
          store,
          gmail,
          grant,
          accessToken: access.accessToken,
          startHistoryId: cursor!.value,
        });
      } catch (err) {
        if (!(err instanceof GmailApiError) || err.status !== 404) throw err;
        // Watermark expired — fall through to bootstrap.
      }
    }
    return await runBootstrap({
      store,
      gmail,
      grant,
      accessToken: access.accessToken,
    });
  } catch (err) {
    if (err instanceof GmailApiError && (err.status === 401 || err.status === 403)) {
      getAccessTokenCache().invalidate(grantId);
      await markNeedsReauth(store, grant);
      return {
        grantId,
        status: "needs_reauth",
        mode: force ? "bootstrap" : "incremental",
        upserted: 0,
        deleted: 0,
        error: "needs_reauth",
      };
    }
    return {
      grantId,
      status: "gmail_unavailable",
      mode: force ? "bootstrap" : "incremental",
      upserted: 0,
      deleted: 0,
      error: "gmail_unavailable",
    };
  }
}

async function runBootstrap(input: {
  store: GrantStore;
  gmail: GmailAdapter;
  grant: Grant;
  accessToken: string;
}): Promise<SyncResult> {
  const { store, gmail, grant, accessToken } = input;
  const page = await gmail.listMessages({
    accessToken,
    grantId: grant.id,
    maxResults: BOOTSTRAP_MAX,
  });
  await store.deleteMessages(grant.id);
  await store.upsertMessages(page.messages);
  const profile = await gmail.getProfile(accessToken);
  await putHistoryCursor(store, grant.id, profile.historyId);
  return {
    grantId: grant.id,
    status: "ok",
    mode: "bootstrap",
    historyId: profile.historyId,
    upserted: page.messages.length,
    deleted: 0,
  };
}

async function runIncremental(input: {
  store: GrantStore;
  gmail: GmailAdapter;
  grant: Grant;
  accessToken: string;
  startHistoryId: string;
}): Promise<SyncResult> {
  const { store, gmail, grant, accessToken, startHistoryId } = input;
  const added = new Set<string>();
  const deleted = new Set<string>();
  const touched = new Set<string>();
  let historyId = startHistoryId;
  let pageToken: string | undefined;

  for (;;) {
    const page = await gmail.listHistory({
      accessToken,
      startHistoryId,
      pageToken,
    });
    historyId = page.historyId;
    for (const record of page.history) {
      applyHistoryRecord(record, added, deleted, touched);
    }
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  for (const id of deleted) {
    added.delete(id);
    touched.delete(id);
  }

  const toFetch = new Set([...added, ...touched]);
  const upserts: Message[] = [];
  for (const messageId of toFetch) {
    try {
      const message = await gmail.getMessage({
        accessToken,
        grantId: grant.id,
        messageId,
      });
      if (message) upserts.push(message);
    } catch (err) {
      // Message may already be gone; treat as delete.
      if (err instanceof GmailApiError && err.status === 404) {
        deleted.add(messageId);
        continue;
      }
      throw err;
    }
  }

  if (upserts.length) await store.upsertMessages(upserts);
  const deleteIds = [...deleted];
  if (deleteIds.length) await store.deleteMessagesByProviderIds(grant.id, deleteIds);
  await putHistoryCursor(store, grant.id, historyId);

  return {
    grantId: grant.id,
    status: "ok",
    mode: "incremental",
    historyId,
    upserted: upserts.length,
    deleted: deleteIds.length,
  };
}

function applyHistoryRecord(
  record: GmailHistoryRecord,
  added: Set<string>,
  deleted: Set<string>,
  touched: Set<string>,
): void {
  for (const entry of record.messagesAdded ?? []) {
    const id = entry.message?.id;
    if (id) added.add(id);
  }
  for (const entry of record.messagesDeleted ?? []) {
    const id = entry.message?.id;
    if (id) deleted.add(id);
  }
  for (const entry of record.labelsAdded ?? []) {
    const id = entry.message?.id;
    if (id) touched.add(id);
  }
  for (const entry of record.labelsRemoved ?? []) {
    const id = entry.message?.id;
    if (id) touched.add(id);
  }
}

async function openAccessToken(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  grant: Grant;
}): Promise<{ status: "ok"; accessToken: string } | { status: "needs_reauth"; error: string }> {
  const access = await openGrantAccessToken(input);
  if (access.ok) return { status: "ok", accessToken: access.accessToken };
  return { status: "needs_reauth", error: access.error };
}

async function putHistoryCursor(store: GrantStore, grantId: string, historyId: string): Promise<void> {
  const cursor: SyncCursor = {
    grantId,
    kind: "gmail_history",
    value: historyId,
    updatedAt: new Date().toISOString(),
  };
  await store.putSyncCursor(cursor);
}
