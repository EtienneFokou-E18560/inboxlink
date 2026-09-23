/**
 * Optional BullMQ / Redis placeholders.
 * Importing bullmq is deferred so the server starts without Redis installed.
 * Slice B runs sync inline on POST /v1/grants/:id/sync; Redis remains optional.
 */
import { log } from "../log.js";

export type SyncJob = {
  grantId: string;
  tenantId: string;
  kind: "bootstrap" | "incremental";
};

export type QueueHandle = {
  enqueue(job: SyncJob): Promise<void>;
  close(): Promise<void>;
};

export async function createSyncQueue(redisUrl?: string): Promise<QueueHandle | null> {
  if (!redisUrl?.trim()) {
    return null;
  }
  // Placeholder: real BullMQ wiring lands with Slice 2 workers.
  log.info("sync_queue_stub_active");
  return {
    async enqueue(job: SyncJob) {
      log.info("sync_queue_enqueue_stub", {
        grantId: job.grantId,
        tenantId: job.tenantId,
        kind: job.kind,
      });
    },
    async close() {
      /* no-op */
    },
  };
}
