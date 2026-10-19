/**
 * Normalized mailbox models and adapter contracts (provider-agnostic).
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Etienne Fokou
 */

export type Provider = "gmail" | "microsoft" | "imap";

export type GrantStatus = "active" | "needs_reauth" | "revoked";

export type EmailAddress = {
  name?: string;
  email: string;
};

export type Grant = {
  id: string;
  tenantId: string;
  externalUserId: string;
  provider: Provider;
  email: string;
  status: GrantStatus;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  /**
   * Set when a later Connect of the same mailbox (same tenant, provider and
   * address) took over: the id of the grant that replaced this one. A replaced
   * grant is `revoked`, holds no token and no cached messages.
   */
  replacedBy?: string;
};

/** Attachment metadata from the message MIME tree — no bytes. */
export type MessageAttachment = {
  /** Provider attachment id (Gmail `body.attachmentId`). */
  id: string;
  filename: string;
  mimeType: string;
  /** Decoded byte length from the provider (`body.size`). */
  size: number;
};

/**
 * Raw mail headers that mark bulk or automated mail. Each value is the header as sent,
 * untrimmed and unparsed; a field is absent when the message has no such header.
 */
export type MessageHeaders = {
  /** `List-Unsubscribe`, e.g. `<https://…>, <mailto:…>`. */
  listUnsubscribe?: string;
  /** `Precedence`, e.g. `bulk`, `list`, `junk`. */
  precedence?: string;
  /** `Auto-Submitted`, e.g. `auto-generated`, `auto-replied`; `no` means a person sent it. */
  autoSubmitted?: string;
};

export type Message = {
  id: string;
  grantId: string;
  providerMessageId: string;
  threadId?: string;
  subject: string;
  snippet: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc?: EmailAddress[];
  sentAt: string;
  receivedAt: string;
  /**
   * Gmail: the folder-like subset of `labelIds` (`INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`,
   * `STARRED`, `IMPORTANT`, `CHAT` and every `CATEGORY_*`). Not the full list: use `labels`.
   */
  folderIds: string[];
  /**
   * Gmail: `labelIds` exactly as Gmail returns them (system labels such as `INBOX`, `UNREAD`,
   * `CATEGORY_PROMOTIONS`, and user labels by id), on live reads (`source=live`, single-message
   * get) and on store reads alike.
   */
  labels?: string[];
  /**
   * Bulk/automated-mail headers. Filled on the live list (`GET /v1/grants/:id/messages?source=live`)
   * only; absent on store reads and single-message gets, and absent when the message has none.
   */
  headers?: MessageHeaders;
  hasAttachments: boolean;
  /** Present when the MIME tree has one or more downloadable attachments. */
  attachments?: MessageAttachment[];
  body?: { text?: string; html?: string };
};

export type SyncCursorKind = "gmail_history" | "graph_delta" | "imap_uid";

export type SyncCursor = {
  grantId: string;
  kind: SyncCursorKind;
  value: string;
  updatedAt: string;
  /**
   * Gmail `users.watch` expiration (ISO). Present when push is configured.
   * Google expires watches within ≤7 days; renew daily.
   */
  watchExpiration?: string;
};

export type LinkSession = {
  id: string;
  linkToken: string;
  tenantId: string;
  externalUserId: string;
  redirectUri: string;
  products: string[];
  status: "pending" | "completed" | "expired";
  createdAt: string;
  expiresAt: string;
};

export type PublicGrantToken = {
  publicToken: string;
  grantId: string;
};

/** Provider adapter surface — implementations live in @inboxlink/adapters-*. */
export interface MailboxAdapter {
  readonly provider: Provider;
  buildAuthorizationUrl(input: {
    state: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge?: string;
  }): string;
  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    email?: string;
    scopes: string[];
  }>;
  refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresAt?: string;
  }>;
}

/** Secret vault — refresh tokens / IMAP secrets never leave encrypted storage. */
export interface TokenVault {
  seal(plaintext: string, context: { grantId: string; tenantId: string }): Promise<Uint8Array>;
  open(ciphertext: Uint8Array, context: { grantId: string; tenantId: string }): Promise<string>;
  destroy(grantId: string): Promise<void>;
}

export type CreateLinkSessionInput = {
  externalUserId: string;
  redirectUri: string;
  products?: string[];
};
