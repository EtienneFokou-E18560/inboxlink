import type { Grant, Message, SyncCursor } from "@inboxlink/core";
import {
  GmailAdapter,
  GmailApiError,
  gmailRequiresReconnect,
  type GmailHistoryRecord,
} from "@inboxlink/adapters-gmail";
import { getAccessTokenCache } from "../access-token-cache.js";
import {
  markNeedsReauth,
  reusedSince,
  openGrantAccessToken,
  type CiphertextVault,
} from "../gmail-access.js";
import {
  isExpired,
  isStorableMessage,
  messageCutoff,
  minimiseMessage,
  positiveTtlDays,
} from "../message-rules.js";
import type { GrantStore } from "../store.js";

/** Cap the first look's list page size; upsert only — never wipe prior cache. */
const BOOTSTRAP_MAX = 50;
/** Bound concurrent Gmail getMessage calls during incremental sync. */
const GET_MESSAGE_CONCURRENCY = 5;

export type { CiphertextVault };

export type SyncResult = {
  grantId: string;
  status: "ok" | "needs_reauth" | "gmail_unavailable";
  mode: "bootstrap" | "incremental";
  historyId?: string;
  upserted: number;
  deleted: number;
  /** Rows past the time limit this sync deleted for the grant before it ran. */
  expired: number;
  error?: string;
};

export type SyncGmailGrantInput = {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  grant: Grant;
  /**
   * Ask for the first look back even when a cursor exists (a new Connect, whose
   * cursor the Gmail watch may have seeded). Ignored once the grant has had its
   * first look: a connection looks back once, then reads new mail only.
   */
  forceBootstrap?: boolean;
  /** `INBOXLINK_MESSAGE_TTL_DAYS`; default 30. */
  messageTtlDays?: number;
  /** Test clock (ms). */
  now?: () => number;
};

/**
 * A sync result plus the messages the sync upserted (metadata only). Kept apart
 * from `SyncResult` so job rows and webhook payloads never carry message content.
 */
export type DetailedSyncResult = {
  result: SyncResult;
  upsertedMessages: Message[];
};

/**
 * Inline Gmail sync: one first look (inbox messages.list + profile historyId),
 * then incremental users.history.list with a persisted watermark. No Redis required.
 * Stores inbox mail only, as metadata, inside the time limit (issue #86).
 */
export async function syncGmailGrant(input: SyncGmailGrantInput): Promise<SyncResult> {
  return (await syncGmailGrantDetailed(input)).result;
}

/**
 * Same as `syncGmailGrant`, also returning the upserted messages so callers
 * (Gmail push) can tell what is new without re-reading the message cache.
 */
export async function syncGmailGrantDetailed(
  input: SyncGmailGrantInput,
): Promise<DetailedSyncResult> {
  const { store, vault, gmail, grant } = input;
  const grantId = grant.id;
  const nowMs = (input.now ?? Date.now)();
  const cutoff = messageCutoff(positiveTtlDays(input.messageTtlDays), nowMs);

  // Time limit first, whatever happens next (also for a grant that needs reauth).
  const expired = await store.deleteExpiredMessages({ before: cutoff, grantId });

  const access = await openAccessToken({ store, vault, gmail, grant });
  if (access.status !== "ok") {
    return withoutMessages({
      grantId,
      status: access.status,
      mode: "bootstrap",
      upserted: 0,
      deleted: 0,
      expired,
      error: access.error,
    });
  }

  const cursor = await store.getSyncCursor(grantId);
  const firstLookDone = Boolean(cursor?.firstLookAt);
  const force = !firstLookDone && (input.forceBootstrap === true || !cursor?.value);
  const run = { store, gmail, grant, accessToken: access.accessToken, cutoff, nowMs, expired };

  try {
    if (!force && cursor?.value) {
      try {
        return await runIncremental({ ...run, startHistoryId: cursor.value });
      } catch (err) {
        if (!(err instanceof GmailApiError) || err.status !== 404) throw err;
        // Watermark expired. After the first look, restart from now: no second look back.
        if (firstLookDone) return await restartFromNow(run);
      }
    }
    if (firstLookDone) return await restartFromNow(run);
    return await runBootstrap(run);
  } catch (err) {
    if (gmailRequiresReconnect(err)) {
      getAccessTokenCache().invalidate(grantId);
      const stale = !(await markNeedsReauth(store, grant)) && (await reusedSince(store, grant));
      if (stale) {
        // The old token was refused; a reconnect reused the grant meanwhile.
        return withoutMessages({
          grantId,
          status: "gmail_unavailable",
          mode: force ? "bootstrap" : "incremental",
          upserted: 0,
          deleted: 0,
          expired,
          error: "gmail_unavailable",
        });
      }
      return withoutMessages({
        grantId,
        status: "needs_reauth",
        mode: force ? "bootstrap" : "incremental",
        upserted: 0,
        deleted: 0,
        expired,
        error: "needs_reauth",
      });
    }
    return withoutMessages({
      grantId,
      status: "gmail_unavailable",
      mode: force ? "bootstrap" : "incremental",
      upserted: 0,
      deleted: 0,
      expired,
      error: "gmail_unavailable",
    });
  }
}

function withoutMessages(result: SyncResult): DetailedSyncResult {
  return { result, upsertedMessages: [] };
}

type RunInput = {
  store: GrantStore;
  gmail: GmailAdapter;
  grant: Grant;
  accessToken: string;
  /** Oldest `receivedAt` the store keeps (ISO). */
  cutoff: string;
  nowMs: number;
  expired: number;
};

/** Inbox mail inside the time limit, as the metadata the store keeps. */
function storable(messages: Message[], cutoff: string): Message[] {
  return messages
    .filter((message) => isStorableMessage(message.labels ?? message.folderIds) && !isExpired(message, cutoff))
    .map(minimiseMessage);
}

/** The one first look back: the newest inbox messages inside the time limit. */
async function runBootstrap(input: RunInput): Promise<DetailedSyncResult> {
  const { store, gmail, grant, accessToken } = input;
  const page = await gmail.listMessages({
    accessToken,
    grantId: grant.id,
    maxResults: BOOTSTRAP_MAX,
    labelIds: ["INBOX"],
  });
  const kept = storable(page.messages, input.cutoff);
  // Upsert only — do not deleteMessages. Prior cache rows outside this page stay.
  if (kept.length) await store.upsertMessages(kept);
  const profile = await gmail.getProfile(accessToken);
  await putHistoryCursor(store, grant.id, profile.historyId, input.nowMs);
  await store.markFirstLook(grant.id, new Date(input.nowMs).toISOString());
  return {
    result: {
      grantId: grant.id,
      status: "ok",
      mode: "bootstrap",
      historyId: profile.historyId,
      upserted: kept.length,
      deleted: 0,
      expired: input.expired,
    },
    upsertedMessages: kept,
  };
}

/**
 * After the first look, a watermark Gmail no longer knows (or a full sync) does
 * not look back again: the cursor moves to the mailbox's current historyId and
 * later syncs read only mail that arrives from now on.
 */
async function restartFromNow(input: RunInput): Promise<DetailedSyncResult> {
  const profile = await input.gmail.getProfile(input.accessToken);
  await putHistoryCursor(input.store, input.grant.id, profile.historyId, input.nowMs);
  return {
    result: {
      grantId: input.grant.id,
      status: "ok",
      mode: "incremental",
      historyId: profile.historyId,
      upserted: 0,
      deleted: 0,
      expired: input.expired,
    },
    upsertedMessages: [],
  };
}

async function runIncremental(input: RunInput & { startHistoryId: string }): Promise<DetailedSyncResult> {
  const { store, gmail, grant, accessToken, startHistoryId } = input;
  const added = new Set<string>();
  const deleted = new Set<string>();
  const touched = new Set<string>();
  /** Touched by an event that adds INBOX: worth a look even when not stored yet. */
  const inboxAdded = new Set<string>();
  /** Added outside the inbox (sent mail, drafts...): not fetched, not stored. */
  const skipped = new Set<string>();
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
      applyHistoryRecord(record, { added, deleted, touched, inboxAdded, skipped });
    }
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  for (const id of deleted) {
    added.delete(id);
    touched.delete(id);
    skipped.delete(id);
  }
  // A later move into the inbox still gets a look.
  for (const id of inboxAdded) skipped.delete(id);
  for (const id of skipped) {
    added.delete(id);
    touched.delete(id);
  }
  // Any other label change matters only for a message the store already holds
  // (it may have left the inbox). Sent or archived mail is never fetched for it.
  const unsure = [...touched].filter((id) => !inboxAdded.has(id) && !added.has(id));
  if (unsure.length) {
    const stored = new Set(await store.listMessageIds(grant.id));
    for (const id of unsure) if (!stored.has(id)) touched.delete(id);
  }

  const toFetch = [...new Set([...added, ...touched])];
  const fetched: Message[] = [];
  const fetchDeletes = new Set<string>();

  await mapWithConcurrency(toFetch, GET_MESSAGE_CONCURRENCY, async (messageId) => {
    try {
      // Metadata only: the store never keeps a body, so sync never reads one.
      const message = await gmail.getMessageMetadata({
        accessToken,
        grantId: grant.id,
        messageId,
      });
      if (message) fetched.push(message);
    } catch (err) {
      // Message may already be gone; treat as delete.
      if (err instanceof GmailApiError && err.status === 404) {
        fetchDeletes.add(messageId);
        return;
      }
      throw err;
    }
  });

  for (const id of fetchDeletes) deleted.add(id);

  const upserts = storable(fetched, input.cutoff);
  const keptIds = new Set(upserts.map((message) => message.providerMessageId));
  // Left the inbox (archived, sent, trashed) or past the time limit: not kept.
  const leftInbox = [
    ...fetched.map((message) => message.providerMessageId).filter((id) => !keptIds.has(id)),
    ...skipped,
  ];

  if (upserts.length) await store.upsertMessages(upserts);
  const deleteIds = [...deleted];
  if (deleteIds.length) await store.deleteMessagesByProviderIds(grant.id, deleteIds);
  if (leftInbox.length) {
    await store.deleteMessagesByProviderIds(grant.id, leftInbox, { minimisedOnly: true });
  }
  await putHistoryCursor(store, grant.id, historyId, input.nowMs);

  return {
    result: {
      grantId: grant.id,
      status: "ok",
      mode: "incremental",
      historyId,
      upserted: upserts.length,
      deleted: deleteIds.length,
      expired: input.expired,
    },
    upsertedMessages: upserts,
  };
}

function applyHistoryRecord(
  record: GmailHistoryRecord,
  sets: {
    added: Set<string>;
    deleted: Set<string>;
    touched: Set<string>;
    inboxAdded: Set<string>;
    skipped: Set<string>;
  },
): void {
  const { added, deleted, touched, inboxAdded, skipped } = sets;
  for (const entry of record.messagesAdded ?? []) {
    const id = entry.message?.id;
    if (!id) continue;
    const labels = entry.message?.labelIds;
    // Gmail sends the labels a message was added with: skip mail that never was in the inbox.
    if (labels && !isStorableMessage(labels)) skipped.add(id);
    else added.add(id);
  }
  for (const entry of record.messagesDeleted ?? []) {
    const id = entry.message?.id;
    if (id) deleted.add(id);
  }
  for (const entry of record.labelsAdded ?? []) {
    const id = entry.message?.id;
    if (!id) continue;
    touched.add(id);
    if (entry.labelIds?.includes("INBOX")) inboxAdded.add(id);
  }
  for (const entry of record.labelsRemoved ?? []) {
    const id = entry.message?.id;
    if (id) touched.add(id);
  }
}

/** Run async work over items with a fixed worker pool (order of completion free). */
async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (!items.length) return;
  let next = 0;
  const limit = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index]!);
      }
    }),
  );
}

async function openAccessToken(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  grant: Grant;
}): Promise<
  | { status: "ok"; accessToken: string }
  | { status: "needs_reauth" | "gmail_unavailable"; error: string }
> {
  const access = await openGrantAccessToken(input);
  if (access.ok) return { status: "ok", accessToken: access.accessToken };
  // A temporary refresh failure leaves the grant as it is; the next sync retries.
  if (access.error === "provider_unavailable") return { status: "gmail_unavailable", error: "gmail_unavailable" };
  return { status: "needs_reauth", error: access.error };
}

async function putHistoryCursor(
  store: GrantStore,
  grantId: string,
  historyId: string,
  nowMs: number,
): Promise<void> {
  const cursor: SyncCursor = {
    grantId,
    kind: "gmail_history",
    value: historyId,
    updatedAt: new Date(nowMs).toISOString(),
  };
  await store.putSyncCursor(cursor);
}
