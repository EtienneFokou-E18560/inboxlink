import {
  DATABASE_UNAVAILABLE_GUIDANCE,
  MEMORY_STORE_GUIDANCE,
} from "../log.js";
import type { GrantStore } from "../store.js";
import type { QueueHandle } from "../queue/sync-queue.js";

/** Safe health fields only — never secrets, tokens, or connection strings. */
export type HealthBody = {
  ok: boolean;
  service: "inboxlink";
  mode: "single" | "multi";
  store: "memory" | "postgres";
  queue?: "stub" | "disabled";
  warning?: string;
  guidance?: string;
  error?: string;
};

export type HealthResult = {
  status: 200 | 503;
  body: HealthBody;
};

export type HealthProbeInput = {
  store: GrantStore;
  mode: "single" | "multi";
  storeKind?: "memory" | "postgres";
  queue: QueueHandle | null;
};

/**
 * Canonical health probe used by `GET /`, `/health`, `/health/`, and `/status`.
 * Machine clients should keep using the JSON routes; `/status` is HTML only.
 */
export async function probeHealth(input: HealthProbeInput): Promise<HealthResult> {
  const storeKind = input.storeKind ?? "memory";
  try {
    await input.store.ready();
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        service: "inboxlink",
        mode: input.mode,
        store: storeKind,
        error: "database_unavailable",
        guidance: DATABASE_UNAVAILABLE_GUIDANCE,
      },
    };
  }

  const body: HealthBody = {
    ok: true,
    service: "inboxlink",
    mode: input.mode,
    queue: input.queue ? "stub" : "disabled",
    store: storeKind,
  };
  if (storeKind !== "postgres") {
    body.warning = "ephemeral_store";
    body.guidance = MEMORY_STORE_GUIDANCE;
  }
  return { status: 200, body };
}
