import {
  pgTable,
  text,
  timestamp,
  jsonb,
  customType,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/** bytea for encrypted vault payloads */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value);
  },
});

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  apiSecretHash: text("api_secret_hash").notNull(),
  webhookSecret: text("webhook_secret"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const linkSessions = pgTable(
  "link_sessions",
  {
    id: text("id").primaryKey(),
    linkToken: text("link_token").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    externalUserId: text("external_user_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    products: jsonb("products").$type<string[]>().notNull(),
    status: text("status").notNull(),
    oauthState: text("oauth_state"),
    codeVerifier: text("code_verifier"),
    publicToken: text("public_token"),
    grantId: text("grant_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("link_sessions_token_idx").on(t.linkToken),
    uniqueIndex("link_sessions_public_token_idx").on(t.publicToken),
    index("link_sessions_oauth_state_idx").on(t.oauthState),
  ],
);

export const grants = pgTable(
  "grants",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id),
    externalUserId: text("external_user_id").notNull(),
    provider: text("provider").notNull(),
    email: text("email").notNull(),
    status: text("status").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("grants_tenant_user_idx").on(t.tenantId, t.externalUserId),
  ],
);

export const tokenVault = pgTable("token_vault", {
  grantId: text("grant_id")
    .primaryKey()
    .references(() => grants.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  ciphertext: bytea("ciphertext").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncCursors = pgTable("sync_cursors", {
  grantId: text("grant_id")
    .primaryKey()
    .references(() => grants.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Gmail users.watch expiration (Wave D). */
  watchExpiration: timestamp("watch_expiration", { withTimezone: true }),
});

/** Durable sync job queue (Wave D2). MIT-only Postgres path — no Redis required. */
export const syncJobs = pgTable(
  "sync_jobs",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    forceBootstrap: text("force_bootstrap").notNull().default("0"),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("sync_jobs_status_created_idx").on(t.status, t.createdAt),
    index("sync_jobs_grant_idx").on(t.grantId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    threadId: text("thread_id"),
    subject: text("subject").notNull(),
    snippet: text("snippet").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_grant_provider_idx").on(t.grantId, t.providerMessageId),
  ],
);

/** SQL stub for operators who prefer raw migrate over drizzle-kit. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_secret_hash TEXT NOT NULL,
  webhook_secret TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS link_sessions (
  id TEXT PRIMARY KEY,
  link_token TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  products JSONB NOT NULL,
  status TEXT NOT NULL,
  oauth_state TEXT,
  code_verifier TEXT,
  public_token TEXT,
  grant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE link_sessions ADD COLUMN IF NOT EXISTS code_verifier TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS link_sessions_public_token_idx ON link_sessions (public_token);
CREATE INDEX IF NOT EXISTS link_sessions_oauth_state_idx ON link_sessions (oauth_state);

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  external_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  scopes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS grants_tenant_user_idx ON grants(tenant_id, external_user_id);

CREATE TABLE IF NOT EXISTS token_vault (
  grant_id TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_cursors (
  grant_id TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  watch_expiration TIMESTAMPTZ
);
ALTER TABLE sync_cursors ADD COLUMN IF NOT EXISTS watch_expiration TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  thread_id TEXT,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (grant_id, provider_message_id)
);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  force_bootstrap TEXT NOT NULL DEFAULT '0',
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sync_jobs_status_created_idx ON sync_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS sync_jobs_grant_idx ON sync_jobs (grant_id);
`;
