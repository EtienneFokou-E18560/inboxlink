import type {
  Grant,
  GrantStatus,
  Message,
  Provider,
  SyncCursor,
  SyncCursorKind,
  TokenVault,
} from "@inboxlink/core";
import { newId, openSecret, randomToken, sealSecret } from "@inboxlink/core";
import type { GrantStore, StoredSession } from "../store.js";
import { SCHEMA_SQL } from "./schema.js";
import type { SqlExecutor } from "./sql.js";

const TENANT_SQL = `
INSERT INTO tenants (id, name, api_secret_hash)
VALUES ('default', 'default', 'managed-by-env')
ON CONFLICT (id) DO NOTHING;
`;

export class PgDatabase {
  private ready: Promise<void> | null = null;

  constructor(readonly sql: SqlExecutor) {}

  ensure(): Promise<void> {
    this.ready ??= this.migrate()
      .then(async () => {
        await this.sql.query(`DELETE FROM link_sessions WHERE expires_at < NOW()`, []);
      })
      .catch((err) => {
        this.ready = null;
        throw err;
      });
    return this.ready;
  }

  private async migrate(): Promise<void> {
    for (const statement of sqlStatements(SCHEMA_SQL + TENANT_SQL)) {
      try {
        await this.sql.exec(statement);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/already exists/i.test(message)) throw err;
      }
    }
  }
}

type SessionRow = {
  id: string;
  link_token: string;
  tenant_id: string;
  external_user_id: string;
  redirect_uri: string;
  products: unknown;
  status: string;
  oauth_state: string | null;
  code_verifier: string | null;
  public_token: string | null;
  grant_id: string | null;
  created_at: Date | string;
  expires_at: Date | string;
};

type GrantRow = {
  id: string;
  tenant_id: string;
  external_user_id: string;
  provider: string;
  email: string;
  status: string;
  scopes: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

const SESSION_COLUMNS = `
  id, link_token, tenant_id, external_user_id, redirect_uri, products, status,
  oauth_state, code_verifier, public_token, grant_id, created_at, expires_at
`;

export class PostgresStore implements GrantStore {
  constructor(private readonly db: PgDatabase) {}

  ready(): Promise<void> {
    return this.db.ensure();
  }

  async createSession(input: {
    tenantId: string;
    externalUserId: string;
    redirectUri: string;
    products: string[];
    ttlMs?: number;
  }): Promise<StoredSession> {
    await this.db.ensure();
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
    await this.db.sql.query(
      `INSERT INTO link_sessions (
         id, link_token, tenant_id, external_user_id, redirect_uri, products, status, created_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        session.id,
        session.linkToken,
        session.tenantId,
        session.externalUserId,
        session.redirectUri,
        JSON.stringify(session.products),
        session.status,
        session.createdAt,
        session.expiresAt,
      ],
    );
    return session;
  }

  async getSession(id: string): Promise<StoredSession | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM link_sessions WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async getSessionByToken(linkToken: string): Promise<StoredSession | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM link_sessions WHERE link_token = $1`,
      [linkToken],
    );
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async findSessionByOAuthState(state: string): Promise<StoredSession | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM link_sessions WHERE oauth_state = $1`,
      [state],
    );
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async consumeOAuthState(state: string): Promise<StoredSession | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<SessionRow>(
      `UPDATE link_sessions SET oauth_state = NULL
       WHERE oauth_state = $1 AND expires_at > NOW()
       RETURNING ${SESSION_COLUMNS}`,
      [state],
    );
    return rows[0] ? mapSession(rows[0]) : undefined;
  }

  async saveSession(session: StoredSession): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(
      `UPDATE link_sessions SET
         status = $2,
         oauth_state = $3,
         code_verifier = $4,
         public_token = $5,
         grant_id = $6,
         redirect_uri = $7,
         products = $8::jsonb,
         expires_at = $9
       WHERE id = $1`,
      [
        session.id,
        session.status,
        session.oauthState ?? null,
        session.codeVerifier ?? null,
        session.publicToken ?? null,
        session.grantId ?? null,
        session.redirectUri,
        JSON.stringify(session.products),
        session.expiresAt,
      ],
    );
  }

  async updateGrant(grant: Grant): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(
      `UPDATE grants SET status = $2, updated_at = $3 WHERE id = $1 AND tenant_id = $4`,
      [grant.id, grant.status, grant.updatedAt, grant.tenantId],
    );
  }

  async putGrant(grant: Grant): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(
      `INSERT INTO grants (
         id, tenant_id, external_user_id, provider, email, status, scopes, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
      [
        grant.id,
        grant.tenantId,
        grant.externalUserId,
        grant.provider,
        grant.email,
        grant.status,
        JSON.stringify(grant.scopes),
        grant.createdAt,
        grant.updatedAt,
      ],
    );
  }

  async getGrant(id: string): Promise<Grant | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<GrantRow>(
      `SELECT id, tenant_id, external_user_id, provider, email, status, scopes, created_at, updated_at
       FROM grants WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapGrant(rows[0]) : undefined;
  }

  async deleteGrant(id: string, tenantId: string): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(`DELETE FROM grants WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  }

  async listGrants(tenantId: string, externalUserId: string): Promise<Grant[]> {
    await this.db.ensure();
    const rows = await this.db.sql.query<GrantRow>(
      `SELECT id, tenant_id, external_user_id, provider, email, status, scopes, created_at, updated_at
       FROM grants WHERE tenant_id = $1 AND external_user_id = $2
       ORDER BY created_at ASC`,
      [tenantId, externalUserId],
    );
    return rows.map(mapGrant);
  }

  async consumePublicToken(publicToken: string, tenantId: string): Promise<string | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<{ grant_id: string | null }>(
      `UPDATE link_sessions SET public_token = NULL
       WHERE public_token = $1 AND tenant_id = $2
       RETURNING grant_id`,
      [publicToken, tenantId],
    );
    return rows[0]?.grant_id ?? undefined;
  }

  async deleteExpiredSessions(): Promise<number> {
    await this.db.ensure();
    const rows = await this.db.sql.query<{ id: string }>(
      `DELETE FROM link_sessions WHERE expires_at < NOW() RETURNING id`,
      [],
    );
    return rows.length;
  }

  async listMessages(grantId: string): Promise<Message[]> {
    await this.db.ensure();
    const rows = await this.db.sql.query<{ payload: unknown }>(
      `SELECT payload FROM messages WHERE grant_id = $1 ORDER BY received_at ASC`,
      [grantId],
    );
    const messages: Message[] = [];
    for (const row of rows) {
      const message = asMessage(row.payload);
      if (message) messages.push(message);
    }
    return messages;
  }

  async upsertMessages(messages: Message[]): Promise<void> {
    if (!messages.length) return;
    await this.db.ensure();
    // Single multi-row upsert to cut Neon RTT vs one INSERT per message.
    const ids: string[] = [];
    const grantIds: string[] = [];
    const providerIds: string[] = [];
    const threadIds: Array<string | null> = [];
    const subjects: string[] = [];
    const snippets: string[] = [];
    const payloads: string[] = [];
    const receivedAts: string[] = [];
    for (const message of messages) {
      ids.push(message.id);
      grantIds.push(message.grantId);
      providerIds.push(message.providerMessageId);
      threadIds.push(message.threadId ?? null);
      subjects.push(message.subject);
      snippets.push(message.snippet);
      payloads.push(JSON.stringify(message));
      receivedAts.push(message.receivedAt);
    }
    await this.db.sql.query(
      `INSERT INTO messages (
         id, grant_id, provider_message_id, thread_id, subject, snippet, payload, received_at
       )
       SELECT * FROM UNNEST(
         $1::text[],
         $2::text[],
         $3::text[],
         $4::text[],
         $5::text[],
         $6::text[],
         $7::jsonb[],
         $8::timestamptz[]
       ) AS t(id, grant_id, provider_message_id, thread_id, subject, snippet, payload, received_at)
       ON CONFLICT (grant_id, provider_message_id) DO UPDATE SET
         id = EXCLUDED.id,
         thread_id = EXCLUDED.thread_id,
         subject = EXCLUDED.subject,
         snippet = EXCLUDED.snippet,
         payload = EXCLUDED.payload,
         received_at = EXCLUDED.received_at`,
      [ids, grantIds, providerIds, threadIds, subjects, snippets, payloads, receivedAts],
    );
  }

  async deleteMessages(grantId: string): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(`DELETE FROM messages WHERE grant_id = $1`, [grantId]);
  }

  async deleteMessagesByProviderIds(grantId: string, providerMessageIds: string[]): Promise<void> {
    if (!providerMessageIds.length) return;
    await this.db.ensure();
    await this.db.sql.query(
      `DELETE FROM messages WHERE grant_id = $1 AND provider_message_id = ANY($2::text[])`,
      [grantId, providerMessageIds],
    );
  }

  async getSyncCursor(grantId: string): Promise<SyncCursor | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<{
      grant_id: string;
      kind: string;
      value: string;
      updated_at: Date | string;
    }>(`SELECT grant_id, kind, value, updated_at FROM sync_cursors WHERE grant_id = $1`, [grantId]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      grantId: row.grant_id,
      kind: asSyncCursorKind(row.kind),
      value: row.value,
      updatedAt: asIso(row.updated_at),
    };
  }

  async putSyncCursor(cursor: SyncCursor): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(
      `INSERT INTO sync_cursors (grant_id, kind, value, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (grant_id) DO UPDATE SET
         kind = EXCLUDED.kind,
         value = EXCLUDED.value,
         updated_at = EXCLUDED.updated_at`,
      [cursor.grantId, cursor.kind, cursor.value, cursor.updatedAt],
    );
  }
}

export class PostgresTokenVault implements TokenVault {
  constructor(
    private readonly db: PgDatabase,
    private readonly masterKey: string,
  ) {
    if (!masterKey || masterKey.length < 16) {
      throw new Error("INBOXLINK_MASTER_KEY must be at least 16 characters");
    }
  }

  async seal(
    plaintext: string,
    context: { grantId: string; tenantId: string },
  ): Promise<Uint8Array> {
    await this.db.ensure();
    const ciphertext = sealSecret(this.masterKey, plaintext, aadFor(context));
    await this.db.sql.query(
      `INSERT INTO token_vault (grant_id, tenant_id, ciphertext, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (grant_id) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext,
             tenant_id = EXCLUDED.tenant_id,
             updated_at = NOW()`,
      [context.grantId, context.tenantId, ciphertext],
    );
    return ciphertext;
  }

  async open(
    ciphertext: Uint8Array,
    context: { grantId: string; tenantId: string },
  ): Promise<string> {
    return openSecret(this.masterKey, ciphertext, aadFor(context));
  }

  async destroy(grantId: string): Promise<void> {
    await this.db.ensure();
    await this.db.sql.query(`DELETE FROM token_vault WHERE grant_id = $1`, [grantId]);
  }

  async getCiphertext(grantId: string): Promise<Uint8Array | undefined> {
    await this.db.ensure();
    const rows = await this.db.sql.query<{ ciphertext: unknown }>(
      `SELECT ciphertext FROM token_vault WHERE grant_id = $1`,
      [grantId],
    );
    const raw = rows[0]?.ciphertext;
    return raw === undefined ? undefined : asBytes(raw);
  }
}

function sqlStatements(script: string): string[] {
  return script
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function aadFor(context: { grantId: string; tenantId: string }): string {
  return `${context.tenantId}\0${context.grantId}`;
}

function mapSession(row: SessionRow): StoredSession {
  const session: StoredSession = {
    id: row.id,
    linkToken: row.link_token,
    tenantId: row.tenant_id,
    externalUserId: row.external_user_id,
    redirectUri: row.redirect_uri,
    products: asStringArray(row.products),
    status: asSessionStatus(row.status),
    createdAt: asIso(row.created_at),
    expiresAt: asIso(row.expires_at),
  };
  if (row.oauth_state) session.oauthState = row.oauth_state;
  if (row.code_verifier) session.codeVerifier = row.code_verifier;
  if (row.public_token) session.publicToken = row.public_token;
  if (row.grant_id) session.grantId = row.grant_id;
  return session;
}

function mapGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    externalUserId: row.external_user_id,
    provider: asProvider(row.provider),
    email: row.email,
    status: asGrantStatus(row.status),
    scopes: asStringArray(row.scopes),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function asSessionStatus(value: string): StoredSession["status"] {
  if (value === "pending" || value === "completed" || value === "expired") return value;
  return "expired";
}

function asGrantStatus(value: string): GrantStatus {
  if (value === "active" || value === "needs_reauth" || value === "revoked") return value;
  return "revoked";
}

function asProvider(value: string): Provider {
  if (value === "gmail" || value === "microsoft" || value === "imap") return value;
  throw new Error("Unknown grant provider");
}

function asSyncCursorKind(value: string): SyncCursorKind {
  if (value === "gmail_history" || value === "graph_delta" || value === "imap_uid") return value;
  return "gmail_history";
}

function asStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => String(item));
}

function asIso(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    return new Uint8Array(Buffer.from(hex, "hex"));
  }
  throw new Error("Unexpected vault ciphertext");
}

function asMessage(payload: unknown): Message | undefined {
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (!parsed || typeof parsed !== "object" || !("id" in parsed) || !("grantId" in parsed)) {
    return undefined;
  }
  return parsed as Message;
}
