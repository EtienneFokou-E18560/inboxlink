/**
 * Durable sync job queue (Wave D2).
 *
 * Postgres `sync_jobs` (via GrantStore) + HTTP 202 / status API + cron drain.
 * Redis/BullMQ remains optional and unused — MIT-only path for Vercel.
 */
import type { Grant } from "@inboxlink/core";
import type { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { CiphertextVault } from "../gmail-access.js";
import { log } from "../log.js";
import type { GrantStore, SyncJobRecord } from "../store.js";
import { syncGmailGrant, type SyncResult } from "../sync/gmail-sync.js";
import { emitWebhookSafe, type WebhookBus } from "../webhooks/deliver.js";

export type SyncJob = {
  grantId: string;
  tenantId: string;
  kind: "bootstrap" | "incremental";
  forceBootstrap?: boolean;
};

export type QueueHandle = {
  /** Enqueue a durable job; returns the job id. */
  enqueue(job: SyncJob): Promise<{ jobId: string }>;
  close(): Promise<void>;
};

/**
 * Create a queue handle backed by the GrantStore job table.
 * Always available (memory or Postgres) — no Redis required.
 */
export function createStoreSyncQueue(store: GrantStore): QueueHandle {
  return {
    async enqueue(job) {
      const record = await store.enqueueSyncJob({
        grantId: job.grantId,
        tenantId: job.tenantId,
        kind: job.kind,
        forceBootstrap: job.forceBootstrap === true || job.kind === "bootstrap",
      });
      log.info("sync_job_enqueued", {
        jobId: record.id,
        grantId: record.grantId,
        kind: record.kind,
      });
      return { jobId: record.id };
    },
    async close() {
      /* no-op */
    },
  };
}

/** @deprecated Prefer {@link createStoreSyncQueue}. Redis stub retained for health compat. */
export async function createSyncQueue(redisUrl?: string): Promise<QueueHandle | null> {
  if (!redisUrl?.trim()) return null;
  log.info("sync_queue_redis_ignored", {
    guidance: "Wave D2 uses Postgres sync_jobs; REDIS_URL is unused",
  });
  return null;
}

export type DrainResult = {
  processed: number;
  completed: number;
  failed: number;
};

/**
 * Claim and run up to `limit` queued sync jobs. Used by Vercel/GitHub cron
 * and optional inline drain after enqueue.
 */
export async function drainSyncJobs(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  webhooks?: WebhookBus | null;
  limit?: number;
}): Promise<DrainResult> {
  const claimed = await input.store.claimQueuedSyncJobs(input.limit ?? 5);
  let completed = 0;
  let failed = 0;
  for (const job of claimed) {
    const ok = await runClaimedSyncJob({
      store: input.store,
      vault: input.vault,
      gmail: input.gmail,
      webhooks: input.webhooks,
      job,
    });
    if (ok) completed += 1;
    else failed += 1;
  }
  if (claimed.length) {
    log.info("sync_jobs_drained", {
      processed: claimed.length,
      completed,
      failed,
    });
  }
  return { processed: claimed.length, completed, failed };
}

export async function runClaimedSyncJob(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  webhooks?: WebhookBus | null;
  job: SyncJobRecord;
}): Promise<boolean> {
  const { store, vault, gmail, job } = input;
  const grant = await store.getGrant(job.grantId);
  if (!grant || grant.tenantId !== job.tenantId) {
    await store.failSyncJob(job.id, "grant_not_found");
    return false;
  }
  if (grant.provider !== "gmail") {
    await store.failSyncJob(job.id, "unsupported_provider");
    return false;
  }
  if (grant.status !== "active") {
    await store.failSyncJob(job.id, "grant_inactive");
    return false;
  }

  try {
    const result = await syncGmailGrant({
      store,
      vault,
      gmail,
      grant,
      forceBootstrap: job.forceBootstrap,
    });
    await emitSyncWebhooks(input.webhooks, grant, result);
    if (result.status === "ok") {
      await store.completeSyncJob(job.id, {
        status: result.status,
        mode: result.mode,
        historyId: result.historyId,
        upserted: result.upserted,
        deleted: result.deleted,
      });
      return true;
    }
    await store.failSyncJob(job.id, result.error ?? result.status);
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : "sync_failed";
    log.warn("sync_job_failed", { jobId: job.id, grantId: job.grantId, error: message });
    await store.failSyncJob(job.id, message.slice(0, 500));
    return false;
  }
}

async function emitSyncWebhooks(
  bus: WebhookBus | null | undefined,
  grant: Grant,
  result: SyncResult,
): Promise<void> {
  if (result.status === "needs_reauth") {
    await emitWebhookSafe(bus, "grant.needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      externalUserId: grant.externalUserId,
      provider: grant.provider,
      email: grant.email,
      reason: "sync",
    });
    return;
  }
  if (result.status !== "ok") return;
  await emitWebhookSafe(bus, "sync.completed", {
    grantId: result.grantId,
    tenantId: grant.tenantId,
    externalUserId: grant.externalUserId,
    provider: grant.provider,
    mode: result.mode,
    historyId: result.historyId,
    upserted: result.upserted,
    deleted: result.deleted,
  });
}
