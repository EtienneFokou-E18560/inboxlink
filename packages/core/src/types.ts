/** Normalized mailbox models and adapter contracts (provider-agnostic). */

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
  folderIds: string[];
  labels?: string[];
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
