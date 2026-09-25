import type { Message } from "@inboxlink/core";
import {
  deserializeImapCredentials,
  parseImapCredentials,
  redactSecrets,
  serializeImapCredentials,
  type ImapCredentials,
} from "./credentials.js";
import { normalizeImapMessage } from "./normalize.js";
import {
  createImapflowSession,
  ImapAuthError,
  ImapUnavailableError,
  type ImapSession,
  type ImapTransportFactory,
} from "./transport.js";

export type ImapAdapterConfig = {
  /** Injectable session factory for tests. Defaults to imapflow (logger off). */
  transportFactory?: ImapTransportFactory;
  /** Mailbox path for list — v0 is INBOX only. */
  mailbox?: string;
};

/**
 * IMAP adapter (Slice E / v0).
 * Password or app-password only. Secrets are sealed by the server vault;
 * this class never writes credentials to logs.
 */
export class ImapAdapter {
  readonly provider = "imap" as const;
  private readonly transportFactory: ImapTransportFactory;
  private readonly mailbox: string;

  constructor(config: ImapAdapterConfig = {}) {
    this.transportFactory = config.transportFactory ?? createImapflowSession;
    this.mailbox = config.mailbox ?? "INBOX";
  }

  /** Validate shape and return a vault-ready secret string (do not log). */
  prepareSecret(input: unknown): { credentials: ImapCredentials; secret: string } {
    const credentials = parseImapCredentials(input);
    return { credentials, secret: serializeImapCredentials(credentials) };
  }

  openSecret(plaintext: string): ImapCredentials {
    return deserializeImapCredentials(plaintext);
  }

  /**
   * Connect + SELECT INBOX to verify credentials, then disconnect.
   * Returns the mailbox identity (user string) on success.
   */
  async verifyConnection(credentials: ImapCredentials): Promise<{ email: string }> {
    let session: ImapSession | undefined;
    try {
      session = await this.transportFactory(credentials);
      // Touch the mailbox so a successful SELECT is part of verify.
      await session.searchAllUids();
      return { email: credentials.user };
    } catch (err) {
      throw sanitizeImapError(err, credentials);
    } finally {
      await session?.close();
    }
  }

  /**
   * List newest-first INBOX messages. Cursor is the exclusive upper UID bound
   * (next page continues with UIDs strictly less than the cursor).
   */
  async listMessages(input: {
    credentials: ImapCredentials;
    grantId: string;
    maxResults?: number;
    cursor?: string;
  }): Promise<{ messages: Message[]; nextCursor?: string }> {
    const limit = input.maxResults ?? 20;
    let session: ImapSession | undefined;
    try {
      session = await this.transportFactory(input.credentials);
      const uidsAsc = await session.searchAllUids();
      const newestFirst = [...uidsAsc].sort((a, b) => b - a);
      let start = 0;
      if (input.cursor) {
        const bound = Number(input.cursor);
        if (!Number.isFinite(bound) || bound <= 0) {
          throw new ImapUnavailableError("invalid_cursor");
        }
        start = newestFirst.findIndex((uid) => uid < bound);
        if (start < 0) start = newestFirst.length;
      }
      const pageUids = newestFirst.slice(start, start + limit);
      const fetched = await session.fetchByUids(pageUids);
      const byUid = new Map(fetched.map((row) => [row.uid, row]));
      const messages: Message[] = [];
      for (const uid of pageUids) {
        const row = byUid.get(uid);
        if (!row) continue;
        const message = normalizeImapMessage(row, input.grantId, this.mailbox);
        if (message) messages.push(message);
      }
      const last = pageUids[pageUids.length - 1];
      const nextCursor =
        last !== undefined && start + pageUids.length < newestFirst.length
          ? String(last)
          : undefined;
      return { messages, nextCursor };
    } catch (err) {
      throw sanitizeImapError(err, input.credentials);
    } finally {
      await session?.close();
    }
  }
}

function sanitizeImapError(err: unknown, credentials: ImapCredentials): Error {
  if (err instanceof ImapAuthError || err instanceof ImapUnavailableError) {
    err.message = redactSecrets(err.message, credentials);
    return err;
  }
  if (err instanceof Error) {
    const message = redactSecrets(err.message, credentials).toLowerCase();
    if (
      message.includes("authentication") ||
      message.includes("invalid credentials") ||
      (message.includes("auth") && message.includes("fail")) ||
      message.includes("login failed")
    ) {
      return new ImapAuthError("imap_auth_failed");
    }
    return new ImapUnavailableError("imap_unavailable");
  }
  return new ImapUnavailableError("imap_unavailable");
}

export { ImapAuthError, ImapUnavailableError };
export type { ImapSession, ImapTransportFactory };
export {
  parseImapCredentials,
  serializeImapCredentials,
  deserializeImapCredentials,
  redactSecrets,
  ImapCredentialsError,
  type ImapCredentials,
} from "./credentials.js";
export { normalizeImapMessage, type ImapFetchedMessage, type ImapEnvelope } from "./normalize.js";
export { createImapflowSession } from "./transport.js";

