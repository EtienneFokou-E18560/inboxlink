import type { Message } from "@inboxlink/core";
import { gmailFolderIds } from "@inboxlink/adapters-gmail";

/**
 * What the synced message store may keep (issue #86): inbox mail only, metadata
 * only, for a limited time. Live reads (`source=live`, `messages.get`) never
 * write to the store, so these rules do not apply to them.
 */

/** `INBOXLINK_MESSAGE_TTL_DAYS` when unset. Covers a host's 21-day sync window. */
export const DEFAULT_MESSAGE_TTL_DAYS = 30;

const DAY_MS = 86_400_000;

/** Labels that keep a message out of the store even when it also carries INBOX. */
const NEVER_STORED = new Set(["SENT", "DRAFT", "SPAM", "TRASH"]);

/** Inbox mail only. Sent mail is never stored: hosts read it live. */
export function isStorableMessage(labels: readonly string[] | undefined): boolean {
  if (!labels?.includes("INBOX")) return false;
  return !labels.some((label) => NEVER_STORED.has(label));
}

/** Oldest `receivedAt` the store keeps, as an ISO string. */
export function messageCutoff(ttlDays: number, nowMs: number): string {
  return new Date(nowMs - ttlDays * DAY_MS).toISOString();
}

/** True when the message is older than the time limit at `cutoff`. */
export function isExpired(message: Pick<Message, "receivedAt">, cutoff: string): boolean {
  const at = Date.parse(message.receivedAt);
  return !Number.isFinite(at) || at < Date.parse(cutoff);
}

/**
 * The metadata the store keeps for one message: ids, thread, time, labels,
 * subject and snippet. No body, no addresses, no attachments, no headers.
 * `sentAt` repeats `receivedAt`; read the message live for the rest.
 */
export function minimiseMessage(message: Message): Message {
  const labels = message.labels ?? message.folderIds;
  const minimised: Message = {
    id: message.id,
    grantId: message.grantId,
    providerMessageId: message.providerMessageId,
    subject: message.subject,
    snippet: message.snippet,
    from: [],
    to: [],
    sentAt: message.receivedAt,
    receivedAt: message.receivedAt,
    folderIds: gmailFolderIds(labels),
    labels: [...labels],
    hasAttachments: false,
  };
  if (message.threadId) minimised.threadId = message.threadId;
  return minimised;
}

export function positiveTtlDays(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_MESSAGE_TTL_DAYS;
}
