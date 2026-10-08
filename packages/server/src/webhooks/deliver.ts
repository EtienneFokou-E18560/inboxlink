import { createHmac } from "node:crypto";
import { newId } from "@inboxlink/core";
import { log } from "../log.js";

export const WEBHOOK_EVENT_TYPES = [
  "grant.connected",
  "grant.needs_reauth",
  "sync.completed",
  "message.created",
] as const;

/** Events emitted by the host webhook bus (Waves C–D). */
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

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
  /** Per-attempt timeout. Default 5s so a hanging host cannot eat the function budget. */
  timeoutMs?: number;
  now?: () => number;
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

/** Legacy header: HMAC of the raw body only (no replay protection). */
export const WEBHOOK_SIGNATURE_HEADER = "X-InboxLink-Signature";
/** Unix seconds the request was signed. */
export const WEBHOOK_TIMESTAMP_HEADER = "X-InboxLink-Timestamp";
/** Preferred header: HMAC over `${timestamp}.${body}`. Verify with a tolerance window. */
export const WEBHOOK_SIGNATURE_V1_HEADER = "X-InboxLink-Signature-V1";

const DEFAULT_TIMEOUT_MS = 5000;

export function signWebhookBody(secret: string, rawBody: string): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}

export function signWebhookV1(secret: string, timestamp: string, rawBody: string): string {
  const hex = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
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
  const timestamp = String(Math.floor((config.now ?? Date.now)() / 1000));
  const signatureV1 = signWebhookV1(config.secret, timestamp, rawBody);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
          [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
          [WEBHOOK_SIGNATURE_V1_HEADER]: signatureV1,
          "X-InboxLink-Event": type,
          "X-InboxLink-Delivery-Id": event.id,
          "User-Agent": "InboxLink-Webhooks/0.1",
        },
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
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

export type WebhookTargetResolver = {
  targetsFor(
    tenantId: string,
    type: WebhookEventType,
  ): Promise<Array<{ id: string; url: string; secret: string }>>;
};

/**
 * Tenant-scoped bus: an event goes only to the endpoints its own tenant registered.
 * `fallback` (the legacy single env URL/secret) applies to `fallbackTenantId` only,
 * so one tenant's events can never reach another tenant's URL.
 */
export function createTenantWebhookBus(input: {
  registry: WebhookTargetResolver;
  fallback?: Partial<WebhookBusConfig> | null;
  fallbackTenantId?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): WebhookBus {
  const fb = input.fallback;
  const fallbackUrl = fb?.url?.trim() ?? "";
  const fallbackSecret = fb?.secret?.trim() ?? "";
  return {
    enabled: true,
    async emit(type, data) {
      const tenantId = typeof data.tenantId === "string" ? data.tenantId : undefined;
      if (!tenantId) return { ok: true, attempts: 0, dropped: false };
      const targets = await input.registry.targetsFor(tenantId, type);
      const configs: WebhookBusConfig[] = targets.map((t) => ({
        url: t.url,
        secret: t.secret,
        fetchImpl: input.fetchImpl,
        sleep: input.sleep,
        timeoutMs: input.timeoutMs,
      }));
      if (fallbackUrl && fallbackSecret && tenantId === (input.fallbackTenantId ?? "default")) {
        configs.push({
          url: fallbackUrl,
          secret: fallbackSecret,
          fetchImpl: input.fetchImpl,
          sleep: input.sleep,
          timeoutMs: input.timeoutMs,
        });
      }
      if (configs.length === 0) return { ok: true, attempts: 0, dropped: false };
      const results = await Promise.all(configs.map((c) => deliverWebhookEvent(c, type, data)));
      return {
        ok: results.every((r) => r.ok),
        attempts: results.reduce((n, r) => n + r.attempts, 0),
        dropped: results.some((r) => r.dropped),
        lastStatus: results.find((r) => !r.ok)?.lastStatus ?? results[0]?.lastStatus,
      };
    },
  };
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
