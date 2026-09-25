import { ImapFlow } from "imapflow";
import type { ImapCredentials } from "./credentials.js";
import type { ImapFetchedMessage } from "./normalize.js";

/** Session used by ImapAdapter — real imapflow or a test double. */
export type ImapSession = {
  /** Search all UIDs in the locked mailbox (ascending). */
  searchAllUids(): Promise<number[]>;
  fetchByUids(uids: number[]): Promise<ImapFetchedMessage[]>;
  close(): Promise<void>;
};

export type ImapTransportFactory = (credentials: ImapCredentials) => Promise<ImapSession>;

/**
 * Default transport: imapflow with logging disabled so auth material is never printed.
 * Auth failures become ImapAuthError without echoing the password.
 */
export const createImapflowSession: ImapTransportFactory = async (credentials) => {
  const client = new ImapFlow({
    host: credentials.host,
    port: credentials.port,
    secure: credentials.secure,
    auth: {
      user: credentials.user,
      pass: credentials.password,
    },
    logger: false,
    emitLogs: false,
  });

  try {
    await client.connect();
  } catch (err) {
    throw toImapError(err, credentials);
  }

  let lock: { release(): void } | undefined;
  try {
    lock = await client.getMailboxLock("INBOX");
  } catch (err) {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    throw toImapError(err, credentials);
  }

  return {
    async searchAllUids() {
      try {
        const uids = await client.search({ all: true }, { uid: true });
        return Array.isArray(uids) ? uids.filter((uid) => Number.isFinite(uid) && uid > 0) : [];
      } catch (err) {
        throw toImapError(err, credentials);
      }
    },
    async fetchByUids(uids: number[]) {
      if (!uids.length) return [];
      const out: ImapFetchedMessage[] = [];
      try {
        for await (const msg of client.fetch(
          uids,
          { uid: true, envelope: true, source: true, flags: true },
          { uid: true },
        )) {
          out.push({
            uid: msg.uid,
            envelope: msg.envelope ?? null,
            source: msg.source ?? null,
            flags: msg.flags ?? null,
          });
        }
      } catch (err) {
        throw toImapError(err, credentials);
      }
      return out;
    },
    async close() {
      try {
        lock?.release();
      } catch {
        /* ignore */
      }
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    },
  };
};

export class ImapAuthError extends Error {
  constructor(message = "imap_auth_failed") {
    super(message);
    this.name = "ImapAuthError";
  }
}

export class ImapUnavailableError extends Error {
  constructor(message = "imap_unavailable") {
    super(message);
    this.name = "ImapUnavailableError";
  }
}

function toImapError(err: unknown, credentials: ImapCredentials): Error {
  const raw = err instanceof Error ? err.message : String(err);
  // Never include the password if a server echoed it (unlikely but defensive).
  const message = credentials.password ? raw.split(credentials.password).join("[redacted]") : raw;
  const lower = message.toLowerCase();
  if (
    lower.includes("authentication") ||
    lower.includes("invalid credentials") ||
    (lower.includes("auth") && lower.includes("fail")) ||
    lower.includes("login failed") ||
    /\bAUTH\b/.test(message)
  ) {
    return new ImapAuthError("imap_auth_failed");
  }
  return new ImapUnavailableError("imap_unavailable");
}
