import type { Grant, LinkSession, Message, SyncCursor } from "@inboxlink/core";
import { newId, randomToken } from "@inboxlink/core";

export type StoredSession = LinkSession & {
  oauthState?: string;
  /** RFC 7636 code_verifier; set at Connect, used once on token exchange. */
  codeVerifier?: string;
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

/** Durable sync job row (Wave D2 — Postgres table or memory map). */
export type SyncJobStatus = "queued" | "running" | "completed" | "failed";

export type SyncJobKind = "bootstrap" | "incremental";

export type SyncJobRecord = {
  id: string;
  grantId: string;
  tenantId: string;
  kind: SyncJobKind;
  status: SyncJobStatus;
  forceBootstrap: boolean;
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type EnqueueSyncJobInput = {
  grantId: string;
  tenantId: string;
  kind: SyncJobKind;
  forceBootstrap?: boolean;
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
  /**
   * Atomically claim an OAuth `state` on first use: clear `oauthState` and
   * return the session (with `codeVerifier` still present for PKCE exchange).
   * A second claim with the same state returns undefined (closes replay).
   */
  consumeOAuthState(state: string): Promise<StoredSession | undefined>;
  saveSession(session: StoredSession): Promise<void>;
  putGrant(grant: Grant): Promise<void>;
  updateGrant(grant: Grant): Promise<void>;
  getGrant(id: string): Promise<Grant | undefined>;
  deleteGrant(id: string, tenantId: string): Promise<void>;
  listGrants(tenantId: string, externalUserId: string): Promise<Grant[]>;
  /** Active Gmail grants matching mailbox email (Pub/Sub push lookup). */
  findActiveGrantsByEmail(email: string): Promise<Grant[]>;
  /** All active Gmail grants (watch renewal sweep). */
  listActiveGmailGrants(): Promise<Grant[]>;
  /**
   * Consume a one-time public token only when the owning session belongs to
   * `tenantId`. Returns undefined when missing or cross-tenant.
   */
  consumePublicToken(publicToken: string, tenantId: string): Promise<string | undefined>;
  /** Delete `link_sessions` rows whose `expiresAt` is in the past. */
  deleteExpiredSessions(): Promise<number>;
  listMessages(grantId: string): Promise<Message[]>;
  upsertMessages(messages: Message[]): Promise<void>;
  deleteMessages(grantId: string): Promise<void>;
  deleteMessagesByProviderIds(grantId: string, providerMessageIds: string[]): Promise<void>;
  getSyncCursor(grantId: string): Promise<SyncCursor | undefined>;
  putSyncCursor(cursor: SyncCursor): Promise<void>;
  /** Wave D2 durable sync jobs. */
  enqueueSyncJob(input: EnqueueSyncJobInput): Promise<SyncJobRecord>;
  getSyncJob(jobId: string): Promise<SyncJobRecord | undefined>;
  /**
   * Atomically claim up to `limit` queued jobs (status → running).
   * Returns claimed rows ready for worker execution.
   */
  claimQueuedSyncJobs(limit: number): Promise<SyncJobRecord[]>;
  completeSyncJob(
    jobId: string,
    result: Record<string, unknown>,
  ): Promise<SyncJobRecord | undefined>;
  failSyncJob(jobId: string, error: string): Promise<SyncJobRecord | undefined>;
}

/** Ephemeral store for local demos and tests without Postgres. */
export class MemoryStore implements GrantStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly sessionsByToken = new Map<string, string>();
  readonly grants = new Map<string, Grant>();
  readonly publicTokens = new Map<string, string>();
  readonly messages = new Map<string, Message[]>();
  readonly syncCursors = new Map<string, SyncCursor>();
  readonly syncJobs = new Map<string, SyncJobRecord>();

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

  async consumeOAuthState(state: string): Promise<StoredSession | undefined> {
    for (const session of this.sessions.values()) {
      if (session.oauthState !== state) continue;
      if (Date.parse(session.expiresAt) <= Date.now()) return undefined;
      session.oauthState = undefined;
      return session;
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

  async findActiveGrantsByEmail(email: string): Promise<Grant[]> {
    const needle = email.trim().toLowerCase();
    return [...this.grants.values()].filter(
      (grant) =>
        grant.provider === "gmail" &&
        grant.status === "active" &&
        grant.email.toLowerCase() === needle,
    );
  }

  async listActiveGmailGrants(): Promise<Grant[]> {
    return [...this.grants.values()].filter(
      (grant) => grant.provider === "gmail" && grant.status === "active",
    );
  }

  async consumePublicToken(publicToken: string, tenantId: string): Promise<string | undefined> {
    const grantId = this.publicTokens.get(publicToken);
    if (!grantId) return undefined;
    const owner = [...this.sessions.values()].find((s) => s.publicToken === publicToken);
    if (!owner || owner.tenantId !== tenantId) return undefined;
    this.publicTokens.delete(publicToken);
    owner.publicToken = undefined;
    return grantId;
  }

  async deleteExpiredSessions(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) > now) continue;
      this.sessions.delete(id);
      this.sessionsByToken.delete(session.linkToken);
      if (session.publicToken) this.publicTokens.delete(session.publicToken);
      removed += 1;
    }
    return removed;
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
    const existing = this.syncCursors.get(cursor.grantId);
    this.syncCursors.set(cursor.grantId, {
      ...cursor,
      watchExpiration: cursor.watchExpiration ?? existing?.watchExpiration,
    });
  }

  async enqueueSyncJob(input: EnqueueSyncJobInput): Promise<SyncJobRecord> {
    const now = new Date().toISOString();
    const job: SyncJobRecord = {
      id: newId("sjob"),
      grantId: input.grantId,
      tenantId: input.tenantId,
      kind: input.kind,
      status: "queued",
      forceBootstrap: input.forceBootstrap === true,
      createdAt: now,
      updatedAt: now,
    };
    this.syncJobs.set(job.id, job);
    return job;
  }

  async getSyncJob(jobId: string): Promise<SyncJobRecord | undefined> {
    return this.syncJobs.get(jobId);
  }

  async claimQueuedSyncJobs(limit: number): Promise<SyncJobRecord[]> {
    const claimed: SyncJobRecord[] = [];
    const queued = [...this.syncJobs.values()]
      .filter((job) => job.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const now = new Date().toISOString();
    for (const job of queued) {
      if (claimed.length >= limit) break;
      job.status = "running";
      job.startedAt = now;
      job.updatedAt = now;
      claimed.push(job);
    }
    return claimed;
  }

  async completeSyncJob(
    jobId: string,
    result: Record<string, unknown>,
  ): Promise<SyncJobRecord | undefined> {
    const job = this.syncJobs.get(jobId);
    if (!job) return undefined;
    const now = new Date().toISOString();
    job.status = "completed";
    job.result = result;
    job.error = undefined;
    job.finishedAt = now;
    job.updatedAt = now;
    return job;
  }

  async failSyncJob(jobId: string, error: string): Promise<SyncJobRecord | undefined> {
    const job = this.syncJobs.get(jobId);
    if (!job) return undefined;
    const now = new Date().toISOString();
    job.status = "failed";
    job.error = error;
    job.finishedAt = now;
    job.updatedAt = now;
    return job;
  }
}
