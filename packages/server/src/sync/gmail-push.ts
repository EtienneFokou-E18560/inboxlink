import type { Grant, Message } from "@inboxlink/core";
import type { GmailAdapter } from "@inboxlink/adapters-gmail";
import type { CiphertextVault } from "../gmail-access.js";
import { log } from "../log.js";
import type { GrantStore } from "../store.js";
import { syncGmailGrant, type SyncResult } from "./gmail-sync.js";
import { emitWebhookSafe, type WebhookBus } from "../webhooks/deliver.js";

/** Decoded Gmail Pub/Sub push payload (`emailAddress` + `historyId`). */
export type GmailPushNotification = {
  emailAddress?: string;
  historyId?: string;
};

export type ApplyPushResult = {
  status: "ok" | "ignored" | "no_grant" | "error";
  grantIds: string[];
  results: SyncResult[];
  error?: string;
};

/**
 * Apply a Gmail Pub/Sub notification: resolve grant(s) by email → history
 * sync from stored cursor → emit host webhooks. History 404 / expired watch
 * falls through to bootstrap inside `syncGmailGrant` (no crash).
 */
export async function applyGmailPushNotification(input: {
  store: GrantStore;
  vault: CiphertextVault;
  gmail: GmailAdapter;
  webhooks?: WebhookBus | null;
  notification: GmailPushNotification;
}): Promise<ApplyPushResult> {
  const email = input.notification.emailAddress?.trim();
  if (!email) {
    return { status: "ignored", grantIds: [], results: [], error: "missing_email" };
  }

  const grants = await input.store.findActiveGrantsByEmail(email);
  if (!grants.length) {
    log.info("gmail_push_no_grant", { emailDomain: email.split("@")[1] ?? "unknown" });
    return { status: "no_grant", grantIds: [], results: [] };
  }

  const results: SyncResult[] = [];
  for (const grant of grants) {
    const beforeIds = new Set(
      (await input.store.listMessages(grant.id)).map((m) => m.providerMessageId),
    );
    const result = await syncGmailGrant({
      store: input.store,
      vault: input.vault,
      gmail: input.gmail,
      grant,
    });
    results.push(result);
    await emitPushWebhooks({
      webhooks: input.webhooks,
      grant,
      result,
      store: input.store,
      beforeIds,
    });
  }

  const anyOk = results.some((r) => r.status === "ok");
  return {
    status: anyOk ? "ok" : "error",
    grantIds: grants.map((g) => g.id),
    results,
  };
}

/**
 * Parse the Pub/Sub push HTTP body. Accepts the wrapped envelope
 * `{ message: { data: base64 } }` or a raw `{ emailAddress, historyId }` JSON.
 */
export function parsePubSubPushBody(raw: unknown): GmailPushNotification | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;

  // Already decoded notification (tests / direct invoke).
  if (typeof body.emailAddress === "string" || typeof body.historyId === "string") {
    return {
      emailAddress: typeof body.emailAddress === "string" ? body.emailAddress : undefined,
      historyId: typeof body.historyId === "string" ? body.historyId : undefined,
    };
  }

  const message = body.message;
  if (!message || typeof message !== "object") return null;
  const data = (message as { data?: unknown }).data;
  if (typeof data !== "string" || !data) return null;
  try {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    const json = JSON.parse(decoded) as GmailPushNotification;
    return {
      emailAddress: typeof json.emailAddress === "string" ? json.emailAddress : undefined,
      historyId: typeof json.historyId === "string" ? json.historyId : undefined,
    };
  } catch {
    return null;
  }
}

async function emitPushWebhooks(input: {
  webhooks?: WebhookBus | null;
  grant: Grant;
  result: SyncResult;
  store: GrantStore;
  beforeIds: Set<string>;
}): Promise<void> {
  const { grant, result } = input;
  if (result.status === "needs_reauth") {
    await emitWebhookSafe(input.webhooks, "grant.needs_reauth", {
      grantId: grant.id,
      tenantId: grant.tenantId,
      externalUserId: grant.externalUserId,
      provider: grant.provider,
      email: grant.email,
      reason: "push",
    });
    return;
  }
  if (result.status !== "ok") return;

  await emitWebhookSafe(input.webhooks, "sync.completed", {
    grantId: result.grantId,
    tenantId: grant.tenantId,
    externalUserId: grant.externalUserId,
    provider: grant.provider,
    mode: result.mode,
    historyId: result.historyId,
    upserted: result.upserted,
    deleted: result.deleted,
    source: "gmail_push",
  });

  if (result.upserted <= 0) return;
  const after = await input.store.listMessages(grant.id);
  const created = after.filter((m) => !input.beforeIds.has(m.providerMessageId));
  for (const message of created) {
    await emitMessageCreated(input.webhooks, grant, message);
  }
}

async function emitMessageCreated(
  bus: WebhookBus | null | undefined,
  grant: Grant,
  message: Message,
): Promise<void> {
  await emitWebhookSafe(bus, "message.created", {
    grantId: grant.id,
    tenantId: grant.tenantId,
    externalUserId: grant.externalUserId,
    provider: grant.provider,
    messageId: message.id,
    providerMessageId: message.providerMessageId,
    threadId: message.threadId,
    subject: message.subject,
    receivedAt: message.receivedAt,
  });
}
