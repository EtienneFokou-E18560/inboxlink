/**
 * Optional BullMQ / Redis placeholders.
 * Importing bullmq is deferred so the server starts without Redis installed.
 */
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
  console.info("[inboxlink] REDIS_URL set — sync queue stub active (no workers yet)");
  return {
    async enqueue(job: SyncJob) {
      console.info("[inboxlink] enqueue stub", job);
    },
    async close() {
      /* no-op */
    },
  };
}
