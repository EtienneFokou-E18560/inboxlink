import type { Grant, LinkSession, Message } from "@inboxlink/core";
import { newId, randomToken } from "@inboxlink/core";

/** Ephemeral store for v0 demos without Postgres. */
export class MemoryStore {
  readonly sessions = new Map<string, LinkSession & {
    oauthState?: string;
    publicToken?: string;
    grantId?: string;
    codeVerifier?: string;
  }>();
  readonly sessionsByToken = new Map<string, string>();
  readonly grants = new Map<string, Grant>();
  readonly publicTokens = new Map<string, string>();
  readonly messages = new Map<string, Message[]>();

  createSession(input: {
    tenantId: string;
    externalUserId: string;
    redirectUri: string;
    products: string[];
    ttlMs?: number;
  }) {
    const id = newId("ls");
    const linkToken = randomToken(24);
    const now = Date.now();
    const session: LinkSession & { oauthState?: string; publicToken?: string; grantId?: string } = {
      id,
      linkToken,
      tenantId: input.tenantId,
      externalUserId: input.externalUserId,
      redirectUri: input.redirectUri,
      products: input.products,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (input.ttlMs ?? 30 * 60_000)).toISOString(),
    };
    this.sessions.set(id, session);
    this.sessionsByToken.set(linkToken, id);
    return session;
  }

  getSessionByToken(linkToken: string) {
    const id = this.sessionsByToken.get(linkToken);
    return id ? this.sessions.get(id) : undefined;
  }

  getSession(id: string) {
    return this.sessions.get(id);
  }
}
