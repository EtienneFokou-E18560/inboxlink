import { createHmac } from "node:crypto";
import { newId } from "@inboxlink/core";
import { log } from "../log.js";

/** Events emitted by the host webhook bus (Wave C). `message.created` deferred to Wave D. */
export type WebhookEventType =
  | "grant.connected"
  | "grant.needs_reauth"
  | "sync.completed";

export type WebhookEvent = {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: Record<string, unknown>;
};

export type WebhookDeliveryResult = {
  ok: boolean;
  attempts: number;
  /** True when a hard 4xx caused us to stop retrying. */
  dropped: boolean;
  lastStatus?: number;
};

export type WebhookBusConfig = {
  /** Host callback URL (`INBOXLINK_WEBHOOK_URL`). */
  url: string;
  /** Shared HMAC secret (`INBOXLINK_WEBHOOK_SECRET`). */
  secret: string;
  /** Total attempts including the first try. Default 3. */
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type WebhookBus = {
  /** True when URL + secret are configured (delivery enabled). */
  enabled: boolean;
  /** Sign + POST with bounded retries. Never throws. */
  emit(type: WebhookEventType, data: Record<string, unknown>): Promise<WebhookDeliveryResult>;
};

const DEFAULT_MAX_ATTEMPTS = 3;
/** Backoff between attempts (ms); index 0 unused (no sleep before first try). */
const DEFAULT_BACKOFF_MS = [0, 100, 400] as const;

/** Header hosts should pass to `InboxLink.webhooks.verify`. */
export const WEBHOOK_SIGNATURE_HEADER = "X-InboxLink-Signature";

export function signWebhookBody(secret: string, rawBody: string): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}

/** Retry on 408 / 429 / 5xx (Nylas-style). Drop on other 4xx. */
export function shouldRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isHardClientError(status: number): boolean {
  return status >= 400 && status < 500 && !shouldRetryStatus(status);
}

/**
 * Build a bus from env-style config. Returns a no-op bus when URL or secret is missing
 * so Connect / sync never depend on webhooks being configured.
 */
export function createWebhookBus(
  input: Partial<WebhookBusConfig> | null | undefined,
): WebhookBus {
  const url = input?.url?.trim() ?? "";
  const secret = input?.secret?.trim() ?? "";
  if (!url || !secret) {
    return {
      enabled: false,
      async emit() {
        return { ok: true, attempts: 0, dropped: false };
      },
    };
  }
  const config: WebhookBusConfig = {
    url,
    secret,
    maxAttempts: input?.maxAttempts,
    fetchImpl: input?.fetchImpl,
    sleep: input?.sleep,
  };
  return {
    enabled: true,
    emit(type, data) {
      return deliverWebhookEvent(config, type, data);
    },
  };
}

export async function deliverWebhookEvent(
  config: WebhookBusConfig,
  type: WebhookEventType,
  data: Record<string, unknown>,
): Promise<WebhookDeliveryResult> {
  const event: WebhookEvent = {
    id: newId("evt"),
    type,
    createdAt: new Date().toISOString(),
    data,
  };
  const rawBody = JSON.stringify(event);
  const signature = signWebhookBody(config.secret, rawBody);
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const fetchImpl = config.fetchImpl ?? fetch;
  const sleep = config.sleep ?? defaultSleep;

  let lastStatus: number | undefined;
  let dropped = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delay = DEFAULT_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_BACKOFF_MS.length - 1)] ?? 400;
      await sleep(delay);
    }
    try {
      const res = await fetchImpl(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: signature,
          "X-InboxLink-Event": type,
          "X-InboxLink-Delivery-Id": event.id,
          "User-Agent": "InboxLink-Webhooks/0.1",
        },
        body: rawBody,
      });
      lastStatus = res.status;
      if (res.ok) {
        return { ok: true, attempts: attempt, dropped: false, lastStatus };
      }
      if (isHardClientError(res.status)) {
        dropped = true;
        log.warn("webhook_delivery_dropped", {
          type,
          eventId: event.id,
          status: res.status,
          attempts: attempt,
        });
        return { ok: false, attempts: attempt, dropped: true, lastStatus };
      }
      if (!shouldRetryStatus(res.status) || attempt === maxAttempts) {
        log.warn("webhook_delivery_failed", {
          type,
          eventId: event.id,
          status: res.status,
          attempts: attempt,
        });
        return { ok: false, attempts: attempt, dropped: false, lastStatus };
      }
    } catch (err) {
      log.warn("webhook_delivery_error", {
        type,
        eventId: event.id,
        attempts: attempt,
        error: err instanceof Error ? err.message : "unknown",
      });
      if (attempt === maxAttempts) {
        return { ok: false, attempts: attempt, dropped: false, lastStatus };
      }
    }
  }

  return { ok: false, attempts: maxAttempts, dropped, lastStatus };
}

/**
 * Fire-and-forget wrapper: logs failures, never throws (Connect / sync stay green).
 */
export function emitWebhookSafe(
  bus: WebhookBus | null | undefined,
  type: WebhookEventType,
  data: Record<string, unknown>,
): Promise<WebhookDeliveryResult> {
  if (!bus) {
    return Promise.resolve({ ok: true, attempts: 0, dropped: false });
  }
  return bus.emit(type, data).catch((err) => {
    log.warn("webhook_emit_unexpected", {
      type,
      error: err instanceof Error ? err.message : "unknown",
    });
    return { ok: false, attempts: 0, dropped: false };
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
