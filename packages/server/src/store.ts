import type { Grant, LinkSession, Message, SyncCursor } from "@inboxlink/core";
import { newId, randomToken } from "@inboxlink/core";

export type StoredSession = LinkSession & {
  oauthState?: string;
  publicToken?: string;
  grantId?: string;
};

export type CreateSessionInput = {
  tenantId: string;
  externalUserId: string;
  redirectUri: string;
  products: string[];
  ttlMs?: number;
};

/**
 * Sessions, grants, and one-time public tokens.
 * Implementations must share state across processes when more than one
 * server instance can handle the OAuth callback.
 */
export interface GrantStore {
  ready(): Promise<void>;
  createSession(input: CreateSessionInput): Promise<StoredSession>;
  getSession(id: string): Promise<StoredSession | undefined>;
  getSessionByToken(linkToken: string): Promise<StoredSession | undefined>;
  findSessionByOAuthState(state: string): Promise<StoredSession | undefined>;
  saveSession(session: StoredSession): Promise<void>;
  putGrant(grant: Grant): Promise<void>;
  updateGrant(grant: Grant): Promise<void>;
  getGrant(id: string): Promise<Grant | undefined>;
  deleteGrant(id: string, tenantId: string): Promise<void>;
  listGrants(tenantId: string, externalUserId: string): Promise<Grant[]>;
  consumePublicToken(publicToken: string): Promise<string | undefined>;
  listMessages(grantId: string): Promise<Message[]>;
  upsertMessages(messages: Message[]): Promise<void>;
  deleteMessages(grantId: string): Promise<void>;
  deleteMessagesByProviderIds(grantId: string, providerMessageIds: string[]): Promise<void>;
  getSyncCursor(grantId: string): Promise<SyncCursor | undefined>;
  putSyncCursor(cursor: SyncCursor): Promise<void>;
}

/** Ephemeral store for local demos and tests without Postgres. */
export class MemoryStore implements GrantStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly sessionsByToken = new Map<string, string>();
  readonly grants = new Map<string, Grant>();
  readonly publicTokens = new Map<string, string>();
  readonly messages = new Map<string, Message[]>();
  readonly syncCursors = new Map<string, SyncCursor>();

  async ready(): Promise<void> {}

  async createSession(input: CreateSessionInput): Promise<StoredSession> {
    const id = newId("ls");
    const linkToken = randomToken(24);
    const now = Date.now();
    const session: StoredSession = {
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

  async getSessionByToken(linkToken: string): Promise<StoredSession | undefined> {
    const id = this.sessionsByToken.get(linkToken);
    return id ? this.sessions.get(id) : undefined;
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    return this.sessions.get(id);
  }

  async findSessionByOAuthState(state: string): Promise<StoredSession | undefined> {
    for (const session of this.sessions.values()) {
      if (session.oauthState === state) return session;
    }
    return undefined;
  }

  async saveSession(session: StoredSession): Promise<void> {
    const previous = this.sessions.get(session.id);
    if (previous?.publicToken && previous.publicToken !== session.publicToken) {
      this.publicTokens.delete(previous.publicToken);
    }
    this.sessions.set(session.id, session);
    this.sessionsByToken.set(session.linkToken, session.id);
    if (session.publicToken && session.grantId) {
      this.publicTokens.set(session.publicToken, session.grantId);
    }
  }

  async putGrant(grant: Grant): Promise<void> {
    this.grants.set(grant.id, grant);
  }

  async updateGrant(grant: Grant): Promise<void> {
    const existing = this.grants.get(grant.id);
    if (!existing || existing.tenantId !== grant.tenantId) return;
    this.grants.set(grant.id, grant);
  }

  async getGrant(id: string): Promise<Grant | undefined> {
    return this.grants.get(id);
  }

  async deleteGrant(id: string, tenantId: string): Promise<void> {
    const grant = this.grants.get(id);
    if (!grant || grant.tenantId !== tenantId) return;
    this.grants.delete(id);
  }

  async listGrants(tenantId: string, externalUserId: string): Promise<Grant[]> {
    return [...this.grants.values()].filter(
      (grant) => grant.tenantId === tenantId && grant.externalUserId === externalUserId,
    );
  }

  async consumePublicToken(publicToken: string): Promise<string | undefined> {
    const grantId = this.publicTokens.get(publicToken);
    if (!grantId) return undefined;
    this.publicTokens.delete(publicToken);
    for (const session of this.sessions.values()) {
      if (session.publicToken === publicToken) session.publicToken = undefined;
    }
    return grantId;
  }

  async listMessages(grantId: string): Promise<Message[]> {
    return this.messages.get(grantId) ?? [];
  }

  async upsertMessages(messages: Message[]): Promise<void> {
    for (const message of messages) {
      const existing = this.messages.get(message.grantId) ?? [];
      const index = existing.findIndex(
        (row) => row.providerMessageId === message.providerMessageId,
      );
      if (index >= 0) existing[index] = message;
      else existing.push(message);
      this.messages.set(message.grantId, existing);
    }
  }

  async deleteMessages(grantId: string): Promise<void> {
    this.messages.delete(grantId);
  }

  async deleteMessagesByProviderIds(grantId: string, providerMessageIds: string[]): Promise<void> {
    if (!providerMessageIds.length) return;
    const remove = new Set(providerMessageIds);
    const existing = this.messages.get(grantId) ?? [];
    this.messages.set(
      grantId,
      existing.filter((message) => !remove.has(message.providerMessageId)),
    );
  }

  async getSyncCursor(grantId: string): Promise<SyncCursor | undefined> {
    return this.syncCursors.get(grantId);
  }

  async putSyncCursor(cursor: SyncCursor): Promise<void> {
    this.syncCursors.set(cursor.grantId, cursor);
  }
}
