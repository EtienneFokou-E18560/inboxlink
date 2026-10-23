import type { Grant, LinkSession, Message, SyncCursor } from "@inboxlink/core";
import { newId, randomToken } from "@inboxlink/core";

export type StoredSession = LinkSession & {
  oauthState?: string;
  /** RFC 7636 code_verifier; set at Connect, used once on token exchange. */
  codeVerifier?: string;
  publicToken?: string;
  grantId?: string;
  /**
   * The host's existing grant (same tenant and `externalUserId`) this Connect
   * replaces, when the host asked the person and they chose "replace".
   */
  replacesGrantId?: string;
};

export type CreateSessionInput = {
  tenantId: string;
  externalUserId: string;
  redirectUri: string;
  products: string[];
  replacesGrantId?: string;
  ttlMs?: number;
};

/** A grant in a tenant-wide listing, with the end of its last finished sync. */
export type TenantGrant = Grant & { lastSyncAt?: string };

export type TenantGrantPageQuery = {
  /** Keyset position: grants after this one in (`createdAt`, `id`) order. */
  after?: { createdAt: string; id: string };
  limit: number;
};

export type TenantGrantPage = { grants: TenantGrant[]; hasMore: boolean };

export type ReassignGrantInput = {
  id: string;
  tenantId: string;
  externalUserId: string;
  scopes: string[];
  updatedAt: string;
};

export type RetireGrantsInput = {
  ids: string[];
  tenantId: string;
  replacedBy: string;
  updatedAt: string;
  /** When set, only grants owned by this host user are retired. */
  externalUserId?: string;
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

export type MessagePageQuery = { offset: number; limit: number };

export type MessagePage = { messages: Message[]; hasMore: boolean };

/** Newest-first order shared by every store's `listMessagesPage`. */
export function compareMessagesNewestFirst(a: Message, b: Message): number {
  const ta = Date.parse(a.receivedAt) || 0;
  const tb = Date.parse(b.receivedAt) || 0;
  if (tb !== ta) return tb - ta;
  return a.providerMessageId.localeCompare(b.providerMessageId);
}

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
  /**
   * Write a grant's `status` and `updatedAt`. Never touches a `revoked` grant
   * (a retired grant stays retired, with its `replacedBy`): returns false when
   * the grant is missing, belongs to another tenant, or is already revoked.
   * With `expectUpdatedAt`, writes only while the stored grant still has that
   * `updatedAt`: a request that loaded the grant before a reconnect reused it
   * cannot mark the fresh grant with its stale failure.
   */
  updateGrant(grant: Grant, opts?: { expectUpdatedAt?: string }): Promise<boolean>;
  getGrant(id: string): Promise<Grant | undefined>;
  deleteGrant(id: string, tenantId: string): Promise<void>;
  listGrants(tenantId: string, externalUserId: string): Promise<Grant[]>;
  /**
   * Grants of one tenant for one mailbox that still count as connected
   * (`active` or `needs_reauth`), oldest first. Address match ignores case.
   */
  findLiveGrantsByAddress(tenantId: string, provider: Grant["provider"], email: string): Promise<Grant[]>;
  /**
   * Retire, in one conditional write, this tenant's grants for the same
   * provider and address that are still live (`active` or `needs_reauth`) and
   * were created before `grant` (by `createdAt`, then id as a tie-break): they
   * become `revoked` with `replacedBy = grant.id`. A newer grant is never
   * touched, so two Connects finishing at the same time cannot retire each
   * other. Returns only the grants this call retired, oldest first.
   */
  retireEarlierGrants(grant: Grant, updatedAt: string): Promise<Grant[]>;
  /**
   * Reuse a live grant for a fresh Connect of the same mailbox, in one
   * conditional write: it becomes `active`, owned by `externalUserId`, with the
   * new scopes. Returns undefined when the grant is missing, in another tenant
   * or no longer live (`revoked`). `previousExternalUserId` is the owner just
   * before this write.
   */
  reassignGrant(input: ReassignGrantInput): Promise<{ grant: Grant; previousExternalUserId: string } | undefined>;
  /**
   * Retire the listed grants that are still live in this tenant (and owned by
   * `externalUserId` when given): `revoked` with `replacedBy`. Never retires
   * `replacedBy` itself. Returns only the grants this call retired.
   */
  retireGrants(input: RetireGrantsInput): Promise<Grant[]>;
  /** Every grant of one tenant, oldest first, one keyset page at a time. */
  listTenantGrantsPage(tenantId: string, page: TenantGrantPageQuery): Promise<TenantGrantPage>;
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
  /**
   * Every cached message with its full payload (bodies included). Expensive on
   * Postgres: prefer `listMessageIds` or `listMessagesPage` on hot paths.
   */
  listMessages(grantId: string): Promise<Message[]>;
  /** Provider message ids of the cached messages only (no payloads). */
  listMessageIds(grantId: string): Promise<string[]>;
  /**
   * One page of the synced cache, newest first (`receivedAt` DESC, then
   * `providerMessageId` ASC). Reads at most `limit + 1` rows; `hasMore` is true
   * when at least one message exists after this page.
   */
  listMessagesPage(grantId: string, page: MessagePageQuery): Promise<MessagePage>;
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
      ...(input.replacesGrantId ? { replacesGrantId: input.replacesGrantId } : {}),
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

  async updateGrant(grant: Grant, opts: { expectUpdatedAt?: string } = {}): Promise<boolean> {
    const existing = this.grants.get(grant.id);
    if (!existing || existing.tenantId !== grant.tenantId) return false;
    if (existing.status === "revoked") return false;
    if (opts.expectUpdatedAt !== undefined && existing.updatedAt !== opts.expectUpdatedAt) return false;
    // Only status and timestamps move here (like the Postgres store): owner,
    // scopes and `replacedBy` are never written back from a caller's snapshot.
    this.grants.set(grant.id, { ...existing, status: grant.status, updatedAt: grant.updatedAt });
    return true;
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

  async findLiveGrantsByAddress(
    tenantId: string,
    provider: Grant["provider"],
    email: string,
  ): Promise<Grant[]> {
    const needle = email.trim().toLowerCase();
    return [...this.grants.values()]
      .filter(
        (grant) =>
          grant.tenantId === tenantId &&
          grant.provider === provider &&
          (grant.status === "active" || grant.status === "needs_reauth") &&
          grant.email.toLowerCase() === needle,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async retireEarlierGrants(grant: Grant, updatedAt: string): Promise<Grant[]> {
    const self = this.grants.get(grant.id);
    if (!self || self.tenantId !== grant.tenantId) return [];
    const retired: Grant[] = [];
    for (const old of await this.findLiveGrantsByAddress(grant.tenantId, grant.provider, grant.email)) {
      if (old.id === self.id || !createdBefore(old, self)) continue;
      const next: Grant = { ...old, status: "revoked", replacedBy: self.id, updatedAt };
      this.grants.set(old.id, next);
      retired.push(next);
    }
    return retired.sort(compareCreated);
  }

  async reassignGrant(
    input: ReassignGrantInput,
  ): Promise<{ grant: Grant; previousExternalUserId: string } | undefined> {
    const existing = this.grants.get(input.id);
    if (!existing || existing.tenantId !== input.tenantId || !isLive(existing)) return undefined;
    const next: Grant = {
      ...existing,
      externalUserId: input.externalUserId,
      status: "active",
      scopes: [...input.scopes],
      updatedAt: input.updatedAt,
    };
    delete next.replacedBy;
    this.grants.set(next.id, next);
    return { grant: next, previousExternalUserId: existing.externalUserId };
  }

  async retireGrants(input: RetireGrantsInput): Promise<Grant[]> {
    const retired: Grant[] = [];
    for (const id of new Set(input.ids)) {
      const old = this.grants.get(id);
      if (!old || id === input.replacedBy || old.tenantId !== input.tenantId || !isLive(old)) continue;
      if (input.externalUserId !== undefined && old.externalUserId !== input.externalUserId) continue;
      const next: Grant = { ...old, status: "revoked", replacedBy: input.replacedBy, updatedAt: input.updatedAt };
      this.grants.set(id, next);
      retired.push(next);
    }
    return retired.sort(compareCreated);
  }

  async listTenantGrantsPage(tenantId: string, page: TenantGrantPageQuery): Promise<TenantGrantPage> {
    const after = page.after;
    const sorted = [...this.grants.values()]
      .filter((g) => g.tenantId === tenantId)
      .filter((g) => !after || createdBefore(after, g))
      .sort(compareCreated);
    const slice = sorted.slice(0, page.limit);
    const grants = slice.map((g) => {
      const lastSyncAt = this.lastFinishedSync(g.id);
      return lastSyncAt ? { ...g, lastSyncAt } : { ...g };
    });
    return { grants, hasMore: sorted.length > page.limit };
  }

  private lastFinishedSync(grantId: string): string | undefined {
    let last: string | undefined;
    for (const job of this.syncJobs.values()) {
      if (job.grantId !== grantId || job.status !== "completed" || !job.finishedAt) continue;
      if (!last || job.finishedAt > last) last = job.finishedAt;
    }
    return last;
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

  async listMessageIds(grantId: string): Promise<string[]> {
    return (this.messages.get(grantId) ?? []).map((message) => message.providerMessageId);
  }

  async listMessagesPage(grantId: string, page: MessagePageQuery): Promise<MessagePage> {
    const sorted = [...(this.messages.get(grantId) ?? [])].sort(compareMessagesNewestFirst);
    const messages = sorted.slice(page.offset, page.offset + page.limit);
    return { messages, hasMore: page.offset + messages.length < sorted.length };
  }

  async upsertMessages(messages: Message[]): Promise<void> {
    for (const message of messages) {
      // Only an active grant caches mail: a sync still running when its grant
      // was retired must not refill the cache that retirement emptied.
      if (this.grants.get(message.grantId)?.status !== "active") continue;
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

/** Oldest first: `createdAt`, then id (the tie-break `retireEarlierGrants` uses). */
type CreatedKey = Pick<Grant, "createdAt" | "id">;

export function compareCreated(a: CreatedKey, b: CreatedKey): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `active` or `needs_reauth`: the grant still counts as connected. */
export function isLive(grant: Grant): boolean {
  return grant.status === "active" || grant.status === "needs_reauth";
}

function createdBefore(a: CreatedKey, b: CreatedKey): boolean {
  return compareCreated(a, b) < 0;
}
